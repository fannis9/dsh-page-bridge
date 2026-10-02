#!/usr/bin/env node
/**
 * chrome-storage-scan.mjs — peek at an unpacked extension's chrome.storage values.
 *
 * Chrome persists storage.local / storage.session in a LevelDB directory. We only need to
 * answer "is the master switch on, which transport is selected, is a tab shared", so a
 * plain byte scan for the known keys plus their surrounding JSON is enough — no LevelDB
 * parsing and no dependencies.
 *
 *   node dev/chrome-storage-scan.mjs [--extension-id <id>]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_ID = 'hoiepnbhhkgaakggccoppmknbalamojh';
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const id = String(flag('extension-id', DEFAULT_ID));
const dir = join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Local Extension Settings', id);

console.log(`扩展 ID : ${id}`);
console.log(`存储目录: ${dir}\n`);
if (!existsSync(dir)) {
  console.error('目录不存在：该扩展没有写过 storage，或用的不是 Default profile');
  process.exit(1);
}

const KEYS = ['enabled', 'transport', 'allowDomains', 'blockDomains', 'grant'];
const files = readdirSync(dir).filter((f) => /\.(log|ldb)$/i.test(f));
console.log(`文件: ${files.map((f) => `${f}(${statSync(join(dir, f)).size}B)`).join(', ')}\n`);

const all = files.map((f) => readFileSync(join(dir, f))).reduce((acc, buf) => Buffer.concat([acc, buf]), Buffer.alloc(0));
const text = all.toString('latin1');

for (const key of KEYS) {
  const hits = [];
  let index = text.indexOf(key);
  while (index >= 0 && hits.length < 4) {
    // LevelDB 里 key 与 value 相邻，取一小段上下文，把不可打印字符换成 ·
    const raw = all.subarray(Math.max(0, index - 8), Math.min(all.length, index + 220));
    hits.push(raw.toString('utf8').replace(/[^\x20-\x7e\u4e00-\u9fff]+/g, '·'));
    index = text.indexOf(key, index + key.length);
  }
  console.log(hits.length ? `【${key}】命中 ${hits.length} 处:` : `【${key}】未命中（说明默认值生效中）`);
  for (const h of hits) console.log(`   …${h}…`);
  console.log('');
}

console.log('解读：enabled 附近出现 ·false· 表示总开关被关了（扩展不会连接任何传输）。');
