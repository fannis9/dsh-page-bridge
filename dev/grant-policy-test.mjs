#!/usr/bin/env node
/**
 * grant-policy-test.mjs — unit-test the extension's permission policy in plain Node.
 *
 * The policy lives in extension/policy.js inside the `#region grant-policy` block and
 * is deliberately dependency-free, so it can be extracted (single source of truth) and
 * tested without a browser. Mirrors dev/snapshot-probe.mjs.
 *
 *   node dev/grant-policy-test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, '..', 'extension', 'policy.js'), 'utf8');
const region = /\/\/ #region grant-policy([\s\S]*?)\/\/ #endregion grant-policy/.exec(source);
if (!region) {
  console.error('找不到 #region grant-policy 区块');
  process.exit(1);
}
const POLICY = new Function(`${region[1]}\nreturn DSH_POLICY;`)();

let failures = 0;
let checks = 0;
const check = (label, actual, expected) => {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures += 1;
    console.log(`✗ ${label}\n    期望 ${e}\n    实际 ${a}`);
  } else {
    console.log(`✓ ${label}`);
  }
};

console.log('--- normalizePattern ---');
check('去协议/路径/尾斜杠', POLICY.normalizePattern('HTTPS://Example.com/path/?q=1'), 'example.com');
check('保留 *. 前缀', POLICY.normalizePattern('*.Example.com'), '*.example.com');
check('去前导点', POLICY.normalizePattern('.example.com'), 'example.com');

console.log('\n--- matches ---');
check('同域匹配', POLICY.matches('example.com', 'example.com'), true);
check('子域匹配', POLICY.matches('a.b.example.com', 'example.com'), true);
check('不同域不匹配', POLICY.matches('notexample.com', 'example.com'), false);
check('后缀伪装不匹配', POLICY.matches('example.com.evil.com', 'example.com'), false);
check('*. 匹配子域', POLICY.matches('a.example.com', '*.example.com'), true);
check('*. 也匹配裸域（与常见约定一致）', POLICY.matches('example.com', '*.example.com'), true);

console.log('\n--- isDomainAllowed ---');
const allow = ['github.com', '*.deepseek.com'];
const block = ['bank.com', 'mail.example.com'];
check('无名单 → 放行', POLICY.isDomainAllowed('https://anything.test/', [], []), true);
check('黑名单拦截命中', POLICY.isDomainAllowed('https://bank.com/', [], block), false);
check('黑名单拦截子域', POLICY.isDomainAllowed('https://www.bank.com/x', [], block), false);
check('黑名单优先于白名单', POLICY.isDomainAllowed('https://bank.com/', ['bank.com'], ['bank.com']), false);
check('白名单命中（精确）', POLICY.isDomainAllowed('https://github.com/a', allow, block), true);
check('白名单命中（通配子域）', POLICY.isDomainAllowed('https://chat.deepseek.com/', allow, block), true);
check('白名单未命中 → 拒绝', POLICY.isDomainAllowed('https://twitter.com/', allow, block), false);
check('端口不影响匹配', POLICY.isDomainAllowed('http://localhost:3000/', [], []), true);
// 非 web 页面（chrome:// 的主机名是 "extensions"）本来就不在白名单里 → false。
// 真正的"不能注入"由 isProtected 单独拦截，两个函数各管一件事。
check('白名单模式下非 web 页面不放行', POLICY.isDomainAllowed('chrome://extensions', allow, block), false);
check('无名单时非 web 页面也不因策略被拦（交给 isProtected）', POLICY.isDomainAllowed('chrome://extensions', [], []), true);

console.log('\n--- isProtected ---');
check('http 可注入', POLICY.isProtected('https://a.com'), false);
check('chrome:// 受保护', POLICY.isProtected('chrome://extensions'), true);
check('file:// 受保护', POLICY.isProtected('file:///C:/x.html'), true);
check('about: 受保护', POLICY.isProtected('about:blank'), true);

console.log('\n--- originOf / sanitizeList ---');
check('origin 去路径', POLICY.originOf('https://a.b.com/x?y#z'), 'https://a.b.com');
check('sanitize 去重去空', POLICY.sanitizeList('a.com\n\nb.com, a.com;'), ['a.com', 'b.com']);
check('sanitize 接受数组', POLICY.sanitizeList(['A.com', '*.B.com']), ['a.com', '*.b.com']);

console.log(`\n${checks - failures}/${checks} 通过${failures ? `（${failures} 个失败）` : ''}`);
process.exit(failures ? 1 : 0);
