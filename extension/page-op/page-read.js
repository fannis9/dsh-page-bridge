
  const readRoot = (selector) => {
    if (!selector) return document.body ?? document.documentElement;
    return find(selector);
  };

  /** 块级元素：边界要还原成换行，否则整页文本会塌成一行（`innerText` 也是这个语义）。 */
  const BLOCK_TAGS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIALOG', 'DIV',
    'DL', 'DT', 'FIELDCAP', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5',
    'H6', 'HEADER', 'HGROUP', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE',
    'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL']);

  /** Read a composed subtree without losing text rendered inside open shadow roots. */
  const composedText = (root) => {
    const pieces = [];
    const add = (value, preserve = false) => pieces.push({ value: String(value ?? ''), preserve });
    const normalize = () => {
      const out = [];
      for (const piece of pieces) {
        const value = piece.preserve ? piece.value : piece.value.replace(/[ \t\u00a0]+/g, ' ');
        const previous = out.at(-1);
        if (previous && value !== '\n' && previous !== '\n' && !piece.preserve) out.push(' ');
        out.push(value);
      }
      return out.join('').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
    };
    const walk = (node, inheritedPre = false) => {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        if (!parent || visible(parent) || parent.assignedSlot) add(node.nodeValue ?? '', inheritedPre);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE
        && node.nodeType !== Node.DOCUMENT_NODE
        && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return;
        if (tag === 'br') { add('\n'); return; }
        const whiteSpace = getComputedStyle(node).whiteSpace;
        const preformatted = inheritedPre || tag === 'pre'
          || whiteSpace === 'pre' || whiteSpace === 'pre-wrap' || whiteSpace === 'break-spaces';
        const block = BLOCK_TAGS.has(node.tagName);
        if (block) add('\n');
        if (tag === 'slot') {
          const assigned = node.assignedNodes?.({ flatten: true }) ?? [];
          const children = assigned.length ? assigned : (node.childNodes ?? []);
          for (const child of children) walk(child, preformatted);
          if (block) add('\n');
          return;
        }
        // An open shadow tree is the rendered child tree of its host. Do not append the
        // host's light DOM as well, or slotted/component text would be duplicated.
        if (node.shadowRoot) walk(node.shadowRoot, preformatted);
        else for (const child of node.childNodes ?? []) walk(child, preformatted);
        if (block) add('\n');
        return;
      }
      for (const child of node.childNodes ?? []) walk(child, inheritedPre);
    };
    walk(root);
    return normalize();
  };

  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /** Bounded composed-tree HTML serialization; never builds an unbounded full-page string. */
  const boundedHtml = (root, maxBytes, maxNodes) => {
    const state = { chunks: [], length: 0, nodes: 0, truncated: false };
    const encoder = new TextEncoder();
    const append = (value) => {
      if (state.truncated || !value) return;
      const text = String(value);
      const room = maxBytes - state.length;
      if (room <= 0) { state.truncated = true; return; }
      const bytes = encoder.encode(text);
      if (bytes.byteLength <= room) {
        state.chunks.push(text);
        state.length += bytes.byteLength;
        return;
      }
      let low = 0;
      let high = text.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (encoder.encode(text.slice(0, mid)).byteLength <= room) low = mid;
        else high = mid - 1;
      }
      if (low > 0 && low < text.length
        && /[\uD800-\uDBFF]/.test(text[low - 1]) && /[\uDC00-\uDFFF]/.test(text[low])) low -= 1;
      const prefix = text.slice(0, low);
      state.chunks.push(prefix);
      state.length += encoder.encode(prefix).byteLength;
      state.truncated = true;
    };
    const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    const walk = (node) => {
      if (state.truncated || !node) return;
      if (node.nodeType === Node.TEXT_NODE) { append(escapeHtml(node.nodeValue)); return; }
      if (node.nodeType === Node.COMMENT_NODE) { append(`<!--${node.data}-->`); return; }
      if (node.nodeType !== Node.ELEMENT_NODE
        && node.nodeType !== Node.DOCUMENT_NODE
        && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      if (node.nodeType !== Node.ELEMENT_NODE) {
        for (const child of node.childNodes ?? []) walk(child);
        return;
      }
      state.nodes += 1;
      if (state.nodes > maxNodes) { state.truncated = true; return; }
      const shell = node.cloneNode(false).outerHTML;
      const tag = node.tagName.toLowerCase();
      const closeAt = shell.lastIndexOf('</');
      append(closeAt >= 0 ? shell.slice(0, closeAt) : shell);
      if (VOID.has(tag)) return;
      const childRoot = node.shadowRoot;
      if (childRoot) {
        append(`<!-- shadow of <${tag}> -->`);
        for (const child of childRoot.childNodes ?? []) walk(child);
      } else {
        for (const child of node.childNodes ?? []) walk(child);
      }
      append(`</${tag}>`);
    };
    walk(root);
    return { html: state.chunks.join(''), length: state.length, nodes: state.nodes, truncated: state.truncated };
  };

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
    const root = readRoot(args.selector);
    if (!root) return { ok: false, reason: `找不到元素：${args.selector}` };
    const t = composedText(root);
    return { url: location.href, title: document.title, length: t.length, text: t.slice(0, args.max ?? 20000) };
  }

  if (k === 'html') {
    const root = args.selector ? readRoot(args.selector) : document.documentElement;
    if (!root) return { ok: false, reason: `找不到元素：${args.selector}` };
    const maxBytes = Math.max(1024, Math.min(Number(args.max ?? 2_000_000) || 2_000_000, 2_000_000));
    const maxNodes = Math.max(1, Math.min(Number(args.maxNodes ?? 5000) || 5000, 20_000));
    return { url: location.href, selector: args.selector ?? null, maxBytes, maxNodes, ...boundedHtml(root, maxBytes, maxNodes) };
  }
