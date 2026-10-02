/** Resolve the bundled DSH Playwright runtime, or a project-local CI install. */
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop');

const candidates = [PROFILE_DIR, PROJECT];
let loadError = null;
let chromium = null;
for (const root of candidates) {
  try {
    const require = createRequire(pathToFileURL(`${root}/`).href);
    const runtime = require('playwright-core');
    if (runtime?.chromium) {
      chromium = runtime.chromium;
      break;
    }
  } catch (error) {
    loadError = error;
  }
}

if (!chromium) {
  throw new Error(`找不到 playwright-core：请设置 DSH_PROFILE_DIR，或在项目根目录安装它（${loadError?.message ?? 'unknown error'}）`);
}

export { chromium };
