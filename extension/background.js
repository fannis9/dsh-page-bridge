/**
 * DSH Page Bridge — MV3 service worker.
 *
 * Holds a WebSocket to the local bridge (127.0.0.1:8799), answers read/act commands
 * for the tab the user is looking at, and forwards tab events.
 *
 * IMPORTANT: everything injected into a page goes through ONE self-contained function
 * (PAGE_OP). chrome.scripting serialises the function and runs it in the page, so it
 * must not reference anything from this worker.
 */
const WS_URL = 'ws://127.0.0.1:8799/ws';
const HEARTBEAT_MS = 20000;

let socket = null;
let heartbeat = null;
let retryDelay = 500;
let lastError = null;
/** Master switch (persisted). When false: no connection, no reads, no tab events. */
let enabled = true;
/**
 * 完全接管 (persisted). When true the agent may touch ANY tab and open new ones,
 * without the per-tab grant; the domain blocklist is still enforced. Only the popup can
 * flip this — there is deliberately no bridge command for it, so the agent cannot
 * escalate its own permissions.
 */
let fullAccess = false;
/** Cached copy of the shared-tab grant, so the badge can be painted synchronously. */
let sharedGrant = null;
let badgeText = '';

/** Toolbar badge: '' disabled · '·' idle · '···' waiting · 'ON' shared · 'ALL' full access. */
function paintBadge() {
  const text = !enabled ? ''
    : (fullAccess ? 'ALL' : (!sharedGrant ? '·' : (connected() ? 'ON' : '···')));
  if (text === badgeText) return;
  badgeText = text;
  try {
    chrome.action.setBadgeText({ text });
    if (text) chrome.action.setBadgeBackgroundColor({ color: text === 'ALL' ? '#d14343' : text === 'ON' ? '#12a150' : '#d97706' });
  } catch { /* ignore */ }
}

// #region grant-policy
/**
 * Pure policy helpers — deliberately dependency-free so dev/grant-policy-test.mjs can
 * unit-test them in plain Node (same trick as the aria-snapshot region).
 *
 * Borrowed concepts: BrowserMCP's per-tab "Connect" (a tab must be explicitly shared,
 * one at a time) and mcp-chrome's permission-based access control (domain rules).
 */
const POLICY = (() => {
  const normalizePattern = (raw) => String(raw ?? '')
    .trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/^\./, '')
    .replace(/\.$/, '');
  const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
  const originOf = (url) => { try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return ''; } };
  /** `example.com` matches itself and subdomains; `*.example.com` matches subdomains only. */
  const matches = (host, pattern) => {
    const p = normalizePattern(pattern);
    if (!p || !host) return false;
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return host === base || host.endsWith(`.${base}`);
    }
    return host === p || host.endsWith(`.${p}`);
  };
  /**
   * Decide whether a URL may be read/operated.
   * An empty allowlist means "everything except the blocklist"; a non-empty allowlist
   * turns the mode into default-deny.
   */
  const isDomainAllowed = (url, allow = [], block = []) => {
    const host = hostOf(url);
    if (!host) return true;
    if (block.some((p) => matches(host, p))) return false;
    if (allow.length === 0) return true;
    return allow.some((p) => matches(host, p));
  };
  /** Non-web schemes cannot be injected into; callers report them as protected pages. */
  const isProtected = (url) => !/^https?:/i.test(String(url ?? ''));
  const sanitizeList = (value) => {
    const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\n,;]+/);
    const out = [];
    for (const item of raw) {
      const p = normalizePattern(item);
      if (p && !out.includes(p)) out.push(p);
    }
    return out;
  };
  return { normalizePattern, hostOf, originOf, matches, isDomainAllowed, isProtected, sanitizeList };
})();
// #endregion grant-policy

const NO_GRANT_MESSAGE = '尚未共享标签页：点浏览器工具栏上的扩展图标 → 「共享当前标签页」，之后我才能读取/操作它';
const DEFAULT_POLICY = { allowDomains: [], blockDomains: [] };

async function readPolicy() {
  const stored = await chrome.storage.local.get(DEFAULT_POLICY);
  return {
    allowDomains: POLICY.sanitizeList(stored.allowDomains),
    blockDomains: POLICY.sanitizeList(stored.blockDomains),
  };
}

/** The shared tab lives in session storage: closing the browser revokes it automatically. */
async function readGrant() {
  try {
    const { grant } = await chrome.storage.session.get({ grant: null });
    return grant ?? null;
  } catch {
    return null;
  }
}

async function writeGrant(grant) {
  sharedGrant = grant ?? null;
  try { await chrome.storage.session.set({ grant: sharedGrant }); } catch { /* ignore */ }
  paintBadge();
}

/** Resolve and authorize the tab a command may touch; throws with actionable text. */
async function authorizedTab(args = {}) {
  // 完全接管: any tab, no grant needed — but the user's blocklist still wins.
  if (fullAccess) {
    const tab = args.tabId === undefined
      ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
      : await chrome.tabs.get(Number(args.tabId)).catch(() => null);
    if (!tab) throw new Error('找不到目标标签页：完全接管模式下默认用当前活动标签页，也可显式传 tabId');
    const policy = await readPolicy();
    if (!POLICY.isDomainAllowed(tab.url, [], policy.blockDomains)) {
      throw new Error(`该域名在黑名单中，拒绝操作：${POLICY.hostOf(tab.url)}（黑名单在完全接管模式下依然生效）`);
    }
    return tab;
  }

  const grant = await readGrant();
  if (!grant) throw new Error(NO_GRANT_MESSAGE);
  const wanted = args.tabId === undefined ? grant.tabId : Number(args.tabId);
  if (wanted !== Number(grant.tabId)) {
    throw new Error(`只能操作已共享的标签页（当前共享：「${grant.title || grant.url}」）`);
  }
  const tab = await chrome.tabs.get(wanted).catch(() => null);
  if (!tab) {
    await writeGrant(null);
    throw new Error('共享的标签页已关闭，共享已自动取消；请重新点扩展图标共享');
  }
  const policy = await readPolicy();
  if (!POLICY.isDomainAllowed(tab.url, policy.allowDomains, policy.blockDomains)) {
    await writeGrant(null);
    throw new Error(`域名策略拒绝访问，已自动取消共享：${POLICY.hostOf(tab.url)}（可在扩展弹窗里调整白/黑名单）`);
  }
  return tab;
}

