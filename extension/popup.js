const $ = (id) => document.getElementById(id);
let busy = false;

async function ask(message) {
  try { return await chrome.runtime.sendMessage(message); }
  catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
}

function say(text, isError = false) {
  $('out').textContent = text ?? '';
  $('out').className = isError ? 'out err' : 'out';
}

function paint(state) {
  const { connected, enabled, wsUrl, lastError, grant, policy, current, transport, activeTransport, nativeHost, fullAccess, hasWsToken } = state;

  $('toggle').setAttribute('aria-checked', enabled ? 'true' : 'false');

  // 完全接管
  $('fullToggle').setAttribute('aria-checked', fullAccess ? 'true' : 'false');
  $('fullCard').className = fullAccess ? 'card full on' : 'card full';
  $('fullWarn').style.display = fullAccess ? 'block' : 'none';

  // sharing card
  if (fullAccess) {
    $('shareLabel').textContent = '完全接管中：无需共享';
    $('shareHint').textContent = '关闭「完全接管」后会回到"只操作共享标签页"的窄模式。';
    $('unshare').disabled = true;
  } else if (grant) {
    $('shareLabel').textContent = `正在共享：${grant.title || grant.url}`;
    $('shareHint').textContent = `域名：${grant.origin} · 换站点或关闭该标签页会自动取消`;
    $('unshare').disabled = false;
  } else {
    $('shareLabel').textContent = '未共享任何标签页';
    $('shareHint').textContent = '只有被共享的那个标签页能被 DSH 读取/操作，其他标签页一律不可见。';
    $('unshare').disabled = true;
  }
  if (current) {
    $('currentTab').textContent = current.title || '(无标题)';
    $('currentUrl').textContent = current.url ?? '';
    $('share').disabled = fullAccess || !enabled || current.alreadyShared || !current.shareable;
    $('share').textContent = fullAccess ? '完全接管模式下无需共享'
      : current.alreadyShared ? '已共享此标签页'
        : current.shareable ? '共享当前标签页' : '此标签页不可共享';
  } else {
    $('currentTab').textContent = '（没有活动标签页）';
    $('currentUrl').textContent = '';
    $('share').disabled = true;
  }

  // connection
  const dot = $('dot');
  dot.className = 'dot';
  if (!enabled) $('statusText').textContent = '已停用（总开关关闭）';
  else if (connected) {
    dot.classList.add('ok');
    $('statusText').textContent = activeTransport === 'native'
      ? '已连接（native messaging，无本地端口）'
      : '已连接（WebSocket 回退）';
  } else { dot.classList.add('warn'); $('statusText').textContent = '等待桥接（DSH 用到时会自动启动）'; }
  $('endpoint').textContent = activeTransport === 'native' ? `host: ${nativeHost ?? ''}` : (wsUrl ?? '');
  if (document.activeElement !== $('transport')) $('transport').value = transport ?? 'auto';
  if (document.activeElement !== $('wsToken')) $('wsToken').placeholder = hasWsToken ? '已保存（粘贴可覆盖）' : 'native 会自动下发';
  $('push').disabled = !enabled || !grant;

  // policy (don't clobber what the user is typing)
  if (document.activeElement !== $('blockDomains')) $('blockDomains').value = (policy?.blockDomains ?? []).join('\n');
  if (document.activeElement !== $('allowDomains')) $('allowDomains').value = (policy?.allowDomains ?? []).join('\n');
  $('policyNote').textContent = (policy?.allowDomains?.length)
    ? `白名单生效中（${policy.allowDomains.length} 条）：未列入的域名一律拒绝`
    : '白名单为空：除黑名单外都允许共享';

  if (lastError) say(`上次错误：${lastError}`, true);
}

async function refresh() {
  const state = await ask({ kind: 'grantStatus' });
  if (state && !state.error) paint({ ...state, ...(await ask({ kind: 'status' })) });
  else if (state?.error) say(state.error, true);
}

$('fullToggle').addEventListener('click', async () => {
  const now = $('fullToggle').getAttribute('aria-checked') === 'true';
  const res = await ask({ kind: 'setFullAccess', value: !now });
  say(!now
    ? '已完全接管：Agent 可读取并操作你所有标签页（徽标 ALL）'
    : '已关闭完全接管：回到只操作共享标签页的模式', false);
  await refresh();
});

$('toggle').addEventListener('click', async () => {
  busy = true;
  const now = $('toggle').getAttribute('aria-checked') === 'true';
  await ask({ kind: 'setEnabled', enabled: !now });
  busy = false;
  say(!now ? '已启用页面直连' : '已停用页面直连');
  await refresh();
});

$('share').addEventListener('click', async () => {
  const res = await ask({ kind: 'share' });
  say(res?.ok ? `已共享：${res.grant?.title || res.grant?.url}` : `共享失败：${res?.error ?? '未知错误'}`, !res?.ok);
  await refresh();
});

$('unshare').addEventListener('click', async () => {
  await ask({ kind: 'unshare' });
  say('已停止共享');
  await refresh();
});

$('savePolicy').addEventListener('click', async () => {
  const res = await ask({
    kind: 'setPolicy',
    allowDomains: $('allowDomains').value,
    blockDomains: $('blockDomains').value,
  });
  say(res?.ok ? '策略已保存' : `保存失败：${res?.error ?? '未知错误'}`, !res?.ok);
  await refresh();
});

$('transport').addEventListener('change', async () => {
  const res = await ask({ kind: 'setTransport', transport: $('transport').value });
  say(res?.ok ? `传输方式已切换为 ${res.transport}` : `切换失败：${res?.error ?? '未知错误'}`, !res?.ok);
  await refresh();
});

$('saveToken').addEventListener('click', async () => {
  const res = await ask({ kind: 'setWsToken', token: $('wsToken').value });
  say(res?.ok
    ? (res.hasToken ? 'WS 令牌已保存，正在用它重连' : 'WS 令牌已清空（回退通道不会连接）')
    : `保存失败：${res?.error ?? '未知错误'}`, !res?.ok);
  await refresh();
});

$('reconnect').addEventListener('click', async () => {
  await ask({ kind: 'reconnect' });
  say('已请求重连…');
  setTimeout(refresh, 500);
});

$('push').addEventListener('click', async () => {
  const res = await ask({ kind: 'push' });
  say(res?.ok ? '已上报当前页摘要' : `上报失败：${res?.error ?? '未知错误'}`, !res?.ok);
});

$('version').textContent = `v${chrome.runtime.getManifest().version} · 本地直连 · 仅 127.0.0.1`;
void refresh();
setInterval(() => { if (!busy) void refresh(); }, 1500);
