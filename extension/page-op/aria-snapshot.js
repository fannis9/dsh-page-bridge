
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
   *
   * 定义在区域作用域（而不是 buildAriaSnapshot 内部），因为**执行层也要用同一套判定**：
   * 快照承诺"不可见不给 ref"，而动作发生时要再验一次"现在还可见吗"（TOCTOU）。
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
     * visibilityOf / shown 已经提到区域作用域（执行层也要用同一套判定，见上方注释）。
     */

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
        if (refs < maxRefs) {
          refs += 1;
          // 每次"广告"这个 ref 时刷新签名：模型看到的就是这份签名对应的元素。
          // 动作执行时用它比对，能发现"ref 指向的元素被替换/改写了"。
          el.setAttribute('data-dsh-sig', targetSignature(el));
        } else {
          ref = '';   // 本次快照只广告前 maxRefs 个
        }
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
  