/** Share one tab (the active one by default), refusing protected or blocked pages. */
async function shareTab(tabId) {
  const tab = tabId === undefined
    ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
    : await chrome.tabs.get(Number(tabId)).catch(() => null);
  if (!tab) throw new Error('找不到要共享的标签页');
  if (POLICY.isProtected(tab.url)) throw new Error(`受保护页面不能共享（${tab.url}）`);
  const policy = await readPolicy();
  if (!POLICY.isDomainAllowed(tab.url, policy.allowDomains, policy.blockDomains)) {
    throw new Error(`该域名在策略中被拒绝：${POLICY.hostOf(tab.url)}`);
  }
  const grant = {
    tabId: tab.id,
    origin: POLICY.originOf(tab.url),
    url: tab.url,
    title: (tab.title ?? '').slice(0, 120),
    grantedAt: Date.now(),
  };
  await writeGrant(grant);
  return grant;
}

/** The single injected entry point: (payload) => result, fully self-contained. */
function PAGE_OP(payload) {
  const clean = (s) => (s ?? '').replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  // Target resolution shared by every action: snapshot refs first, then text=, then CSS.
  // Refs look like "@e12", "e12", "ref=e12" or "[ref=e12]" (borrowed from BrowserMCP/Playwright).
  const REF = /^(?:@|ref=|\[ref=)?(e\d+)\]?$/i;
  const byRef = (ref) => deepQuery(`[data-dsh-ref="${ref}"]`);
  const byText = (needle) => {
    const wanted = needle.trim().toLowerCase();
    // Shadow-DOM aware: GitHub & friends hide menu items and dialog buttons in shadow roots.
    const nodes = deepQueryAll('a,button,[role="button"],[role="menuitem"],input,label,li,td,th,h1,h2,h3,p,span,div');
    return nodes.find((el) => (el.innerText ?? '').trim().toLowerCase() === wanted)
      ?? nodes.find((el) => (el.innerText ?? '').toLowerCase().includes(wanted))
      ?? null;
  };
  const find = (spec) => {
    if (!spec) return null;
    const raw = String(spec).trim();
    const ref = REF.exec(raw);
    if (ref) return byRef(ref[1]);
    if (raw.startsWith('text=')) return byText(raw.slice(5));
    return deepQuery(raw);
  };
  const describe = (el) => ({ tag: el.tagName.toLowerCase(), text: clean(el.innerText ?? el.value ?? '').slice(0, 160) });

  // #region aria-snapshot
  /**
   * Shadow-DOM-aware queries. Modern UIs (GitHub's dialogs, many web components) render
   * interactive controls inside shadow roots, where plain querySelectorAll cannot see them
   * and el.children looks empty — that is exactly how a dialog can be "on screen but
   * invisible to the snapshot". These helpers walk every open shadow root instead.
   * Kept inside this region so the extracted snippet stays self-contained.
   */
  const deepRoots = (root = document) => {
    const roots = [root];
    const walk = (node) => {
      for (const el of node.querySelectorAll('*')) {
        if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); }
      }
    };
    try { walk(root); } catch { /* ignore */ }
    return roots;
  };
  const deepQueryAll = (selector, root = document) => {
    const found = [];
    for (const scope of deepRoots(root)) {
      try { found.push(...scope.querySelectorAll(selector)); } catch { return found; }
    }
    return found;
  };
  const deepQuery = (selector, root = document) => deepQueryAll(selector, root)[0] ?? null;

  /**
   * Playwright-style ARIA snapshot, self-contained because it is injected into the page.
   * Marks targetable nodes with data-dsh-ref="eN" so later actions can address them as "@eN".
   * Design borrowed from BrowserMCP (aria snapshot + refs, refreshed after every action)
   * and Playwright's ariaSnapshot() output shape.
   */
  const buildAriaSnapshot = (options) => {
    const opts = options || {};
    const maxNodes = opts.maxNodes || 500;
    const maxDepth = opts.maxDepth || 14;
    const maxRefs = opts.maxRefs || 200;
    const maxName = opts.maxName || 120;

    // Ref 稳定性：data-dsh-ref 留在 DOM 上，所以**同一个元素跨快照保持同一个编号**。
    // 这样"点 A 再点 B"时，中间新插入的节点不会让后面的 ref 整体错位；元素消失后它的 ref
    // 自然失效（属性随节点一起没了）。新元素从当前最大编号往后接着发。
    let refSeq = 0;
    for (const el of deepQueryAll('[data-dsh-ref]')) {
      const n = Number(String(el.getAttribute('data-dsh-ref')).replace(/^e/, ''));
      if (Number.isFinite(n) && n > refSeq) refSeq = n;
    }

    const ROLE = {
      a: 'link', area: 'link', button: 'button', textarea: 'textbox', select: 'combobox',
      img: 'img', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
      ul: 'list', ol: 'list', li: 'listitem', table: 'table', thead: 'rowgroup', tbody: 'rowgroup',
      tr: 'row', td: 'cell', th: 'columnheader', caption: 'caption', form: 'form', nav: 'navigation',
      main: 'main', header: 'banner', footer: 'contentinfo', aside: 'complementary', section: 'region',
      article: 'article', dialog: 'dialog', iframe: 'iframe', video: 'video', audio: 'audio',
      progress: 'progressbar', meter: 'meter', details: 'group', summary: 'button', option: 'option',
      optgroup: 'group', fieldset: 'group', legend: 'legend', output: 'status', figure: 'figure',
      figcaption: 'caption', hr: 'separator', blockquote: 'blockquote',
    };
    const INPUT_ROLE = {
      checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
      email: 'textbox', tel: 'textbox', url: 'textbox', password: 'textbox', file: 'button', submit: 'button',
      reset: 'button', button: 'button', image: 'button', color: 'button',
    };
    const NAME_FROM_CONTENT = new Set(['button', 'link', 'heading', 'cell', 'columnheader', 'rowheader',
      'listitem', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'legend', 'caption', 'summary']);
    const ACTIONABLE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox',
      'radio', 'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
      'option', 'treeitem', 'summary']);
    const SKIP = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'base', 'head', 'title']);
    /** Naming-only containers: they feed an accessible name, they are not tree nodes. */
    const TRANSPARENT_TAGS = new Set(['label', 'span', 'b', 'i', 'u', 'strong', 'em', 'small', 'sub', 'sup', 'font', 'center']);
    /** Structural roles worth emitting even when unnamed, so nesting stays readable. */
    const ALWAYS_EMIT = new Set(['list', 'listbox', 'table', 'rowgroup', 'row', 'form', 'dialog', 'menu',
      'menubar', 'tablist', 'group', 'figure', 'article', 'navigation', 'main', 'banner', 'contentinfo',
      'complementary', 'tabpanel', 'tree', 'grid']);

    const norm = (s) => String(s ?? '').replace(/[\s\u00a0]+/g, ' ').trim();
    const cut = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);

    /**
     * Three-state visibility. The middle state matters most: some containers have no box or
     * are themselves invisible while their **descendants** still render:
     *   - `display: contents` → own rect is 0×0, children lay out normally
     *     (this is what hid GitHub's dialog inside <dialog-helper>);
     *   - `visibility: hidden` → a descendant may set `visibility: visible` and re-appear
     *     (CSS allows it; `display: none` and `opacity: 0` cannot be undone).
     * Pruning on the ancestor therefore drops visible content. So:
     *   'hidden' — 后代无法翻盘（display:none / opacity:0 / hidden / aria-hidden）→ 剪掉
     *   'flat'   — 自身不可见或没有盒子，但子树可能有可见内容 → 继续下钻，不产出节点
     *   'shown'  — 正常可见
     */
    const visibilityOf = (el) => {
      if (!el || el.nodeType !== 1) return 'hidden';
      const st = getComputedStyle(el);
      if (st.display === 'none' || Number(st.opacity) === 0) return 'hidden';
      if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return 'hidden';
      if (st.visibility === 'hidden' || st.visibility === 'collapse') return 'flat';
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return 'flat';
      return 'shown';
    };
    const shown = (el) => visibilityOf(el) !== 'hidden';

    const roleOf = (el) => {
      const explicit = el.getAttribute('role');
      if (explicit) {
        const first = explicit.trim().split(/\s+/)[0];
        if (first && first !== 'presentation' && first !== 'none') return first;
      }
      const tag = el.tagName.toLowerCase();
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'hidden') return '';
        return INPUT_ROLE[type] || 'textbox';
      }
      if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : '';
      if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
      return ROLE[tag] || '';
    };

    const nameOf = (el, role) => {
      const aria = norm(el.getAttribute('aria-label'));
      if (aria) return cut(aria, maxName);
      const ids = el.getAttribute('aria-labelledby');
      if (ids) {
        const text = ids.split(/\s+/)
          .map((id) => { const t = document.getElementById(id); return t ? norm(t.innerText || t.getAttribute('aria-label')) : ''; })
          .filter(Boolean).join(' ');
        if (text) return cut(text, maxName);
      }
      if (el.tagName === 'IMG') { const alt = norm(el.getAttribute('alt')); if (alt) return cut(alt, maxName); }
      const label = el.labels && el.labels[0] ? norm(el.labels[0].innerText) : '';
      if (label) return cut(label, maxName);
      const hint = norm(el.getAttribute('placeholder') || el.getAttribute('title'));
      if (hint) return cut(hint, maxName);
      if (el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.getAttribute('type') || '')) {
        const value = norm(el.value);
        if (value) return cut(value, maxName);
      }
      if (NAME_FROM_CONTENT.has(role)) {
        const text = norm(el.innerText || el.textContent);
        if (text) return cut(text, maxName);
      }
      // icon-only controls: fall back to a descendant image alt or svg title
      const icon = el.querySelector('img[alt], svg > title, svg[aria-label]');
      if (icon) {
        const alt = norm(icon.getAttribute('alt') || icon.getAttribute('aria-label') || icon.textContent);
        if (alt) return cut(alt, maxName);
      }
      return '';
    };

    const attrsOf = (el, role) => {
      const parts = [];
      const tag = el.tagName.toLowerCase();
      if (role === 'heading') { const lvl = Number(tag.slice(1)); if (lvl >= 1 && lvl <= 6) parts.push(`level=${lvl}`); }
      if (role === 'checkbox' || role === 'radio' || role === 'switch') {
        const checked = el.indeterminate ? 'mixed' : (el.checked ? 'checked' : 'unchecked');
        if (el.checked !== undefined) parts.push(checked);
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
      if (el.required || el.getAttribute('aria-required') === 'true') parts.push('required');
      if (tag === 'option' && el.selected) parts.push('selected');
      const expanded = el.getAttribute('aria-expanded');
      if (expanded) parts.push(`expanded=${expanded}`);
      if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton' || role === 'combobox') {
        const value = norm(el.value);
        if (value) parts.push(`value="${cut(value, 60)}"`);
      }
      if (role === 'link') {
        const href = el.getAttribute('href');
        if (href && !href.startsWith('javascript:')) parts.push(`url=${cut(href, 80)}`);
      }
      return parts.length ? ` [${parts.join(' ')}]` : '';
    };

    const lines = [];
    let refs = 0;
    let nodes = 0;
    let truncated = false;

    const walk = (el, depth) => {
      if (nodes >= maxNodes) { truncated = true; return; }
      const tag = el.tagName.toLowerCase();
      if (SKIP.has(tag)) return;
      const vis = visibilityOf(el);
      if (vis === 'hidden') return;
      // 'flat' 容器（display:contents / visibility:hidden 祖先）要下钻，但**自身不产出节点、
      // 也不分配 ref** —— 否则会给模型一个指向"看不见的按钮"的 ref，点下去照样触发（例如
      // 隐藏的「Delete this repository」确认按钮）。只有真正渲染出来的元素才可寻址。
      const visibleHere = vis === 'shown';
      if (depth > maxDepth) { truncated = true; return; }

      const role = roleOf(el);
      const name = visibleHere && role ? nameOf(el, role) : '';
      const focusable = el.tabIndex >= 0 && tag !== 'body' && tag !== 'html';
      const actionable = Boolean(role && (ACTIONABLE.has(role) || el.hasAttribute('role'))) || focusable;
      let ref = '';
      if (visibleHere && actionable) {
        // 已有编号就沿用（这就是"稳定 ref"），没有才发新号
        const existing = el.getAttribute('data-dsh-ref');
        if (existing) {
          ref = existing;
        } else {
          refSeq += 1;
          ref = `e${refSeq}`;
          el.setAttribute('data-dsh-ref', ref);
        }
        if (refs < maxRefs) refs += 1; else ref = '';   // 本次快照只广告前 maxRefs 个
      }

      // Composed tree: when a custom element has a shadow root, that is what actually
      // renders, so descend into it instead of the (often empty) light DOM.
      const childNodes = el.shadowRoot ? [...el.shadowRoot.children] : [...el.children];
      // 闭合的 <details> 只渲染 <summary>。注意：Chromium 是**用 slot 机制**隐藏内容的，
      // 被隐藏的节点计算样式仍是 visible、rect 也仍有尺寸，所以只能按语义判断（不能靠样式）。
      const renderable = (tag === 'details' && !el.open)
        ? childNodes.filter((c) => c.tagName.toLowerCase() === 'summary')
        : childNodes;
      const children = renderable.filter((c) => !SKIP.has(c.tagName.toLowerCase()) && shown(c));
      const namingOnly = TRANSPARENT_TAGS.has(tag) && !el.hasAttribute('data-dsh-ref');
      const structural = Boolean(role) && ALWAYS_EMIT.has(role) && children.length > 0;
      const emit = visibleHere && !namingOnly && Boolean(role)
        && (structural || Boolean(name) || Boolean(ref) || children.length === 0 || el.hasAttribute('role'));
      if (emit) {
        lines.push(`${'  '.repeat(depth)}- ${role}${name ? ` "${name}"` : ''}${ref ? ` [ref=${ref}]` : ''}${attrsOf(el, role)}`);
        nodes += 1;
      }
      const childDepth = emit ? depth + 1 : depth;
      const before = lines.length;
      for (const child of children) walk(child, childDepth);
      if (visibleHere && !emit && !namingOnly && lines.length === before && children.length === 0) {
        const text = norm(el.innerText || el.textContent);
        if (text.length > 1) {
          lines.push(`${'  '.repeat(depth)}- text "${cut(text, maxName)}"`);
          nodes += 1;
        }
      }
    };

    walk(opts.root ?? document.body ?? document.documentElement, 0);
    if (truncated) lines.push(`# … 已截断（上限 ${maxNodes} 节点 / 深度 ${maxDepth}）`);

    return {
      url: location.href,
      title: document.title,
      yaml: lines.join('\n'),
      nodes,
      refs,
      truncated,
    };
  };
  // #endregion aria-snapshot

  const k = payload.kind;
  const args = payload.args ?? {};

  if (k === 'snapshot') {
    let root = null;
    if (args.selector) {
      root = deepQuery(args.selector);
      if (!root) return { ok: false, reason: `找不到元素：${args.selector}` };
    }
    return buildAriaSnapshot({
      maxNodes: args.maxNodes,
      maxDepth: args.maxDepth,
      maxRefs: args.maxRefs,
      maxName: args.maxName,
      root,
    });
  }

  if (k === 'state') {
    return {
      url: location.href,
      title: document.title,
      lang: document.documentElement.lang || undefined,
      selection: clean(String(getSelection() ?? '')).slice(0, 2000) || undefined,
      headings: deepQueryAll('h1,h2,h3').filter(visible).slice(0, args.maxHeadings ?? 40)
        .map((el) => ({ level: Number(el.tagName.slice(1)), text: clean(el.innerText).slice(0, 200) })),
      forms: deepQueryAll('form,input,textarea,select,button').filter(visible).slice(0, args.maxForms ?? 60)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') ?? undefined,
          id: el.id || undefined,
          name: el.getAttribute('name') ?? undefined,
          placeholder: el.getAttribute('placeholder') ?? undefined,
          label: clean(el.getAttribute('aria-label') || el.labels?.[0]?.innerText || '').slice(0, 80) || undefined,
          text: clean(el.innerText || el.value || '').slice(0, 80) || undefined,
        })),
      scroll: { y: Math.round(window.scrollY), height: Math.round(document.documentElement.scrollHeight), viewport: window.innerHeight },
      text: clean(document.body?.innerText ?? '').slice(0, args.maxText ?? 12000),
    };
  }

  if (k === 'text') {
    const t = clean(document.body?.innerText ?? '');
    return { url: location.href, title: document.title, length: t.length, text: t.slice(0, args.max ?? 20000) };
  }

  if (k === 'html') {
    // outerHTML does not include shadow content, so append any shadow roots found — that is
    // usually where the interesting markup lives on component-heavy sites.
    let html = document.documentElement.outerHTML;
    const shadowParts = [];
    for (const root of deepRoots()) {
      if (root === document) continue;
      const host = root.host;
      shadowParts.push(`<!-- shadow of <${host?.tagName?.toLowerCase() ?? '?'}> -->\n${root.innerHTML}`);
    }
    if (shadowParts.length) html += `\n<!-- ===== shadow roots (${shadowParts.length}) ===== -->\n${shadowParts.join('\n')}`;
    return { url: location.href, length: html.length, html: html.slice(0, args.max ?? 60000) };
  }

  if (k === 'eval') {
    // NOTE: on pages with a strict CSP some worlds silently refuse eval and return
    // undefined. Probe first so the failure is loud instead of looking like "null".
    let canEval = false;
    try { canEval = (0, eval)('1+1') === 2; } catch { canEval = false; }
    if (!canEval) {
      return {
        __evalUnavailable: true,
        world: args.worldName ?? 'isolated',
        hint: '该执行世界禁用了 eval（通常是页面 CSP）。请改用 --world MAIN，或用 state/text/click 等 DOM 方式。',
      };
    }
    const value = (0, eval)(String(args.code ?? ''));
    try { return JSON.parse(JSON.stringify(value ?? null)); } catch { return String(value); }
  }

  if (k === 'click') {
    const el = find(args.selector);
    if (!el) return { ok: false, reason: 'element not found' };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    // NOTE: dispatch mousedown/mouseup for framework listeners, then use el.click()
    // for the neutral click. Dispatching a synthetic click *as well* would activate
    // the element twice (e.g. a target=_blank link opening two tabs).
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', opts));
    return { ok: true, ...describe(el) };
  }

  // #region key-dispatch
  /**
   * Synthetic key press that behaves like a real one.
   *
   * Why the legacy fields matter: React handlers (and design systems like Primer, used by
   * GitHub) still branch on `event.keyCode` / `event.which`. A KeyboardEvent built with only
   * `key` has keyCode === 0, so "press Enter to commit a token" silently does nothing.
   * Chomium accepts keyCode/which in the KeyboardEventInit dict, so we set them here.
   *
   * Kept in its own region so dev/key-dispatch-test.mjs can extract and exercise it in a
   * real browser (same trick as the aria-snapshot region).
   */
  const KEYCODES = {
    Enter: 13, Backspace: 8, Delete: 46, Tab: 9, Escape: 27, Esc: 27, Space: 32,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Home: 36, End: 35, PageUp: 33, PageDown: 34, Insert: 45, F5: 116,
  };

  const keyInfo = (name) => {
    const raw = String(name ?? '');
    const single = raw.length === 1;
    const normalized = single ? raw.toUpperCase() : raw;
    const keyCode = single
      ? normalized.charCodeAt(0)
      : (KEYCODES[normalized] ?? KEYCODES[raw] ?? 0);
    const code = single
      ? (/[0-9]/.test(raw) ? `Digit${raw}` : `Key${normalized}`)
      : (normalized === 'Space' ? 'Space' : normalized);
    const key = normalized === 'Space' ? ' ' : (single ? raw : normalized);
    return { key, code, keyCode, which: keyCode };
  };

  const pressKey = (target, name, repeat = 1) => {
    const raw = String(name ?? '');
    const single = raw.length === 1;
    const known = single
      || Object.prototype.hasOwnProperty.call(KEYCODES, raw)
      || Object.prototype.hasOwnProperty.call(KEYCODES, raw.toUpperCase() === raw ? raw : raw[0].toUpperCase() + raw.slice(1));
    if (!known) {
      return { ok: false, reason: `不认识的按键：${name}（可用 Enter/Backspace/Delete/Tab/Escape/Space/ArrowUp/Down/Left/Right/Home/End/PageUp/PageDown，或单个字符）` };
    }
    const info = keyInfo(name);
    if (target && typeof target.focus === 'function') {
      try { target.focus(); } catch { /* ignore */ }
    }
    const node = target ?? document.activeElement ?? document.body;
    const times = Math.max(1, Math.min(Number(repeat) || 1, 20));
    const init = { ...info, bubbles: true, cancelable: true, composed: true };
    for (let i = 0; i < times; i += 1) {
      node.dispatchEvent(new KeyboardEvent('keydown', init));
      if (info.key.length === 1) node.dispatchEvent(new KeyboardEvent('keypress', init));
      node.dispatchEvent(new KeyboardEvent('keyup', init));
    }
    return { ok: true, key: info.key, keyCode: info.keyCode, repeat: times, tag: node.tagName?.toLowerCase() ?? null };
  };
  // #endregion key-dispatch

  if (k === 'type') {
    const el = find(args.selector);
    if (!el) return { ok: false, reason: 'element not found' };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    const value = String(args.text ?? '');
    if (el.isContentEditable) {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, value);
    } else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (args.submit) {
      const form = el.form ?? el.closest('form');
      if (form) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
      // 没有 form 时用带 keyCode 的合成回车——很多组件（Primer 等）只认这个
      else pressKey(el, 'Enter');
    }
    return { ok: true, tag: el.tagName.toLowerCase(), value: el.value ?? value };
  }

  if (k === 'key') {
    const target = args.selector ? find(args.selector) : (document.activeElement ?? document.body);
    if (args.selector && !target) return { ok: false, reason: `找不到元素：${args.selector}` };
    return pressKey(target, args.key, args.repeat);
  }

  if (k === 'select') {
    const el = find(args.selector);
    if (!el) return { ok: false, reason: 'element not found' };
    el.value = String(args.value ?? '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: el.value };
  }

  if (k === 'scroll') {
    if (args.selector) {
      const el = find(args.selector);
      if (!el) return { ok: false, reason: 'element not found' };
      el.scrollIntoView({ block: args.block ?? 'center', behavior: 'smooth' });
    } else {
      window.scrollBy({ top: Number(args.by ?? 800), behavior: 'smooth' });
    }
    return { ok: true, y: Math.round(window.scrollY) };
  }

  if (k === 'highlight') {
    const el = find(args.selector);
    if (!el) return { ok: false, reason: 'element not found' };
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = '3px solid #2f6df6';
    el.style.outlineOffset = '2px';
    setTimeout(() => { el.style.outline = prevOutline; el.style.outlineOffset = prevOffset; }, args.ms ?? 2500);
    return { ok: true, ...describe(el) };
  }

  if (k === 'wait') {
    const el = find(args.selector);
    return { ok: Boolean(el), ...(el ? describe(el) : {}) };
  }

  if (k === 'count') {
    try { return { ok: true, count: deepQueryAll(args.selector).length }; }
    catch (error) { return { ok: false, reason: String(error?.message ?? error) }; }
  }

  return { ok: false, reason: `unknown kind: ${k}` };
}

