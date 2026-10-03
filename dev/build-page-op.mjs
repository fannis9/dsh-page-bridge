#!/usr/bin/env node
/** Keep PAGE_OP's marked regions in extension/page-op and compose them into background.js. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKGROUND = join(ROOT, 'extension', 'background.js');
const FRAGMENTS = join(ROOT, 'extension', 'page-op');
const ORDER = ['aria-snapshot', 'target-resolve', 'page-read', 'key-dispatch', 'actions'];
const bootstrap = process.argv.includes('--bootstrap');

let source = readFileSync(BACKGROUND, 'utf8');
mkdirSync(FRAGMENTS, { recursive: true });
for (const name of ORDER) {
  const pattern = new RegExp(`(// #region ${name})([\\s\\S]*?)(// #endregion ${name})`);
  const match = pattern.exec(source);
  if (!match) throw new Error(`background.js 缺少 region: ${name}`);
  const file = join(FRAGMENTS, `${name}.js`);
  if (!existsSync(file)) {
    if (!bootstrap) throw new Error(`缺少 PAGE_OP fragment: ${file}（首次运行请加 --bootstrap）`);
    writeFileSync(file, match[2], 'utf8');
  }
  const body = readFileSync(file, 'utf8');
  source = source.replace(pattern, `$1${body}$3`);
}
writeFileSync(BACKGROUND, source, 'utf8');
console.log(`PAGE_OP fragments composed: ${ORDER.join(' → ')}`);
