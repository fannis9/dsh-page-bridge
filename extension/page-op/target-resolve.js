
  /**
   * 执行层的目标解析与复核（堵 TOCTOU）。
   *
   * 快照承诺"不可见元素不给 ref"，但那个承诺只在**渲染快照的那一刻**成立：从快照到动作之间，
   * 页面可以把节点隐藏、替换、改写；而且 `data-dsh-ref` 只是 DOM 属性，**页面脚本自己也能改**。
   * 所以每个"要作用于某元素"的动作都重新验一遍：
   *   1. 元素还在文档里（isConnected）—— 否则说明被重渲染掉了；
   *   2. 现在仍然可见（'shown'，与快照同一套三态判定）；
   *   3. 若目标是 ref：快照时记下的签名（role + 文本）仍然匹配，否则 ref 已不代表模型看到的那个元素。
   * 签名缺失（例如页面把属性删了）按失败处理——fail closed。
   *
   * 签名故意自包含（不依赖 nameOf/maxName），因为它的用途是"自己跟自己比"，一致性比称谓准确更重要。
   */
  const targetSignature = (el) => {
    const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
    const text = (el.innerText ?? el.value ?? el.getAttribute('aria-label') ?? '')
      .replace(/\s+/g, ' ').trim().slice(0, 120);
    return `${role}|${text}`;
  };

  /** 从选择器规格里取出 ref（"e12" / "@e12" / "ref=e12"），没有则 null。 */
  const refOf = (spec) => {
    const m = /^@?(?:ref=)?(e\d+)$/i.exec(String(spec ?? '').trim());
    return m ? m[1].toLowerCase() : null;
  };

  const verifyTarget = (el, ref = null) => {
    if (!el) return { ok: false, reason: 'element not found' };
    if (!el.isConnected) {
      return { ok: false, reason: '目标元素已从文档中移除（页面重渲染过），请重新抓快照再操作' };
    }
    if (visibilityOf(el) !== 'shown') {
      return { ok: false, reason: '目标当前不可见（被隐藏/折叠或落在不可见容器里），已拒绝操作；请重新抓快照确认' };
    }
    if (ref) {
      const recorded = el.getAttribute('data-dsh-sig');
      const now = targetSignature(el);
      if (!recorded) {
        return { ok: false, reason: `ref ${ref} 上没有快照签名（元素可能被页面改写过），请重新抓快照` };
      }
      if (recorded !== now) {
        return { ok: false, reason: `ref ${ref} 指向的元素已经变了（快照时「${recorded}」，现在「${now}」），请重新抓快照` };
      }
    }
    return { ok: true };
  };
  