/* --------------------------------------------------------- transport plumbing */

/**
 * Two transports, one protocol:
 *   native messaging (preferred) — Chrome spawns/keeps the host, no listening socket for
 *     the browser side, and the port survives service-worker suspension far better.
 *   WebSocket (fallback) — used when the native host isn't registered, or on request.
 */
const NATIVE_HOST = 'com.dsh.page_bridge';

/**
 * Which Chromium browser are we in? Chrome and Edge can load this very same directory and
 * therefore share one extension ID, so the bridge needs this to tell them apart when both are
 * open — it then serves whichever browser you are actually using.
 */
const BROWSER_NAME = (() => {
  const ua = navigator.userAgent ?? '';
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\//.test(ua)) return 'opera';
  if (/Brave/.test(ua)) return 'brave';
  if (/Chrome\//.test(ua)) return 'chrome';
  return 'chromium';
})();

let transport = 'auto';       // 'auto' | 'native' | 'ws' (persisted)
let nativePort = null;        // chrome.runtime.Port while native is live
let activeTransport = null;   // 'native' | 'ws' | null — what is actually connected
let wsFallback = false;       // 'auto' mode fell back for this worker's lifetime

function connected() {
  return Boolean(nativePort) || socket?.readyState === WebSocket.OPEN;
}

function stopHeartbeat() {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
}

/**
 * Is one of this browser's windows focused right now? With Chrome and Edge both connected
 * the bridge uses this to send commands to the browser the user is actually looking at.
 */
async function isFocused() {
  try {
    const win = await chrome.windows.getLastFocused();
    return win?.focused === true;
  } catch {
    return false;
  }
}

async function sendPresence() {
  send({ type: 'ping', t: Date.now(), focused: await isFocused() });
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeat = setInterval(() => { void sendPresence(); }, HEARTBEAT_MS);
  void sendPresence();   // tell the bridge about focus right away, don't wait 20s
}

function send(payload) {
  if (nativePort) {
    try { nativePort.postMessage(payload); return true; } catch { /* fall through to ws */ }
  }
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

/** Single place that turns an inbound transport message into work (shared by both). */
async function onTransportMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'pong' || msg.type === 'hello-ack') return;
  if (msg.type !== 'cmd') return;
  try {
    const result = await handle(msg.name, msg.args ?? {});
    send({ type: 'result', id: msg.id, ok: true, result });
  } catch (error) {
    send({ type: 'result', id: msg.id, ok: false, error: String(error?.message ?? error) });
  }
}

