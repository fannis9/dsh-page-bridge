#!/usr/bin/env node
/**
 * key-dispatch-test.mjs — 验证合成按键带上了 keyCode/which（在真实 Chromium 里）。
 *
 * 背景：只带 `key` 的 KeyboardEvent，其 keyCode 是 0。而 React / 设计系统（GitHub 的 Primer
 * 就是这样）常常分支判断 `event.keyCode`，于是"按回车提交 token"会静默失效。
 * 本测试把扩展里的 #region key-dispatch 抽出来，在一个模拟 Primer 行为的页面上跑，
 * 并保留一个**反例**：用旧写法（只带 key）派发回车，应当无法提交。
 *
 *   node dev/key-dispatch-test.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop');
const require = createRequire(pathToFileURL(`${PROFILE_DIR}/`).href);
const { chromium } = require('playwright-core');

const CHROME = [
  process.env.DSH_BROWSER_EXECUTABLE,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => p && require('node:fs').existsSync(p));

const source = readFileSync(join(ROOT, 'extension', 'background.js'), 'utf8');
const region = /\/\/ #region key-dispatch([\s\S]*?)\/\/ #endregion key-dispatch/.exec(source);
if (!region) {
  console.error('在后端脚本里找不到 #region key-dispatch 区块');
  process.exit(1);
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const FIXTURE = `<!doctype html><html><body>
<input id="token" placeholder="Add topics"><div id="chips"></div>
<script>
  var log = [];
  var input = document.getElementById('token');
  var chips = document.getElementById('chips');
  // 模仿 Primer：只认 keyCode === 13
  input.addEventListener('keydown', function (e) {
    log.push({ type: 'keydown', key: e.key, keyCode: e.keyCode, which: e.which, code: e.code });
    if (e.keyCode === 13) {
      var s = document.createElement('span');
      s.textContent = input.value || '(empty)';
      chips.appendChild(s);
      input.value = '';
    }
  });
  input.addEventListener('keyup', function (e) {
    log.push({ type: 'keyup', key: e.key, keyCode: e.keyCode, which: e.which });
  });
  window.__log = log;
</script>
</body></html>`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(FIXTURE, { waitUntil: 'load' });

  const result = await page.evaluate(`(() => {
    ${region[1]}
    const input = document.getElementById('token');
    const chipCount = () => document.getElementById('chips').children.length;

    const before = chipCount();

    // 1) 新写法：pressKey 带 keyCode
    input.value = 'mcp';
    const enter = pressKey(input, 'Enter');
    const afterEnter = chipCount();

    // 2) 反例：旧写法（只有 key，没有 keyCode）——应当提交不了
    input.value = 'legacy';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const afterLegacy = chipCount();

    // 3) 其它按键
    const down = pressKey(input, 'ArrowDown');
    const back = pressKey(input, 'Backspace');
    const letter = pressKey(input, 'a');
    input.value = 'x';
    pressKey(input, 'Enter', 3);
    const afterRepeat = chipCount();
    const unknown = pressKey(input, 'NoSuchKey');

    return { before, afterEnter, afterLegacy, afterRepeat, enter, down, back, letter, unknown, log: window.__log.slice(0, 8) };
  })()`);

  console.log('=== 结果 ===');
  console.log(JSON.stringify({
    chips: { before: result.before, afterEnter: result.afterEnter, afterLegacy: result.afterLegacy, afterRepeat: result.afterRepeat },
    enter: result.enter, arrowDown: result.down, backspace: result.back, letter: result.letter, unknown: result.unknown,
  }, null, 2));
  console.log('=== 记录到的前几次事件 ===');
  for (const e of result.log) console.log(`  ${e.type.padEnd(8)} key=${String(e.key).padEnd(10)} keyCode=${String(e.keyCode).padEnd(4)} which=${String(e.which).padEnd(4)} code=${e.code}`);

  console.log('');
  check('合成回车能提交（keyCode 被识别）', result.afterEnter === result.before + 1, `${result.before} → ${result.afterEnter}`);
  check('反例：只带 key 的旧写法提交不了（证明本测试有效）', result.afterLegacy === result.afterEnter, `${result.afterEnter} → ${result.afterLegacy}`);
  check('Enter 的 keyCode/which = 13', result.enter?.keyCode === 13 && result.enter?.key === 'Enter', JSON.stringify(result.enter));
  check('ArrowDown 的 keyCode = 40', result.down?.keyCode === 40, JSON.stringify(result.down));
  check('Backspace 的 keyCode = 8', result.back?.keyCode === 8, JSON.stringify(result.back));
  check('单个字符 a → keyCode 65 / key "a"', result.letter?.keyCode === 65 && result.letter?.key === 'a', JSON.stringify(result.letter));
  check('repeat=3 连续提交三次', result.afterRepeat >= result.afterEnter + 3, `${result.afterEnter} → ${result.afterRepeat}`);
  check('不认识的键名返回失败而不是静默', result.unknown?.ok === false, JSON.stringify(result.unknown));
  check('事件是 bubbles 的（keydown 记录到了 keyCode）', result.log?.[0]?.keyCode === 13, JSON.stringify(result.log?.[0]));
} finally {
  await browser.close().catch(() => {});
}

console.log(`\n${failures ? `✗ ${failures} 个断言失败` : '✓ 全部通过'}`);
process.exit(failures ? 1 : 0);
