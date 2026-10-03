
  if (k === 'click') {
    const el = find(args.selector);
    if (!el) return { ok: false, reason: 'element not found' };
    const guard = verifyTarget(el, refOf(args.selector));
    if (!guard.ok) return guard;
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

  if (k === 'type') {
    const el = find(args.selector);
    if (!el) return { ok: false, reason: 'element not found' };
    const guard = verifyTarget(el, refOf(args.selector));
    if (!guard.ok) return guard;
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
    return { ok: true, tag: el.tagName.toLowerCase(), value: String(el.value ?? value).slice(0, 200), valueLength: String(el.value ?? value).length };
  }

  if (k === 'key') {
    const target = args.selector ? find(args.selector) : (document.activeElement ?? document.body);
    if (args.selector && !target) return { ok: false, reason: `找不到元素：${args.selector}` };
    if (args.selector) {
      const guard = verifyTarget(target, refOf(args.selector));
      if (!guard.ok) return guard;
    }
    return pressKey(target, args.key, args.repeat);
  }

  if (k === 'select') {
    const el = find(args.selector);
    if (!el) return { ok: false, reason: 'element not found' };
    const guard = verifyTarget(el, refOf(args.selector));
    if (!guard.ok) return guard;
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
