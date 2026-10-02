#!/usr/bin/env node
/**
 * target-resolve-test.mjs —— 验证执行层的目标复核（堵 TOCTOU），在真实 Chromium 里跑。
 *
 * 背景（来自外部评审的一条）：快照承诺"不可见元素不给 ref"，但那个承诺只在渲染快照那一刻成立。
 * 从快照到动作之间页面可以隐藏/替换/改写节点，而 `data-dsh-ref` 只是 DOM 属性，页面自己也能改。
 * 所以动作前必须复核：还在文档里吗？现在还可见吗？ref 的签名还对得上吗？
 *
 * 本测试把扩展里的 #region aria-snapshot 与 #region target-resolve 一起抽出来执行，
 * 覆盖：正常可点、快照后被隐藏、快照后被改内容、签名被页面删掉、节点被移除，以及
 * "重新抓快照后又可以了"（证明不是一刀切拒绝）。
 *
 *   node dev/target-resolve-test.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
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
].find((p) => p && existsSync(p));

const source = readFileSync(join(ROOT, 'extension', 'background.js'), 'utf8');
const grab = (name) => {
  const m = new RegExp(`// #region ${name}([\\s\\S]*?)// #endregion ${name}`).exec(source);
  if (!m) { console.error(`找不到 #region ${name}`); process.exit(1); }
  return m[1];
};
const snapshotRegion = grab('aria-snapshot');
const resolveRegion = grab('target-resolve');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const FIXTURE = `<!doctype html><html><body>
<main>
  <button id="del">删除</button>
  <button id="keep">保留</button>
  <button id="mut">改我</button>
  <button id="bye">移除我</button>
  <button id="nosig">签名被删</button>
</main>
<script>
  window.clicks = [];
  for (const b of document.querySelectorAll('button')) {
    b.addEventListener('click', () => window.clicks.push(b.id));
  }
</script>
</body></html>`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.setContent(FIXTURE, { waitUntil: 'load' });

  const base = `${snapshotRegion}\n${resolveRegion}`;
  const run = (body) => page.evaluate(`(() => { ${base}\n${body} })()`);

  // 先抓一次快照，让所有元素带上 ref + 签名
  const first = await run(`
    const snap = buildAriaSnapshot({ maxNodes: 200 });
    return { yaml: snap.yaml, sigs: [...document.querySelectorAll('button')].map((b) => [b.id, b.getAttribute('data-dsh-ref'), b.getAttribute('data-dsh-sig')]) };
  `);
  console.log('=== 快照给元素打的 ref / 签名 ===');
  for (const [id, ref, sig] of first.sigs) console.log(`  ${id.padEnd(8)} ${String(ref).padEnd(5)} ${sig}`);
  check('每个按钮都拿到了 ref', first.sigs.every(([, ref]) => /^e\d+$/.test(ref ?? '')), JSON.stringify(first.sigs));
  check('每个 ref 都带上了签名', first.sigs.every(([, , sig]) => Boolean(sig)), JSON.stringify(first.sigs));

  const refOfId = (id) => first.sigs.find(([x]) => x === id)[1];

  const outcomes = await run(`
    const out = {};
    const bySig = (id) => document.getElementById(id);

    // ① 正常路径：可见、签名匹配 → 应通过
    out.okCase = verifyTarget(bySig('keep'), '${refOfId('keep')}');

    // ② 快照后被隐藏 → 应拒绝
    bySig('del').style.display = 'none';
    out.hiddenCase = verifyTarget(bySig('del'), '${refOfId('del')}');

    // ③ 快照后内容被改写（签名不再匹配）→ 应拒绝
    bySig('mut').textContent = '我已经不是刚才那个按钮了';
    out.mutatedCase = verifyTarget(bySig('mut'), '${refOfId('mut')}');

    // ④ 页面把签名属性删掉 → fail closed
    bySig('nosig').removeAttribute('data-dsh-sig');
    out.noSigCase = verifyTarget(bySig('nosig'), '${refOfId('nosig')}');

    // ⑤ 节点被移除 → 应拒绝（先抓住引用，否则 getElementById 已经是 null，测不到 isConnected 分支）
    const byeEl = bySig('bye');
    byeEl.remove();
    out.removedCase = verifyTarget(byeEl, '${refOfId('bye')}');

    // ⑤b 传进来就是 null（选择器没解析到）
    out.nullCase = verifyTarget(null, null);

    // ⑥ 选择器目标（非 ref）：只查可见性，隐藏的仍要拒绝
    out.selectorHidden = verifyTarget(bySig('del'), null);

    return out;
  `);

  console.log('\n=== 复核结果 ===');
  for (const [k, v] of Object.entries(outcomes)) console.log(`  ${k.padEnd(16)} ok=${v.ok} ${v.reason ? `reason=${v.reason}` : ''}`);

  check('① 正常路径通过（正向对照）', outcomes.okCase?.ok === true, JSON.stringify(outcomes.okCase));
  check('② 快照后被隐藏 → 拒绝且说明原因', outcomes.hiddenCase?.ok === false && /不可见/.test(outcomes.hiddenCase.reason ?? ''), JSON.stringify(outcomes.hiddenCase));
  check('③ 快照后被改写 → 拒绝（签名比对）', outcomes.mutatedCase?.ok === false && /已经变了/.test(outcomes.mutatedCase.reason ?? ''), JSON.stringify(outcomes.mutatedCase));
  check('④ 签名被删 → fail closed（不是放行）', outcomes.noSigCase?.ok === false && /签名/.test(outcomes.noSigCase.reason ?? ''), JSON.stringify(outcomes.noSigCase));
  check('⑤ 节点被移除 → 拒绝（isConnected 分支）', outcomes.removedCase?.ok === false && /移除/.test(outcomes.removedCase.reason ?? ''), JSON.stringify(outcomes.removedCase));
  check('⑤b null 目标 → 明确失败', outcomes.nullCase?.ok === false, JSON.stringify(outcomes.nullCase));
  check('⑥ 选择器目标也走可见性复核', outcomes.selectorHidden?.ok === false, JSON.stringify(outcomes.selectorHidden));

  // 正向恢复：隐藏的按钮重新可见 + 重新快照后，应恢复可操作
  const recovered = await run(`
    document.getElementById('del').style.display = '';
    buildAriaSnapshot({ maxNodes: 200 });
    return { guard: verifyTarget(document.getElementById('del'), document.getElementById('del').getAttribute('data-dsh-ref')) };
  `);
  check('⑦ 重新可见并重新快照后恢复可操作（不是一刀切）', recovered.guard?.ok === true, JSON.stringify(recovered.guard));
} finally {
  await browser.close().catch(() => {});
}

console.log(`\n${failures ? `✗ ${failures} 个断言失败` : '✓ 全部通过'}`);
process.exit(failures ? 1 : 0);
