
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
  