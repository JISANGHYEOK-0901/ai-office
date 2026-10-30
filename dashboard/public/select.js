// 네이티브 select는 폼 값/변경 이벤트를 유지하고, 펼침 목록은 같은 DOM·테마로 렌더링한다.
export function installSelects(doc = document) {
  const controls = new WeakMap();
  let serial = 0, opened = null, query = '', queryAt = 0;
  const close = () => {
    if (!opened) return;
    const c = opened; opened = null;
    if (c.menu.hidePopover && c.menu.matches(':popover-open')) c.menu.hidePopover();
    c.menu.hidden = true;
    c.button.setAttribute('aria-expanded', 'false');
    c.button.removeAttribute('aria-activedescendant');
  };
  const place = (c) => {
    const r = c.button.getBoundingClientRect();
    const viewport = doc.defaultView.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const vw = viewport?.width || innerWidth, vh = viewport?.height || innerHeight;
    const width = Math.min(Math.max(r.width, 180), vw - 16);
    const below = top + vh - r.bottom - 12, above = r.top - top - 12;
    const up = below < 160 && above > below;
    c.menu.style.width = `${width}px`;
    c.menu.style.maxHeight = `${Math.max(56, Math.min(300, up ? above : below))}px`;
    c.menu.style.left = `${Math.max(left + 8, Math.min(r.left, left + vw - width - 8))}px`;
    c.menu.style.top = `${up ? Math.max(top + 8, r.top - c.menu.getBoundingClientRect().height - 4) : r.bottom + 4}px`;
  };
  const highlight = (c, index) => {
    const options = [...c.select.options];
    if (!options[index] || options[index].disabled || options[index].hidden) return;
    c.index = index;
    for (const item of c.menu.children) item.classList.toggle('is-focused', Number(item.dataset.index) === index);
    const option = c.menu.querySelector(`[data-index="${index}"]`);
    c.button.setAttribute('aria-activedescendant', option.id);
    option.scrollIntoView({ block: 'nearest' });
  };
  const choose = (c, index) => {
    const option = c.select.options[index];
    if (!option || option.disabled || c.select.disabled) return;
    c.select.value = option.value;
    c.select.dispatchEvent(new Event('input', { bubbles: true }));
    c.select.dispatchEvent(new Event('change', { bubbles: true }));
    close(); c.button.focus({ preventScroll: true });
  };
  const sync = (c) => {
    const text = c.select.selectedOptions[0]?.textContent || '선택';
    if (c.button.textContent !== text) c.button.textContent = text;
    const disabled = c.select.disabled || Boolean(c.select.closest('fieldset:disabled'));
    if (c.button.disabled !== disabled) c.button.disabled = disabled;
    if (c.button.hidden !== c.select.hidden) c.button.hidden = c.select.hidden;
    const label = c.select.getAttribute('aria-label') || [...c.select.labels].map((l) => [...l.childNodes]
      .filter((n) => n !== c.select && n !== c.button).map((n) => n.textContent).join(' ').trim()).join(' ') || '항목 선택';
    if (c.button.getAttribute('aria-label') !== label) c.button.setAttribute('aria-label', label);
    if (c.select.getAttribute('aria-describedby') && c.button.getAttribute('aria-describedby') !== c.select.getAttribute('aria-describedby')) c.button.setAttribute('aria-describedby', c.select.getAttribute('aria-describedby'));
    c.button.className = `select-trigger ${c.select.className.replace(/\bselect-native\b/g, '')}`;
    if (opened === c && (c.button.disabled || !c.button.getClientRects().length)) close();
    if (opened === c) {
      // 폴링 중 같은 목록을 다시 만들지 않아 키보드/스크롤 위치를 보존한다.
      const signature = [...c.select.options].map((o) => `${o.value}\0${o.textContent}\0${o.disabled}\0${o.hidden}`).join('\n');
      if (signature !== c.signature) { renderOptions(c); highlight(c, c.select.selectedIndex); }
      for (const item of c.menu.children) item.setAttribute('aria-selected', String(Number(item.dataset.index) === c.select.selectedIndex));
    }
  };
  const renderOptions = (c) => {
    c.signature = [...c.select.options].map((o) => `${o.value}\0${o.textContent}\0${o.disabled}\0${o.hidden}`).join('\n');
    c.menu.replaceChildren(...[...c.select.options].map((option, index) => {
      const item = doc.createElement('div');
      item.id = `${c.menu.id}-${index}`; item.role = 'option'; item.dataset.index = index;
      item.textContent = option.textContent; item.hidden = option.hidden;
      item.setAttribute('aria-selected', String(index === c.select.selectedIndex));
      item.setAttribute('aria-disabled', String(option.disabled));
      item.addEventListener('pointermove', () => highlight(c, index));
      item.addEventListener('click', () => choose(c, index));
      return item;
    }));
  };
  const open = (c) => {
    if (c.button.disabled) return;
    close(); query = ''; opened = c;
    // 모달 밖의 요소는 top layer여도 inert다. 모달 안에서 연 목록은 그 모달에 속해야 한다.
    const host = c.button.closest('dialog') || doc.body;
    if (c.menu.parentElement !== host) host.append(c.menu);
    renderOptions(c); c.menu.hidden = false;
    if (c.menu.showPopover) c.menu.showPopover();
    c.button.setAttribute('aria-expanded', 'true');
    place(c);
    highlight(c, c.select.selectedIndex >= 0 ? c.select.selectedIndex : 0);
  };
  const upgrade = (select) => {
    if (controls.has(select) || select.multiple || select.size > 1) return;
    const button = doc.createElement('button'), menu = doc.createElement('div');
    button.type = 'button'; button.role = 'combobox';
    menu.id = `select-list-${++serial}`; menu.role = 'listbox'; menu.className = 'select-menu';
    menu.setAttribute('popover', 'manual'); menu.hidden = true;
    button.setAttribute('aria-controls', menu.id); button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-haspopup', 'listbox');
    button.dataset.select = select.id || select.name;
    select.classList.add('select-native'); select.tabIndex = -1;
    select.after(button); doc.body.append(menu);
    const c = { select, button, menu, index: select.selectedIndex };
    controls.set(select, c);
    // 기존 select.value 대입도 즉시 반영한다. 폼 값의 정본은 네이티브 요소다.
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(select, 'value', { configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) { descriptor.set.call(this, value); sync(c); } });
    button.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); if (opened === c) close(); else open(c); });
    button.addEventListener('keydown', (ev) => {
      const options = [...select.options];
      const enabled = options.map((o, i) => !o.disabled && !o.hidden ? i : -1).filter((i) => i >= 0);
      if (!enabled.length) return;
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) {
        ev.preventDefault(); if (opened !== c) open(c);
        const at = enabled.indexOf(c.index);
        highlight(c, ev.key === 'Home' ? enabled[0] : ev.key === 'End' ? enabled.at(-1)
          : enabled[Math.max(0, Math.min(enabled.length - 1, at + (ev.key === 'ArrowDown' ? 1 : -1)))]);
      } else if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault(); if (opened === c) choose(c, c.index); else open(c);
      } else if (ev.key === 'Escape' || ev.key === 'Tab') close();
      else if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        ev.preventDefault(); if (opened !== c) open(c);
        query = (Date.now() - queryAt < 800 ? query : '') + ev.key.toLocaleLowerCase(); queryAt = Date.now();
        const match = enabled.find((i) => options[i].textContent.trim().toLocaleLowerCase().startsWith(query));
        if (match !== undefined) highlight(c, match);
      }
    });
    select.addEventListener('change', () => sync(c));
    select.addEventListener('invalid', (ev) => { ev.preventDefault(); button.focus(); });
    sync(c);
  };
  const refresh = () => {
    if (opened && !opened.button.isConnected) { const c = opened; close(); c.menu.remove(); }
    for (const select of doc.querySelectorAll('select')) { upgrade(select); const c = controls.get(select); if (c) sync(c); }
    for (const menu of doc.querySelectorAll('.select-menu')) {
      if (!doc.querySelector(`[aria-controls="${menu.id}"]`)) menu.remove();
    }
  };
  new MutationObserver(refresh).observe(doc.body, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['disabled', 'hidden', 'selected', 'label', 'aria-label'] });
  doc.addEventListener('pointerdown', (ev) => { if (opened && !opened.button.contains(ev.target) && !opened.menu.contains(ev.target)) close(); });
  doc.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && opened) { close(); ev.preventDefault(); ev.stopPropagation(); } }, true);
  doc.addEventListener('scroll', (ev) => { if (opened && !opened.menu.contains(ev.target)) close(); }, true);
  doc.addEventListener('reset', () => queueMicrotask(refresh));
  doc.addEventListener('close', close, true);
  doc.defaultView.addEventListener('resize', close);
  refresh();
  return { refresh, close };
}