function scheduleReconnect() {
  if (!enabled) return;
  setTimeout(connect, retryDelay);
  // Cap at 5s so an on-demand bridge is picked up quickly.
  retryDelay = Math.min(retryDelay * 2, 5000);
}

function connect() {
  if (!enabled || connected()) return;
  if (transport === 'ws' || wsFallback) { connectWs(); return; }
  connectNative();
}

/**
 * Chrome launches the native host and keeps the pipe open; if the host is missing or dies
 * during the probe window we degrade to the WebSocket rather than failing.
 */
function connectNative() {
  if (nativePort) return;
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (error) {
    onNativeUnavailable(String(error?.message ?? error));
    return;
  }
  nativePort = port;
  let sawMessage = false;

  port.onMessage.addListener((msg) => {
    sawMessage = true;
    retryDelay = 500;
    lastError = null;
    if (activeTransport !== 'native') {
      activeTransport = 'native';
      console.log('[page-bridge] native transport connected');
      startHeartbeat();
      paintBadge();
    }
    void onTransportMessage(msg);
  });

  port.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message ?? 'native host 已断开';
    nativePort = null;
    stopHeartbeat();
    if (activeTransport === 'native') activeTransport = null;
    paintBadge();
    if (!enabled) return;
    if (!sawMessage) { onNativeUnavailable(reason); return; }   // never useful → fall back
    lastError = reason;
    scheduleReconnect();                                        // worked before → retry
  });

  // Say hello immediately: the host only speaks once spoken to, so waiting for a first
  // inbound message here would deadlock both sides until the probe window closes.
  send({ type: 'hello', agent: 'chrome-extension', browser: BROWSER_NAME, version: chrome.runtime.getManifest().version, via: 'native' });

  // Probe window: a missing/unregistered host disconnects almost immediately.
  setTimeout(() => {
    if (!sawMessage && nativePort === port) {
      try { port.disconnect(); } catch { /* ignore */ }
    }
  }, 900);
}

