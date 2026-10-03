#!/usr/bin/env node
/**
 * docs-parity-test.mjs —— 中英双版文档的一致性护栏（进必跑 CI）。
 *
 * 为什么需要它：文档一旦有中英两份，"只改一版、另一版悄悄过期"几乎是必然发生的。
 * 这里做的是**机械比对**，只看那些不该被翻译动到的东西：
 *   1. 围栏代码块必须**逐字节相同**（顺序也相同）
 *   2. 纯 ASCII 行内代码必须集合相同（源里用反引号包的中文词在译文里会消失，故只比 ASCII）
 *   3. `##` 小节数、表格行数、链接目标必须一致
 *   4. 两份文件首行必须互相链接
 *   5. 译文不得带 BOM
 *
 * 检查"成对存在"的文件；某份文档暂时没有译文就跳过（不强制所有文档都双语）。
 *   node dev/docs-parity-test.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** [中文文件, 英文文件] —— 新增双语文档时在这里登记。 */
const PAIRS = [
  ['README.md', 'README.en.md'],
  [join('docs', 'external-review.md'), join('docs', 'external-review.en.md')],
];

/**
 * 允许英文版多出的行内代码：源文件里这些反引号内是**中文占位词**（如 `--token <值>`），
 * 译文把占位词译掉是对的（命令与参数不能动），故在此登记而不是放宽整条规则。
 */
const ACCEPTED_EN_ONLY = new Set([
  '--token <value>',
  '--token-file <path>',
  'key Enter [selector]',
  '(browser, tab)',
  'chrome@<instance prefix>',
  '--extension-id <that ID>',
  'node <absolute path of that directory>/mcp-server.mjs',
]);

const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const fences = (text) => [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
const asciiSpans = (text) => {
  const set = new Set();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const value = m[1].trim();
    if (/^[\x20-\x7e]+$/.test(value)) set.add(value);
  }
  return set;
};
const count = (text, re) => (text.match(re) ?? []).length;
const linkTargets = (text) => [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).sort();

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failures += 1;
};

for (const [zhPath, enPath] of PAIRS) {
  if (!existsSync(join(ROOT, zhPath)) || !existsSync(join(ROOT, enPath))) {
    const missing = existsSync(join(ROOT, zhPath)) ? enPath : zhPath;
    console.log(`- 跳过 ${zhPath} / ${enPath}（缺少 ${missing}）`);
    continue;
  }
  console.log(`\n[${zhPath} ↔ ${enPath}]`);
  const zh = read(zhPath);
  const en = read(enPath);

  const zhFences = fences(zh);
  const enFences = fences(en);
  check(`  代码块数量相同（中 ${zhFences.length} / 英 ${enFences.length}）`, zhFences.length === enFences.length);
  const differing = [];
  for (let i = 0; i < Math.min(zhFences.length, enFences.length); i += 1) {
    if (zhFences[i] !== enFences[i]) differing.push(i + 1);
  }
  check(`  代码块逐字节相同（不同：${differing.join(', ') || '无'}）`, differing.length === 0);

  const zhSpans = asciiSpans(zh);
  const enSpans = asciiSpans(en);
  const missing = [...zhSpans].filter((v) => !enSpans.has(v));
  const extra = [...enSpans].filter((v) => !zhSpans.has(v) && !ACCEPTED_EN_ONLY.has(v));
  check(`  ASCII 行内代码没漏（缺 ${missing.length}：${missing.slice(0, 8).join(' | ') || '无'}）`, missing.length === 0);
  check(`  ASCII 行内代码没多编（多 ${extra.length}：${extra.slice(0, 8).join(' | ') || '无'}）`, extra.length === 0);

  const zhH = count(zh, /^## /gm);
  const enH = count(en, /^## /gm);
  check(`  ## 小节数一致（中 ${zhH} / 英 ${enH}）`, zhH === enH);
  const zhRows = count(zh, /^\|/gm);
  const enRows = count(en, /^\|/gm);
  check(`  表格行数一致（中 ${zhRows} / 英 ${enRows}）`, zhRows === enRows);

  // 逐行比较表格"列结构"：每一行的竖线数量序列必须相同 —— 抓"译文多一列/少一列"。
  const rowShape = (text) => (text.match(/^\|.*$/gm) ?? []).map((line) => (line.match(/\|/g) ?? []).length);
  const zhShape = rowShape(zh);
  const enShape = rowShape(en);
  const shapeDiffs = zhShape
    .map((v, i) => (v === enShape[i] ? null : `第 ${i + 1} 行 中 ${v} 竖线 / 英 ${enShape[i] ?? '-'}`))
    .filter(Boolean);
  check(`  表格列结构一致（中 ${zhShape.length} 行）`, zhShape.length === enShape.length && shapeDiffs.length === 0, shapeDiffs.slice(0, 4).join(' | '));

  // 只排除"指向对方那一份"的语言切换链接；兄弟目录下写的是裸文件名，所以要连 basename 一起排除。
  const zhBase = zhPath.split(/[\\/]/).pop();
  const enBase = enPath.split(/[\\/]/).pop();
  const switcherOfZh = new Set([enPath, enPath.replaceAll('\\', '/'), enBase]);
  const switcherOfEn = new Set([zhPath, zhPath.replaceAll('\\', '/'), zhBase]);
  const zhLinks = linkTargets(zh).filter((v) => !switcherOfZh.has(v));
  const enLinks = linkTargets(en).filter((v) => !switcherOfEn.has(v));
  const zhOnly = zhLinks.filter((v) => !enLinks.includes(v));
  const enOnly = enLinks.filter((v) => !zhLinks.includes(v));
  check(`  链接目标一致（中独有：${zhOnly.join(', ') || '无'} / 英独有：${enOnly.join(', ') || '无'}）`, zhOnly.length === 0 && enOnly.length === 0);

  check('  两份首行互相链接', zh.split('\n')[0].includes(enBase) && en.split('\n')[0].includes(zhBase),
    `中首行: ${zh.split('\n')[0]} / 英首行: ${en.split('\n')[0]}`);

  const raw = readFileSync(join(ROOT, enPath));
  check('  译文无 BOM', !(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf));
}

console.log(`\n${failures ? `✗ ${failures} 项不一致` : '✓ 中英双版文档一致性检查通过'}`);
process.exit(failures ? 1 : 0);
