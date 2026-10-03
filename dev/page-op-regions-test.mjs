#!/usr/bin/env node
/**
 * Structural guard for PAGE_OP's region-based source layout.
 *
 * This intentionally runs without a browser: every extracted region must be balanced,
 * compile as an independent function body, and remain in the canonical dependency order.
 * It is the first test to update before moving PAGE_OP code between files.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'extension', 'background.js'), 'utf8');
const fragments = join(ROOT, 'extension', 'page-op');
const marker = /\/\/ #region ([A-Za-z0-9_-]+)|\/\/ #endregion ([A-Za-z0-9_-]+)/g;
const stack = [];
const regions = [];
let match;
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failures += 1;
};

while ((match = marker.exec(source))) {
  const open = match[1];
  const close = match[2];
  if (open) {
    stack.push({ name: open, start: marker.lastIndex });
  } else if (!stack.length || stack.at(-1).name !== close) {
    check(`区块 ${close ?? '(空)'} 正确闭合`, false, `marker offset ${match.index}`);
  } else {
    const item = stack.pop();
    regions.push({ name: item.name, body: source.slice(item.start, match.index) });
  }
}

check('所有 PAGE_OP region 成对闭合', stack.length === 0 && failures === 0,
  stack.map((item) => item.name).join(', '));

const expected = ['aria-snapshot', 'target-resolve', 'page-read', 'key-dispatch'];
const names = regions.map((region) => region.name);
check('region 名称没有重复且顺序保持依赖关系',
  names.length === new Set(names).size && expected.every((name, i) => names.indexOf(name) === i),
  names.join(' → '));

for (const region of regions) {
  try {
    // The body is deliberately evaluated alone.  Definitions may refer to DOM symbols
    // only when called later, which is exactly how PAGE_OP injects them.
    new Function('document', 'getComputedStyle', 'Node', 'k', region.body)({}, () => ({}), {}, '__none__'); // eslint-disable-line no-new-func
    check(`${region.name} 片段可独立求值`, true);
  } catch (error) {
    check(`${region.name} 片段可独立求值`, false, String(error?.message ?? error));
  }
}

for (const name of expected) {
  const file = join(fragments, `${name}.js`);
  const pattern = new RegExp(`// #region ${name}([\\s\\S]*?)// #endregion ${name}`);
  const match = pattern.exec(source);
  check(`${name} fragment 存在且与注入体一致`, existsSync(file) && match
    && readFileSync(file, 'utf8') === match[1], file);
}

console.log(`\n${failures ? `✗ ${failures} 个失败` : '✓ PAGE_OP region 护栏通过'}`);
process.exit(failures ? 1 : 0);