function onNativeUnavailable(reason) {
  lastError = `native messaging 不可用：${reason}`;
  console.log('[page-bridge]', lastError);
  if (transport === 'native') { scheduleReconnect(); return; }
  wsFallback = true;
  connectWs();
}

function connectWs() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  try {
    socket = new WebSocket(WS_URL);
  } catch (error) {
    lastError = String(error);
    scheduleReconnect();
    return;
  }
  socket.addEventListener('open', () => {
    retryDelay = 500;
    lastError = null;
    activeTransport = 'ws';
    console.log('[page-bridge] websocket transport connected', WS_URL);
    paintBadge();
    send({ type: 'hello', agent: 'chrome-extension', browser: BROWSER_NAME, version: chrome.runtime.getManifest().version, via: 'ws' });
    startHeartbeat();
  });
  socket.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    void onTransportMessage(msg);
  });
  socket.addEventListener('close', () => {
    stopHeartbeat();
    socket = null;
    if (activeTransport === 'ws') activeTransport = null;
    paintBadge();
    scheduleReconnect();
  });
  socket.addEventListener('error', () => { lastError = 'websocket error'; });
}

/** Drop whatever is connected and start over (used by 重连 / transport switch). */
function resetTransport() {
  wsFallback = false;
  stopHeartbeat();
  if (nativePort) { try { nativePort.disconnect(); } catch { /* ignore */ } nativePort = null; }
  if (socket) { try { socket.close(); } catch { /* ignore */ } socket = null; }
  activeTransport = null;
  retryDelay = 500;
  paintBadge();
  connect();
}

