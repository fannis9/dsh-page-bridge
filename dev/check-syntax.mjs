#!/usr/bin/env node
/**
 * check-syntax.mjs —— 与 CI 完全一致的语法检查（单一事实来源）。
 *
 * 起因：CI 用的是 `git ls-files '*.mjs' '*.js' | node --check`，而本地 `npm run check` 只列了 8 个入口。
 * 两者一旦不同步，就会出现"本地全绿、CI 一进来就红"——本轮 `extension/page-op/*.js` 片段正是这么翻的车。
 *
 * 规则：
 *   - 扫描仓库内所有 .mjs / .js（跳过 .git / node_modules / var）
 *   - **排除 extension/page-op/**：那些是 PAGE_OP 的函数体片段（顶层 return），不是独立模块；
 *     它们由 dev/page-op-regions-test.mjs 用 new Function 独立求值来验证
 *
 *   node dev/check-syntax.mjs
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'var']);
/** 函数体片段目录：不参与模块级语法检查（由 region 护栏覆盖）。 */
const SKIP_PREFIX = `extension${sep}page-op${sep}`;

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      continue;
    }
    if (!/\.(mjs|js)$/.test(entry.name)) continue;
    const rel = relative(ROOT, join(dir, entry.name));
    if (rel.startsWith(SKIP_PREFIX)) continue;
    files.push(rel);
  }
};
walk(ROOT);
files.sort();

const failures = [];
for (const file of files) {
  // stdio: 'ignore' —— 只要退出码，不抓输出（也避开受限沙箱里"管道 stdio 不可用"的限制）。
  const result = spawnSync(process.execPath, ['--check', join(ROOT, file)], { stdio: 'ignore' });
  if (result.status !== 0) failures.push(file);
}

console.log(`语法检查：扫描 ${files.length} 个模块文件（已排除 extension/page-op/ 片段）`);
if (failures.length) {
  for (const file of failures) console.log(`  ✗ ${file}`);
  console.log(`\n✗ ${failures.length} 个文件语法检查失败`);
  process.exit(1);
}
console.log('✓ 全部通过');
// 顺带确认"排除"是有依据的：片段文件应当确实不是独立模块（否则排除就是掩盖问题）。
const fragDir = join(ROOT, 'extension', 'page-op');
let fragments = [];
try { fragments = readdirSync(fragDir).filter((f) => f.endsWith('.js')); } catch { /* 目录不存在 */ }
const moduleLike = fragments.filter((f) => spawnSync(process.execPath, ['--check', join(fragDir, f)], { stdio: 'ignore' }).status === 0);
console.log(`（page-op 片段 ${fragments.length} 个，其中能当独立模块解析的 ${moduleLike.length} 个：${moduleLike.join(', ') || '无'}）`);
