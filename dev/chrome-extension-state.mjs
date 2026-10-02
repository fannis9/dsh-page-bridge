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
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_ID = 'hoiepnbhhkgaakggccoppmknbalamojh';
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