/* ------------------------------------------------------------------ commands */

async function inject(tabId, kind, args = {}, world = 'ISOLATED') {
  const options = { target: { tabId }, args: [{ kind, args }] };
  try {
    const [res] = await chrome.scripting.executeScript({ ...options, world, func: PAGE_OP });
    if (res?.error) throw new Error(String(res.error.message ?? res.error));
    return res?.result;
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/world|Unexpected property/i.test(message)) {
      const [res] = await chrome.scripting.executeScript({ ...options, func: PAGE_OP });
      return res?.result;
    }
    if (/Cannot access|chrome:\/\//i.test(message)) {
      throw new Error(`无法访问该页面（受保护页面）：${message}`);
    }
    throw error;
  }
}

async function handle(name, args) {
  // Commands that don't touch a tab: connectivity + sharing state.
  if (name === 'ping') return { pong: true, t: Date.now(), version: chrome.runtime.getManifest().version };
  if (name === 'grant') {
    const [grant, policy] = await Promise.all([readGrant(), readPolicy()]);
    return {
      shared: grant ? { ...grant } : null,
      policy,
      enabled,
      fullAccess,
      browser: BROWSER_NAME,
      version: chrome.runtime.getManifest().version,
      connected: connected(),
      transport,
      activeTransport,
      hint: grant || fullAccess ? undefined : NO_GRANT_MESSAGE,
    };
  }

  // Opening a tab needs no existing target: allowed in full access, or while a tab is
  // shared (so the narrow mode can still branch out deliberately).
  if (name === 'open') {
    if (!fullAccess) {
      const grant = await readGrant();
      if (!grant) throw new Error('开新标签页需要先在弹窗里打开「完全接管」，或先共享一个标签页');
    }
    const url = String(args.url ?? 'about:blank');
    const policy = await readPolicy();
    if (/^https?:/i.test(url) && !POLICY.isDomainAllowed(url, [], policy.blockDomains)) {
      throw new Error(`该域名在黑名单中，拒绝打开：${POLICY.hostOf(url)}`);
    }
    const created = await chrome.tabs.create({ url, active: args.active !== false });
    return {
      ok: true,
      tabId: created.id,
      windowId: created.windowId,
      url: created.url ?? url,
      title: created.title ?? '',
      active: created.active,
    };
  }

  // Everything below needs an authorized tab (shared tab, or any tab under 完全接管).
  const tab = await authorizedTab(args);
  const tabId = tab.id;

  switch (name) {
    case 'tabs':
      if (fullAccess) {
        const tabs = await chrome.tabs.query({});
        return tabs.map((t) => ({ id: t.id, windowId: t.windowId, active: t.active, url: t.url, title: t.title }));
      }
      // Narrow mode: only the shared tab is disclosed — no full browsing history.
      return [{ id: tab.id, windowId: tab.windowId, active: tab.active, url: tab.url, title: tab.title }];
    case 'state':
      return inject(tabId, 'state', { maxText: args.maxText, maxHeadings: args.maxHeadings, maxForms: args.maxForms }, args.world);
    case 'snapshot':
      return inject(tabId, 'snapshot', {
        selector: args.selector,
        maxNodes: args.maxNodes,
        maxDepth: args.maxDepth,
        maxRefs: args.maxRefs,
        maxName: args.maxName,
      }, args.world);
    case 'text':
      return inject(tabId, 'text', { max: args.max }, args.world);
    case 'html':
      return inject(tabId, 'html', { max: args.max }, args.world);
    case 'eval':
      // eval defaults to MAIN: the isolated world silently refuses eval on strict-CSP pages.
      return inject(tabId, 'eval', { code: args.code, worldName: args.world ?? 'MAIN' }, args.world ?? 'MAIN');
    case 'click':
      return inject(tabId, 'click', { selector: args.selector }, args.world);
    case 'key':
      return inject(tabId, 'key', { selector: args.selector, key: args.key, repeat: args.repeat }, args.world);
    case 'type':
      return inject(tabId, 'type', { selector: args.selector, text: args.text, submit: args.submit }, args.world);
    case 'select':
      return inject(tabId, 'select', { selector: args.selector, value: args.value }, args.world);
    case 'scroll':
      return inject(tabId, 'scroll', { selector: args.selector, by: args.by, block: args.block }, args.world);
    case 'highlight':
      return inject(tabId, 'highlight', { selector: args.selector, ms: args.ms }, args.world);
    case 'wait':
      return inject(tabId, 'wait', { selector: args.selector }, args.world);
    case 'count':
      return inject(tabId, 'count', { selector: args.selector }, args.world);
    case 'shot': {
      const tab = await chrome.tabs.get(tabId);
      // captureVisibleTab does not merely fail when its window is in the background — it can
      // stall until the service worker is torn down, which looks like a hang. So check first
      // and answer immediately with something the user can act on.
      const win = await chrome.windows.get(tab.windowId).catch(() => null);
      if (win && win.focused === false) {
        throw new Error('截图需要目标窗口在前台：该浏览器窗口当前不在前台，切过去再试；'
          + '或者改用 page_snapshot / page_text 读页面内容（它们不需要前台）。');
      }
      if (win && win.state === 'minimized') {
        throw new Error('截图需要目标窗口可见：该浏览器窗口处于最小化状态，还原后再试。');
      }
      const dataUrl = await Promise.race([
        chrome.tabs.captureVisibleTab(tab.windowId, { format: args.format ?? 'png' }),
        new Promise((_resolve, reject) => setTimeout(
          () => reject(new Error('截图超时：窗口可能被遮挡或未聚焦，请把该浏览器窗口切到前台后重试（或改用 page_snapshot/page_text）')),
          Number(args.timeoutMs ?? 8000),
        )),
      ]);
      return { dataUrl, url: tab.url, title: tab.title };
    }
    case 'activate': {
      const active = await chrome.tabs.update(tabId, { active: true });
      if (active.windowId) await chrome.windows.update(active.windowId, { focused: true });
      return { ok: true, tabId: active.id, url: active.url };
    }
    case 'close': {
      await chrome.tabs.remove(tabId);
      await writeGrant(null);
      return { ok: true, closed: tabId };
    }
    case 'navigate': {
      const tab = await chrome.tabs.update(tabId, { url: args.url });
      // Wait for the document to finish loading, so the caller's auto-snapshot sees the
      // real page instead of a half-rendered document. Takes effect after the extension
      // is reloaded; the MCP layer also retries degenerate snapshots on its own.
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        };
        const listener = (id, info) => { if (id === tab.id && info.status === 'complete') finish(); };
        const timer = setTimeout(finish, Number(args.waitMs ?? 8000));
        chrome.tabs.get(tab.id).then((current) => {
          if (current?.status === 'complete') finish();
          else chrome.tabs.onUpdated.addListener(listener);
        }).catch(() => chrome.tabs.onUpdated.addListener(listener));
      });
      // tabs.update() resolves with the *pre-navigation* tab, so re-read it after the load:
      // callers (and their auto-snapshot) should see where we actually ended up.
      const final = await chrome.tabs.get(tab.id).catch(() => null);
      return { ok: true, tabId: tab.id, url: final?.url ?? tab.url, title: final?.title ?? tab.title, loaded: true };
    }
    default:
      throw new Error(`unknown command: ${name}`);
  }
}

