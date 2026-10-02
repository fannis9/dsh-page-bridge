#!/usr/bin/env node
/**
 * chrome-extension-state.mjs — read what Chrome itself thinks of the unpacked extension.
 *
 * Chrome keeps extension state in the profile's Preferences files, which answers the
 * questions you cannot ask from outside: is it enabled? which version is loaded? which
 * path? was it disabled for a permission increase?
 *
 *   node dev/chrome-extension-state.mjs [--extension-id <id>] [--profile <dir>]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 未打包扩展的 ID 完全由绝对路径决定（Chromium 算法，Windows 上用 UTF-16LE 编码路径）：
 *   id = mapToAtoP( hex( SHA256( pathBytes )[0..15] ) )
 * 所以这里直接算出来，不必把某个人的 ID 写死在仓库里。
 */
function idForPath(rawPath) {
  const normalized = process.platform === 'win32' ? rawPath.replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`) : rawPath;
  const bytes = process.platform === 'win32' ? Buffer.from(normalized, 'utf16le') : Buffer.from(normalized, 'utf8');
  return [...createHash('sha256').update(bytes).digest().subarray(0, 16).toString('hex')]
    .map((nibble) => String.fromCharCode(97 + parseInt(nibble, 16)))
    .join('');
}

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_ID = idForPath(join(PROJECT, 'extension'));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const id = String(flag('extension-id', DEFAULT_ID));
const defaultProfile = join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const profileRoot = String(flag('profile', defaultProfile));
const profileName = String(flag('profile-name', 'Default'));
const dir = join(profileRoot, profileName);

console.log(`扩展 ID : ${id}`);
console.log(`profile : ${dir}\n`);

if (!existsSync(dir)) {
  console.error('找不到 profile 目录');
  process.exit(1);
}

let found = false;
for (const file of ['Secure Preferences', 'Preferences']) {
  const path = join(dir, file);
  if (!existsSync(path)) {
    console.log(`--- ${file}：不存在 ---`);
    continue;
  }
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.log(`--- ${file}：解析失败（${error.message}）---`);
    continue;
  }
  const settings = data?.extensions?.settings?.[id];
  console.log(`--- ${file} ---`);
  if (!settings) {
    console.log('  没有该扩展的记录');
    continue;
  }
  found = true;
  const state = settings.state;
  console.log(`  state          : ${state} ${state === 1 ? '(启用)' : state === 0 ? '(已禁用!)' : '(未知)'}`);
  console.log(`  location       : ${settings.location} (4 = 已解压/unpacked)`);
  console.log(`  path           : ${settings.path}`);
  console.log(`  manifest 版本  : ${settings.manifest?.version}`);
  console.log(`  permissions    : ${JSON.stringify(settings.manifest?.permissions ?? [])}`);
  console.log(`  disable_reasons: ${JSON.stringify(settings.disable_reasons ?? [])}`);
  const api = settings.active_permissions?.api;
  if (api) console.log(`  active api     : ${JSON.stringify(api)}`);
  const withheld = settings.withholding_permissions;
  if (withheld) console.log(`  withholding    : ${JSON.stringify(withheld)}`);
}

if (!found) {
  console.log('\n⚠️ 两个配置文件里都没有该扩展：可能装在别的 profile（用 --profile-name 指定），或已被移除。');
}
console.log('\n提示：state=0 或 disable_reasons 非空表示 Chrome 因权限变更禁用了它，需要在 chrome://extensions 上重新启用。');