/* --------------------------------------------------------------- tab events */

/**
 * Only the shared tab is reported: the agent gets no browsing history for anything else.
 * Returns true when the event was about the shared tab.
 */
async function report(name, tab) {
  if (!enabled) return false;
  const grant = await readGrant();
  if (!grant || !tab || Number(grant.tabId) !== Number(tab.id)) return false;
  send({
    type: 'event',
    name,
    ts: Date.now(),
    tab: { id: tab.id, url: tab.url, title: tab.title, active: tab.active },
  });
  return true;
}

/** A grant is bound to one origin: navigating away revokes it (defense in depth). */
async function enforceGrantOnNavigation(tab) {
  const grant = await readGrant();
  if (!grant || Number(grant.tabId) !== Number(tab.id)) return;
  const policy = await readPolicy();
  const sameOrigin = POLICY.originOf(tab.url) === grant.origin;
  if (!sameOrigin || !POLICY.isDomainAllowed(tab.url, policy.allowDomains, policy.blockDomains)) {
    await writeGrant(null);
    send({
      type: 'event',
      name: 'grant-revoked',
      ts: Date.now(),
      tab: { id: tab.id, url: tab.url, title: tab.title },
      reason: sameOrigin ? '域名策略拒绝' : '导航到了其他站点，共享已自动取消（需要重新共享）',
    });
    return;
  }
  if (tab.title && tab.title !== grant.title) {
    await writeGrant({ ...grant, title: tab.title.slice(0, 120), url: tab.url });
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try { await report('tab-activated', await chrome.tabs.get(tabId)); } catch { /* ignore */ }
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  void report('page-loaded', tab);
  void enforceGrantOnNavigation(tab);
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const grant = await readGrant();
  if (grant && Number(grant.tabId) === Number(tabId)) {
    await writeGrant(null);
    send({ type: 'event', name: 'grant-revoked', ts: Date.now(), tab: { id: tabId }, reason: '共享的标签页已关闭' });
  }
});

/* ------------------------------------------------------- runtime + keepalive */

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.kind === 'status') {
    reply({
      connected: connected(),
      enabled,
      fullAccess,
      transport,
      activeTransport,
      wsUrl: WS_URL,
      nativeHost: NATIVE_HOST,
      lastError,
      grant: sharedGrant,
    });
    return true;
  }
  if (msg?.kind === 'setFullAccess') {
    // User-only escalation: the popup sets this, the bridge has no command for it.
    fullAccess = Boolean(msg.value);
    void chrome.storage.local.set({ fullAccess });
    paintBadge();
    reply({ ok: true, fullAccess });
    return true;
  }
  if (msg?.kind === 'setTransport') {
    transport = ['auto', 'native', 'ws'].includes(msg.transport) ? msg.transport : 'auto';
    void chrome.storage.local.set({ transport });
    resetTransport();
    reply({ ok: true, transport });
    return true;
  }
  if (msg?.kind === 'grantStatus') {
    (async () => {
      const [grant, policy] = await Promise.all([readGrant(), readPolicy()]);
      sharedGrant = grant;
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
      const current = tab
        ? {
          id: tab.id,
          url: tab.url,
          title: tab.title,
          shareable: !POLICY.isProtected(tab.url)
            && POLICY.isDomainAllowed(tab.url, policy.allowDomains, policy.blockDomains),
          alreadyShared: Boolean(grant && Number(grant.tabId) === Number(tab.id)),
        }
        : null;
      reply({ grant, policy, current });
    })().catch((error) => reply({ error: String(error?.message ?? error) }));
    return true;
  }
  if (msg?.kind === 'share') {
    shareTab(msg.tabId)
      .then((grant) => reply({ ok: true, grant }))
      .catch((error) => reply({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }
  if (msg?.kind === 'unshare') {
    writeGrant(null).then(() => reply({ ok: true }));
    return true;
  }
  if (msg?.kind === 'setPolicy') {
    (async () => {
      const policy = {
        allowDomains: POLICY.sanitizeList(msg.allowDomains),
        blockDomains: POLICY.sanitizeList(msg.blockDomains),
      };
      await chrome.storage.local.set(policy);
      // Re-check the current grant against the new rules.
      const grant = await readGrant();
      if (grant) {
        const tab = await chrome.tabs.get(grant.tabId).catch(() => null);
        if (!tab || !POLICY.isDomainAllowed(tab.url, policy.allowDomains, policy.blockDomains)) await writeGrant(null);
      }
      reply({ ok: true, policy });
    })().catch((error) => reply({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }
  if (msg?.kind === 'setEnabled') {
    enabled = Boolean(msg.enabled);
    void chrome.storage.local.set({ enabled });
    if (enabled) {
      retryDelay = 500;
      lastError = null;
      connect();
    } else {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      try { socket?.close(); } catch { /* ignore */ }
      socket = null;
    }
    paintBadge();
    reply({ ok: true, enabled });
    return true;
  }
  if (msg?.kind === 'reconnect') {
    resetTransport();
    reply({ ok: true });
    return true;
  }
  if (msg?.kind === 'push') {
    (async () => {
      const tab = await authorizedTab({});
      const state = await inject(tab.id, 'state', { maxText: 3000 });
      send({ type: 'event', name: 'page-pushed', ts: Date.now(), tab: { id: tab.id, url: tab.url, title: tab.title }, state });
      reply({ ok: true });
    })().catch((error) => reply({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }
  return false;
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
// Chrome suspends the MV3 worker when idle; a 30s alarm is the fastest guaranteed
// wake-up (tab events wake it sooner). Keeps an on-demand bridge reachable.
chrome.alarms.create('page-bridge-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'page-bridge-reconnect') connect(); });

// Bootstrap: the persisted master switch, transport and 完全接管 flag win over defaults.
void Promise.all([
  chrome.storage.local.get({ enabled: true, transport: 'auto', fullAccess: false }),
  readGrant(),
]).then(([stored, grant]) => {
  enabled = stored.enabled !== false;
  transport = ['auto', 'native', 'ws'].includes(stored.transport) ? stored.transport : 'auto';
  fullAccess = stored.fullAccess === true;
  sharedGrant = grant;
  paintBadge();
  if (enabled) connect();
});
