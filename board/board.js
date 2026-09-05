/* The board, v2 - the founder's approval desk.
   Every tap is a decision: kept on this device (localStorage), posted to his inbox (FormSubmit, read by
   Claude with the Gmail connector) and, when a token is connected, committed to the site repo as
   decisions/latest.json. `python lotset.py sync` reads them back into the pipeline.
   Decisions carry a timestamp; anything at or before the poster's `synced` time is already in the
   built page and is dropped from the overlay on load, so the page never argues with itself. */
(function () {
  'use strict';
  const D = JSON.parse(document.getElementById('board-data').textContent || '{}');
  const KEY = 'lomb.decisions.v1', TOK = 'lomb.gh.token', SENT = 'lomb.sent.v1', GH = 'lomb.gh.v1', DIRTY = 'lomb.dirty.v1';
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.prototype.slice.call((el || document).querySelectorAll(s));
  const UP = D.kind === 'poster' ? '../' : '';
  const nowISO = () => new Date().toISOString();
  const hhmm = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
  const dmy = iso => iso ? new Date(iso).toLocaleDateString([], { day: '2-digit', month: 'short' }) + ' ' + hhmm(iso) : '—';
  const slug = s => String(s).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 80);

  function h(tag, attrs) {
    const el = document.createElement(tag);
    attrs = attrs || {};
    for (const k in attrs) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'data') for (const d in v) el.dataset[d] = v[d];
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) c.forEach(x => x && el.appendChild(typeof x === 'string' ? document.createTextNode(x) : x));
      else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  // ---------------------------------------------------------------- store
  function deviceName() {
    const u = navigator.userAgent;
    return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'PC' : 'device';
  }
  function load() {
    try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.v === 1) return s; } catch (e) { }
    return { v: 1, savedAt: null, device: deviceName(), posters: {} };
  }
  let S = load();
  let sent = null, gh = null;
  try { sent = JSON.parse(localStorage.getItem(SENT)); } catch (e) { }
  try { gh = JSON.parse(localStorage.getItem(GH)); } catch (e) { }
  let dirty = false, sendTimer = null, ghTimer = null;
  try { dirty = localStorage.getItem(DIRTY) === '1'; } catch (e) { }
  function setDirty(v) { dirty = v; try { localStorage.setItem(DIRTY, v ? '1' : '0'); } catch (e) { } }
  function P(key) {
    if (!S.posters[key]) S.posters[key] = { verdicts: {}, order: null, orderAt: null, added: [], sheet: null };
    const p = S.posters[key];
    p.verdicts = p.verdicts || {}; p.added = p.added || [];
    return p;
  }
  function save() {
    S.savedAt = nowISO();
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { }
    setDirty(true); scheduleSync(); renderTitleblock();
  }
  function pruneSynced() {
    // drop what the built page already carries
    const list = D.kind === 'poster' ? [{ key: D.key, synced: D.synced }] : (D.posters || []);
    list.forEach(function (x) {
      if (!x.synced || !S.posters[x.key]) return;
      const s = Date.parse(x.synced), p = P(x.key);
      Object.keys(p.verdicts).forEach(id => { if (!(Date.parse(p.verdicts[id].at) > s)) delete p.verdicts[id]; });
      if (p.orderAt && !(Date.parse(p.orderAt) > s)) { p.order = null; p.orderAt = null; }
      p.added = p.added.filter(a => Date.parse(a.at) > s);
      if (p.sheet && !(Date.parse(p.sheet.at) > s)) p.sheet = null;
    });
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { }
  }
  pruneSynced();
  const token = () => { try { return localStorage.getItem(TOK) || ''; } catch (e) { return ''; } };

  const KEYTOK = /^(tl|tr|bl|br|pro|nb2|flat|side|model|layered|noir|unframed|r[1-6]|\d+)$/;
  function fmtId(id) {
    const el = h('span', { class: 'fid' });
    String(id).split('-').forEach((t, i, a) => { el.appendChild(KEYTOK.test(t) ? h('b', { text: t }) : document.createTextNode(t)); if (i < a.length - 1) el.appendChild(document.createTextNode('-')); });
    return el;
  }
  // ---------------------------------------------------------------- poster model
  const p = D.kind === 'poster' ? P(D.key) : null;
  function archiveShot(a) {
    return { id: a.id, file: a.src, recipe: 'archive', recipeLabel: 'from the archive · ' + a.label, group: 'archive', model: '',
      founder: 'approved', note: a.note || '', thumb: a.thumb, inspect: a.inspect || a.thumb, w: a.w, h: a.h, archive: true, src: a.src };
  }
  const allShots = () => D.shots.concat(p.added.map(archiveShot));
  const byId = id => allShots().find(s => s.id === id);
  const ev = id => (p.verdicts[id] && p.verdicts[id].v) || (byId(id) || {}).founder || 'pending';
  const noteOf = id => (p.verdicts[id] && p.verdicts[id].note) || (byId(id) || {}).note || '';
  function order() {
    const ap = allShots().filter(s => ev(s.id) === 'approved').map(s => s.id);
    const base = (p.order || D.order || []).filter(id => ap.indexOf(id) >= 0);
    return base.concat(ap.filter(id => base.indexOf(id) < 0));
  }
  function setOrder(list) { p.order = list; p.orderAt = nowISO(); save(); }
  // founder 2026-09-04: "each 3rd and last photos are house photos ... we upload all of them, not just 6, so
  // second house photo is like 18th or whatever" - so: his first two, house one, every other kept shot, house two last
  function uploadList() {
    const o = order().slice(), hs = (D.house || []).slice(0, 2), up = [];
    up.push(o.length ? { id: o.shift() } : { empty: true, label: 'the cover' });
    up.push(o.length ? { id: o.shift() } : { empty: true, label: 'second' });
    if (hs[0]) up.push({ house: hs[0] });
    o.forEach(id => up.push({ id: id }));
    if (hs[1]) up.push({ house: hs[1], last: true });
    return up;
  }
  function counts() {
    const c = { approved: 0, pending: 0, rejected: 0, total: 0 };
    allShots().forEach(s => { c[ev(s.id)]++; c.total++; });
    return c;
  }
  function verdict(id, v, opts) {
    opts = opts || {};
    const s = byId(id); if (!s) return;
    const prev = ev(id), prevNote = noteOf(id);
    if (s.archive && v !== 'approved') {           // an archive add is removed, not rejected
      p.added = p.added.filter(a => a.id !== id); delete p.verdicts[id];
      p.order = order().filter(x => x !== id); p.orderAt = nowISO(); save(); render();
      if (!opts.quiet) toast(s.id + ' · removed from the lot', { label: 'Undo', fn: () => { p.added.push(s._raw || addedRaw(s)); save(); render(); } });
      return;
    }
    p.verdicts[id] = { v: v, at: nowISO(), note: opts.note !== undefined ? opts.note : ((p.verdicts[id] && p.verdicts[id].note) || '') };
    let o = order();
    if (v === 'approved') { if (o.indexOf(id) < 0) o.push(id); } else o = o.filter(x => x !== id);
    p.order = o; p.orderAt = nowISO();
    save(); render();
    if (!opts.quiet) toast(id + ' · ' + ({ approved: 'kept', rejected: 'dropped · why?', pending: 'back to waiting' })[v], {
      label: 'Undo', fn: () => verdict(id, prev, { quiet: true, note: prevNote }), chips: v === 'rejected', id: id
    });
  }
  function addedRaw(s) { return { id: s.id, src: s.src, label: s.recipeLabel.replace('from the archive · ', ''), thumb: s.thumb, inspect: s.inspect, w: s.w, h: s.h, at: nowISO() }; }
  function setNote(id, note, opts) {
    const cur = p.verdicts[id] || { v: ev(id), at: nowISO() };
    p.verdicts[id] = { v: cur.v, at: nowISO(), note: note };
    save(); if (!(opts && opts.quiet)) renderGrid();
  }
  function sheetStatus() { return p.sheet ? p.sheet.v : (D.stageIdx >= 1 ? 'approved' : 'pending'); }

  // ---------------------------------------------------------------- toast
  let toastTimer = null;
  const REASONS = [['artifact', 'artifact'], ['excessive', 'excessive'], ['off-look', 'off look'], ['note', 'note…']];
  function toast(msg, act) {
    const t = $('#toast'); if (!t) return;
    t.innerHTML = ''; t.appendChild(h('span', { text: msg }));
    if (act && act.chips) {
      const row = h('span', { class: 'chips' });
      REASONS.forEach(function (r) { row.appendChild(h('button', { type: 'button', class: 'chip-r', text: r[1], onclick: () => { if (r[0] === 'note') { hideToast(); openRoom([byId(act.id)], 0); } else { setNote(act.id, r[0]); hideToast(); toast(act.id + ' · ' + r[1]); } } })); });
      t.appendChild(row);
    }
    if (act && act.label) t.appendChild(h('button', { type: 'button', text: act.label, onclick: () => { act.fn(); hideToast(); } }));
    t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, act ? (act.chips ? 8000 : 5000) : 2600);
  }
  function hideToast() { const t = $('#toast'); if (t) t.classList.remove('on'); }

  // ---------------------------------------------------------------- render: poster page
  function render() { if (D.kind !== 'poster') { renderIndex(); renderTitleblock(); return; } renderGate(); renderOrder(); renderTools(); renderGrid(); renderTitleblock(); }

  function renderGate() {
    const g = $('#gate-sheet'); if (!g) return; g.innerHTML = '';
    const st = sheetStatus();
    if (st === 'pending') {
      const note = h('textarea', { placeholder: 'A note with it, if you like (why, or what to change)', rows: 2 });
      g.appendChild(h('div', { class: 'verdict' },
        h('button', { class: 'btn keep big', type: 'button', onclick: () => { p.sheet = { v: 'approved', at: nowISO(), note: note.value.trim() }; save(); renderGate(); renderTitleblock(); toast('Sheet approved · the set can be built', { label: 'Undo', fn: () => { p.sheet = null; save(); renderGate(); } }); } }, h('span', { class: 'x', text: '✓' }), 'Approve the sheet'),
        h('button', { class: 'btn drop big', type: 'button', onclick: () => { p.sheet = { v: 'rejected', at: nowISO(), note: note.value.trim() }; save(); renderGate(); renderTitleblock(); toast('Sheet sent back' + (note.value.trim() ? ' with your note' : ''), { label: 'Undo', fn: () => { p.sheet = null; save(); renderGate(); } }); } }, h('span', { class: 'x', text: '✗' }), 'Not yet'),
        h('span', { class: 'hint', text: 'Nothing is spent until you approve it.' })));
      g.appendChild(note);
    } else {
      const local = !!p.sheet;
      g.appendChild(h('span', { class: 'chip ' + (st === 'approved' ? 'ok' : 'no') + (local ? ' unsynced' : ''), text: st === 'approved' ? 'Sheet approved' : 'Sheet sent back' }));
      if (local && p.sheet.note) g.appendChild(h('span', { class: 'hint', text: '“' + p.sheet.note + '”' }));
      if (local) g.appendChild(h('button', { class: 'btn quiet', type: 'button', text: 'Change', onclick: () => { p.sheet = null; save(); renderGate(); } }));
      else if (D.sheet.approval && D.sheet.approval.note) g.appendChild(h('span', { class: 'hint', text: '“' + D.sheet.approval.note + '”' }));
    }
  }

  function renderOrder() {
    const strip = $('#order'); if (!strip) return; strip.innerHTML = '';
    const o = order(), u = uploadList();
    const slotOf = function (id, i) {
      const s = byId(id); if (!s) return null;
      const k = o.indexOf(id);
      return h('div', { class: 'slot' + (i === 0 ? ' cover' : ''), data: { id: id } },
        h('div', { class: 'simg' },
          h('img', { src: UP + s.thumb, alt: id, loading: 'lazy', decoding: 'async', onclick: () => openRoom(o.map(byId), k) }),
          h('span', { class: 'num', text: i + 1 }),
          i === 0 ? h('span', { class: 'coverlab', text: 'cover' }) : null),
        h('div', { class: 'sid', title: id }, fmtId(id)),
        h('div', { class: 'sacts' },
          h('button', { type: 'button', 'aria-label': 'Move earlier', text: '←', disabled: k === 0 || null, onclick: () => move(id, -1) }),
          h('button', { type: 'button', class: 'handle', 'aria-label': 'Drag to reorder', text: '⋮⋮' }),
          h('button', { type: 'button', 'aria-label': 'Move later', text: '→', disabled: k === o.length - 1 || null, onclick: () => move(id, 1) })));
    };
    u.forEach(function (x, i) {
      if (x.house) {
        strip.appendChild(h('div', { class: 'slot house' },
          h('div', { class: 'simg' }, h('img', { src: UP + x.house.thumb, alt: x.house.id, loading: 'lazy', decoding: 'async', onclick: () => openRoom((D.house || []).map(hh => ({ id: hh.id, inspect: hh.inspect, label: hh.label })), (D.house || []).indexOf(x.house), { readonly: true }) }), h('span', { class: 'num', text: i + 1 }), h('span', { class: 'coverlab lock', text: x.last ? '⌂ house · last' : '⌂ house · third' })),
          h('div', { class: 'sid', text: x.house.label })));
      } else if (x.empty) {
        strip.appendChild(h('div', { class: 'slot empty' }, h('div', { class: 'simg' }, h('span', { class: 'num', text: i + 1 })), h('div', { class: 'sid', text: x.label })));
      } else {
        const el = slotOf(x.id, i); if (el) strip.appendChild(el);
      }
    });
    enableDrag(strip);
    // founder, 2026-09-05: the lot in order IS the judging place - every shot, kept ones above in
    // his order, then the waiting, then the dropped; Keep / Drop and a note on each row
    const list = $('#lotlist');
    if (list) {
      list.innerHTML = '';
      const kept = o.map(byId).filter(Boolean);
      const rest = allShots().filter(s => o.indexOf(s.id) < 0);
      const waiting = rest.filter(s => ev(s.id) === 'pending'), dropped = rest.filter(s => ev(s.id) === 'rejected');
      const row = function (s, pos) {
        const v = ev(s.id), note = noteOf(s.id);
        const ta = h('textarea', { class: 'lnote', placeholder: 'A note on this one, if you like', rows: 1, oninput: e => setNote(s.id, e.target.value, { quiet: true }), onchange: e => setNote(s.id, e.target.value.trim(), { quiet: true }) });
        ta.value = note;
        return h('div', { class: 'lrow ' + ({ approved: 'ok', rejected: 'no', pending: 'wait' })[v], data: { id: s.id } },
          h('div', { class: 'limg' }, h('img', { src: UP + s.thumb, alt: s.id, loading: 'lazy', decoding: 'async', onclick: () => openRoom(kept.concat(waiting, dropped), kept.concat(waiting, dropped).findIndex(x => x.id === s.id)) }),
            pos >= 0 ? h('span', { class: 'num' + (pos === 0 ? ' cover' : ''), text: pos === 0 ? 'cover' : String(pos + 1) }) : null),
          h('div', { class: 'lmeta' },
            h('div', { class: 'tid' }, fmtId(s.id)),
            h('div', { class: 'trec', text: s.recipeLabel + (s.model ? ' \u00b7 ' + s.model.replace('nano-banana-', 'nb-').replace('-edit', '') : '') }),
            ta),
          h('div', { class: 'lacts' },
            h('button', { type: 'button', class: 'k' + (v === 'approved' ? ' on' : ''), onclick: () => verdict(s.id, v === 'approved' ? 'pending' : 'approved') }, h('span', { class: 'x', text: '\u2713' }), v === 'approved' ? 'Kept' : 'Keep'),
            h('button', { type: 'button', class: 'd' + (v === 'rejected' ? ' on' : ''), onclick: () => verdict(s.id, v === 'rejected' ? 'pending' : 'rejected') }, h('span', { class: 'x', text: '\u2717' }), s.archive ? 'Remove' : (v === 'rejected' ? 'Dropped' : 'Drop')),
            pos >= 0 ? h('span', { class: 'lmove' },
              h('button', { type: 'button', 'aria-label': 'Move earlier', text: '\u2190', disabled: pos === 0 || null, onclick: () => move(s.id, -1) }),
              h('button', { type: 'button', 'aria-label': 'Move later', text: '\u2192', disabled: pos === o.length - 1 || null, onclick: () => move(s.id, 1) })) : null));
      };
      if (kept.length) list.appendChild(h('div', { class: 'lhead', text: kept.length + ' kept, in your order' }));
      kept.forEach((s, i) => list.appendChild(row(s, i)));
      if (waiting.length) list.appendChild(h('div', { class: 'lhead', text: waiting.length + ' waiting for your word' }));
      waiting.forEach(s => list.appendChild(row(s, -1)));
      if (dropped.length) list.appendChild(h('div', { class: 'lhead', text: dropped.length + ' dropped' }));
      dropped.forEach(s => list.appendChild(row(s, -1)));
    }
    const ot = $('#ordertools'); if (ot) {
      ot.innerHTML = '';
      const total = u.filter(x => !x.empty).length;
      ot.appendChild(h('span', { class: 'hint count', text: total + ' go up · ' + o.length + ' of yours, the house third and last' + (o.length ? '' : ' · keep shots below and they line up here') }));
      if (D.download && D.download.zip) ot.appendChild(h('a', { class: 'btn', href: UP + D.download.zip, download: '', text: '⤓ Full size for posting · ' + D.download.n + ' files · ' + D.download.mb + ' MB', title: 'the files as they go up, numbered in this order' }));
      if (D.download && D.download.zip && p.orderAt && Date.parse(p.orderAt) > Date.parse(D.synced || 0)) ot.appendChild(h('span', { class: 'hint', text: 'the zip follows the order as last sent - Send, and it is rebuilt' }));
      if (o.length) ot.appendChild(h('button', { class: 'btn quiet', type: 'button', text: '▣ Preview the lot as Catawiki shows it', onclick: openPreview }));
    }
  }
  function openPreview() {
    closeRoom(); hideToast();
    const o = order().map(byId).filter(Boolean); if (!o.length) return;
    const six = uploadList().filter(x => !x.empty).map(x => x.house ? { id: x.house.id, thumb: x.house.thumb, inspect: x.house.inspect } : byId(x.id));
    const el = h('div', { class: 'room preview', role: 'dialog', 'aria-modal': 'true' });
    el.appendChild(h('div', { class: 'bar' }, h('span', { class: 'id', text: 'The lot · as Catawiki shows it' }), h('button', { class: 'x', type: 'button', text: '×', 'aria-label': 'Close', onclick: closeRoom })));
    const stage = h('div', { class: 'stage' });
    const all = six.map(x => byId(x.id) || x);
    stage.appendChild(h('div', { class: 'cover' }, h('img', { src: UP + six[0].inspect, alt: six[0].id, onclick: () => openRoom(all, 0, { readonly: true }) })));
    stage.appendChild(h('div', { class: 'thumbs' }, six.map((s, i) => h('img', { src: UP + s.thumb, alt: s.id, class: i === 0 ? 'on' : '', onclick: () => openRoom(all, i, { readonly: true }) }))));
    stage.appendChild(h('div', { class: 'ptitle', text: D.kitTitle || (D.name + ' · ' + D.collLabel) }));
    stage.appendChild(h('div', { class: 'pnote', text: six.length + ' photographs go up in this order; the first is the cover, the house is third and last.' }));
    el.appendChild(stage);
    el.appendChild(h('div', { class: 'foot' }, h('button', { type: 'button', text: 'done', onclick: closeRoom })));
    document.body.appendChild(el); document.body.classList.add('locked');
    room = { el: el, key: e => { if (e.key === 'Escape') closeRoom(); } };
  }
  function move(id, dir) {
    const o = order(), i = o.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= o.length) return;
    o.splice(i, 1); o.splice(j, 0, id); setOrder(o); renderOrder(); renderGrid();
    if (j === 0) toast(id + ' is the cover');
  }
  let dragBound = null;
  function enableDrag(strip) {
    if (dragBound === strip) return; dragBound = strip;
    let drag = null;
    strip.addEventListener('pointerdown', function (e) {
      const handle = e.target.closest('.handle'); if (!handle) return;
      const slot = handle.closest('.slot'); e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch (x) { }
      drag = { id: slot.dataset.id, slot: slot, x: e.clientX, y: e.clientY, over: null };
      slot.classList.add('drag');
    });
    strip.addEventListener('pointermove', function (e) {
      if (!drag) return; e.preventDefault();
      drag.slot.style.transform = 'translate(' + (e.clientX - drag.x) + 'px,' + (e.clientY - drag.y) + 'px)';
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const over = el && el.closest('.slot');
      $$('.slot.over', strip).forEach(s => s.classList.remove('over', 'after'));
      if (over && over !== drag.slot) {
        const r = over.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
        over.classList.add('over'); if (after) over.classList.add('after');
        drag.over = { id: over.dataset.id, after: after };
      } else drag.over = null;
      const sr = strip.getBoundingClientRect();
      if (e.clientX > sr.right - 44) strip.scrollLeft += 10; else if (e.clientX < sr.left + 44) strip.scrollLeft -= 10;
    });
    const end = function () {
      if (!drag) return;
      const o = order(); let list = o;
      if (drag.over) { list = o.filter(x => x !== drag.id); list.splice(list.indexOf(drag.over.id) + (drag.over.after ? 1 : 0), 0, drag.id); }
      drag.slot.classList.remove('drag'); drag.slot.style.transform = '';
      $$('.slot.over', strip).forEach(s => s.classList.remove('over', 'after'));
      const changed = list.join() !== o.join(); drag = null;
      if (changed) { setOrder(list); renderOrder(); renderGrid(); toast('Order updated'); }
    };
    strip.addEventListener('pointerup', end); strip.addEventListener('pointercancel', end);
  }

  let filter = 'all', group = 'all', compareMode = false, picks = [];
  if (D.kind === 'poster') { const c0 = counts(); if (c0.pending && (c0.approved + c0.rejected) && !location.hash) filter = 'pending'; }
  function renderTools() {
    const t = $('#tools'); if (!t) return; t.innerHTML = '';
    const c = counts();
    if (c.pending) t.appendChild(h('button', { class: 'btn primary big', type: 'button', onclick: openReview }, 'Review · ', h('span', { class: 'n', text: c.pending }), ' waiting'));
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Filter' });
    [['all', 'All', c.total], ['pending', 'Waiting', c.pending], ['approved', 'Kept', c.approved], ['rejected', 'Dropped', c.rejected]].forEach(function (f) {
      seg.appendChild(h('button', { type: 'button', class: filter === f[0] ? 'on' : '', onclick: () => { filter = f[0]; renderTools(); renderGrid(); } }, f[1], h('span', { class: 'n', text: f[2] })));
    });
    t.appendChild(seg);
    const groups = [{ key: 'all', label: 'Every kind' }].concat(D.groups.filter(g => allShots().some(s => s.group === g.key)));
    if (p.added.length) groups.push({ key: 'archive', label: 'From the archive' });
    const sel = h('select', { 'aria-label': 'Kind', onchange: e => { group = e.target.value; renderGrid(); } });
    groups.forEach(g => sel.appendChild(h('option', { value: g.key, selected: group === g.key || null, text: g.label })));
    t.appendChild(sel);
    t.appendChild(h('div', { class: 'spacer' }));
    t.appendChild(h('button', { class: 'btn quiet' + (compareMode ? ' primary' : ''), type: 'button', text: compareMode ? 'Pick two…' : 'Compare', onclick: () => { compareMode = !compareMode; picks = []; renderTools(); renderGrid(); if (compareMode) toast('Tap two photos to compare'); } }));
    t.appendChild(h('button', { class: 'btn', type: 'button', text: '+ Add from the archive', onclick: openArchive }));
    if (c.pending && c.approved >= 4) t.appendChild(h('button', { class: 'btn quiet', type: 'button', text: 'Drop all ' + c.pending + ' still waiting', onclick: dropRest }));
  }
  function dropRest() {
    const ids = allShots().filter(s => ev(s.id) === 'pending').map(s => s.id);
    const prev = ids.map(id => [id, p.verdicts[id]]);
    ids.forEach(id => { p.verdicts[id] = { v: 'rejected', at: nowISO(), note: (p.verdicts[id] && p.verdicts[id].note) || '' }; });
    save(); render();
    toast(ids.length + ' dropped · the lot stays as it is', { label: 'Undo', fn: () => { prev.forEach(x => { if (x[1]) p.verdicts[x[0]] = x[1]; else delete p.verdicts[x[0]]; }); save(); render(); } });
  }

  function renderGrid() {
    const g = $('#grid'); if (!g) { renderOrder(); return; } g.innerHTML = '';
    const o = order();
    allShots().filter(s => (filter === 'all' || ev(s.id) === filter) && (group === 'all' || s.group === group)).forEach(function (s) {
      const v = ev(s.id), pos = o.indexOf(s.id), note = noteOf(s.id);
      const tile = h('figure', { class: 'tile ' + ({ approved: 'ok', rejected: 'no', pending: 'wait' })[v] + (picks.indexOf(s.id) >= 0 ? ' pick' : ''), data: { id: s.id } },
        h('a', { class: 'timg', href: UP + s.inspect, style: s.w && s.h ? 'aspect-ratio:' + s.w + '/' + s.h : '', onclick: e => { e.preventDefault(); if (compareMode) pick(s.id); else openRoom(visible(), visible().findIndex(x => x.id === s.id)); } },
          h('img', { src: UP + s.thumb, width: s.w || null, height: s.h || null, alt: s.id, loading: 'lazy', decoding: 'async' }),
          v === 'approved' && pos >= 0 ? h('span', { class: 'num' + (pos === 0 ? ' cover' : ''), text: pos === 0 ? 'cover' : String(pos + 1), title: 'position ' + (pos + 1) + ' in the lot' }) : null,
          s.archive ? h('span', { class: 'tag', text: 'archive' }) : (p.verdicts[s.id] ? h('span', { class: 'tag', text: 'changed' }) : null)),
        h('figcaption', { class: 'tmeta' },
          h('div', { class: 'tid' }, fmtId(s.id)),
          h('div', { class: 'trec', text: s.recipeLabel + (s.model ? ' · ' + s.model.replace('nano-banana-', 'nb-').replace('-edit', '') : '') }),
          note ? h('div', { class: 'tnote', text: '“' + note + '”' }) : null),
        h('div', { class: 'tacts' },
          h('button', { type: 'button', class: 'k' + (v === 'approved' ? ' on' : ''), onclick: () => verdict(s.id, v === 'approved' ? 'pending' : 'approved') }, h('span', { class: 'x', text: '✓' }), v === 'approved' ? 'Kept' : 'Keep'),
          h('button', { type: 'button', class: 'd' + (v === 'rejected' ? ' on' : ''), onclick: () => verdict(s.id, v === 'rejected' ? 'pending' : 'rejected') }, h('span', { class: 'x', text: '✗' }), s.archive ? 'Remove' : (v === 'rejected' ? 'Dropped' : 'Drop'))));
      g.appendChild(tile);
    });
  }
  function visible() { return allShots().filter(s => (filter === 'all' || ev(s.id) === filter) && (group === 'all' || s.group === group)); }
  function pick(id) {
    if (picks.indexOf(id) >= 0) picks = picks.filter(x => x !== id); else picks.push(id);
    if (picks.length === 2) { openCompare(byId(picks[0]), byId(picks[1])); picks = []; compareMode = false; renderTools(); }
    renderGrid();
  }

  // ---------------------------------------------------------------- render: index
  function overlayCounts(x) {
    const q = S.posters[x.key];
    const c = { approved: 0, pending: 0, rejected: 0, total: 0 };
    x.shots.forEach(s => { const v = (q && q.verdicts[s.id] && q.verdicts[s.id].v) || s.founder; c[v]++; c.total++; });
    if (q) q.added.forEach(() => { c.approved++; c.total++; });
    return c;
  }
  function renderIndex() {
    const turn = $('#turn'); if (!turn) return; turn.innerHTML = '';
    (D.posters || []).forEach(function (x) {
      const q = S.posters[x.key], c = overlayCounts(x);
      const el = $('[data-counts="' + x.key + '"]');
      if (el) el.innerHTML = '<b>' + c.approved + '</b> approved · <b>' + c.pending + '</b> waiting · <b>' + c.rejected + '</b> rejected' + (q && (Object.keys(q.verdicts).length || q.added.length || q.sheet) ? ' · <span class="tinted">edited here</span>' : '');
      const sheetPending = x.stageIdx === 0 && !(q && q.sheet);
      const card = (title, sub, go, href) => turn.appendChild(h('a', { class: 'tcard', href: href, style: '--tint:' + x.tint[0] + ';--tint-deep:' + x.tint[1] + ';--tint-ink:' + x.tint[2] },
        h('img', { src: x.sheet, alt: '', loading: 'lazy' }), h('span', { class: 'tt' }, h('b', { text: x.name }), h('span', { text: sub })), h('span', { class: 'go' }, h('span', { class: 'btn primary', text: go }))));
      if (sheetPending) card(x.name, x.collLabel + ' · the sheet waits for your word', 'Approve the sheet', 'posters/' + x.key + '.html#sheet');
      if (c.pending) card(x.name, x.collLabel + ' · ' + c.pending + ' shots waiting', 'Judge ' + c.pending + ' in the lot', 'posters/' + x.key + '.html#sec-order');
      else if (x.stageIdx === 3) card(x.name, x.collLabel + ' · ' + c.approved + ' kept, order set, files zipped', 'Ready to post', 'posters/' + x.key + '.html#sec-post');
      else if (x.stageIdx === 4 && x.lot) card(x.name, x.collLabel + ' · drafted on Catawiki as lot ' + x.lot + ' · Submit is yours', 'Submit on Catawiki', 'https://www.catawiki.com/en/v/lot/' + x.lot + '/edit');
      else if (c.approved >= 4 && x.stageIdx < 3) card(x.name, x.collLabel + ' · ' + c.approved + ' kept, order set', 'Check the order', 'posters/' + x.key + '.html#order');
    });
  }

  // ---------------------------------------------------------------- the room (lightbox)
  let room = null, roomStack = [];
  function attachZoom(stage, img, opts) {
    // founder 2026-09-04: "when I zoom in it migrates to the upper left corner" - the review card had no zoom at
    // all, so a pinch became a swipe. One helper now serves the room and the review card: two fingers pinch about
    // their midpoint, double-tap toggles 2.5x at the tap, one finger pans when zoomed and swipes only when not.
    opts = opts || {};
    const Z = { s: 1, x: 0, y: 0 }, pts = new Map();
    let lastTap = 0, start = null, pinch = null;
    img.style.transformOrigin = '0 0';
    // geometry is measured once per zoom session, while the image is untransformed - measuring a transformed
    // rect against a not-yet-applied Z drifted the base by the pan delta and the clamp did nothing
    let base = null;
    function measure() { const r = img.getBoundingClientRect(), sr = stage.getBoundingClientRect(); base = { L0: r.left - sr.left, T0: r.top - sr.top, w0: r.width, h0: r.height, sw: sr.width, sh: sr.height }; }
    function clamp() {
      if (Z.s === 1) { Z.x = 0; Z.y = 0; return; }
      if (!base) measure();
      const W = base.w0 * Z.s, H = base.h0 * Z.s;
      // wider than the stage: the picture must keep covering it; narrower: sit centred
      Z.x = W > base.sw ? Math.min(-base.L0, Math.max(base.sw - W - base.L0, Z.x)) : (base.sw - W) / 2 - base.L0;
      Z.y = H > base.sh ? Math.min(-base.T0, Math.max(base.sh - H - base.T0, Z.y)) : (base.sh - H) / 2 - base.T0;
    }
    function apply() { clamp(); img.style.transform = Z.s === 1 ? '' : 'translate(' + Z.x + 'px,' + Z.y + 'px) scale(' + Z.s + ')'; }
    function reset() { Z.s = 1; Z.x = 0; Z.y = 0; base = null; apply(); }
    function zoomAt(cx, cy, s) {
      if (Z.s === 1 || !base) { Z.x = 0; Z.y = 0; img.style.transform = ''; measure(); }
      const sr = stage.getBoundingClientRect();
      const px = (cx - sr.left - base.L0 - Z.x) / Z.s, py = (cy - sr.top - base.T0 - Z.y) / Z.s;   // the image point under the fingers
      s = Math.min(6, Math.max(1, s));
      Z.s = s; Z.x = (cx - sr.left) - base.L0 - px * s; Z.y = (cy - sr.top) - base.T0 - py * s;
      if (s === 1) { Z.x = 0; Z.y = 0; base = null; }
      apply();
    }
    stage.addEventListener('pointerdown', function (e) {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); try { stage.setPointerCapture(e.pointerId); } catch (x) { }
      if (pts.size === 1) start = { x: e.clientX, y: e.clientY, zx: Z.x, zy: Z.y, t: Date.now(), moved: false };
      if (pts.size === 2) { const a = Array.from(pts.values()); pinch = { d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y), s: Z.s, cx: (a[0].x + a[1].x) / 2, cy: (a[0].y + a[1].y) / 2 }; start = null; if (opts.onPinch) opts.onPinch(); }
    });
    stage.addEventListener('pointermove', function (e) {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && pinch) { const a = Array.from(pts.values()); zoomAt(pinch.cx, pinch.cy, pinch.s * Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) / pinch.d); return; }
      if (start && pts.size === 1) {
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) start.moved = true;
        if (Z.s > 1) { Z.x = start.zx + dx; Z.y = start.zy + dy; apply(); }
        else if (opts.onDrag) opts.onDrag(dx, dy);
      }
    });
    const up = function (e) {
      pts.delete(e.pointerId); if (pts.size < 2) pinch = null;
      if (pts.size === 0 && start) {
        const dx = e.clientX - start.x, dy = e.clientY - start.y, dt = Date.now() - start.t;
        if (!start.moved) {
          const now = Date.now();
          if (now - lastTap < 320) { zoomAt(e.clientX, e.clientY, Z.s > 1 ? 1 : 2.5); lastTap = 0; }
          else { lastTap = now; if (opts.onTap) setTimeout(() => { if (lastTap === now) opts.onTap(); }, 330); }
        } else if (Z.s === 1 && opts.onRelease) opts.onRelease(dx, dy, dt);
        start = null;
      } else if (pts.size === 0) { start = null; if (Z.s === 1 && opts.onRelease) opts.onRelease(0, 0, 0); }
    };
    stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
    return { reset: reset, zoomed: () => Z.s > 1 };
  }
  function openRoom(list, idx, opts) {
    opts = opts || {};
    if (room && room.el.classList.contains('review')) roomStack.push(room); else closeRoom();
    hideToast();
    let i = Math.max(0, idx || 0);
    const el = h('div', { class: 'room', role: 'dialog', 'aria-modal': 'true' });
    const bar = h('div', { class: 'bar' }), stage = h('div', { class: 'stage' }), img = h('img', { alt: '' });
    const meta = h('div', { class: 'meta' }), foot = h('div', { class: 'foot' });
    stage.appendChild(img); stage.appendChild(h('span', { class: 'hintz', text: 'double-tap to zoom · swipe for the next' }));
    ['tl', 'tr', 'bl', 'br'].forEach(c => stage.appendChild(h('i', { class: 'reg ' + c })));
    el.appendChild(bar); el.appendChild(stage); el.appendChild(meta); el.appendChild(foot);
    document.body.appendChild(el); document.body.classList.add('locked');
    // founder, 2026-09-05 (PC): "photos are zoomed in and fixed" - on a landscape viewport the image
    // was sized by width and ran past the stage (705 px tall in a 461 px stage): the CSS height cap
    // is not honoured for a grid item here. The cap is set from the stage itself, on show and resize.
    const fit = () => { img.style.maxHeight = stage.clientHeight + 'px'; img.style.maxWidth = stage.clientWidth + 'px'; };
    const onResize = () => { fit(); if (zoom) zoom.reset(); };
    window.addEventListener('resize', onResize);
    window.addEventListener('lomb-room-close', () => window.removeEventListener('resize', onResize), { once: true });
    const zoom = attachZoom(stage, img, { onTap: () => { el.classList.toggle('chrome-off'); setTimeout(fit, 30); }, onRelease: (dx, dy, dt) => { if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4 && dt < 600) go(dx < 0 ? 1 : -1); } });
    function show() {
      const s = list[i]; if (!s) return;
      zoom.reset();
      img.src = UP + (s.inspect || s.thumb); img.alt = s.id || '';
      bar.innerHTML = ''; meta.innerHTML = ''; foot.innerHTML = '';
      bar.appendChild(h('span', { class: 'id', text: (s.id || '') + (list.length > 1 ? '  ·  ' + (i + 1) + '/' + list.length : '') }));
      bar.appendChild(h('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '×', onclick: closeRoom }));
      const judgeable = D.kind === 'poster' && !opts.readonly && byId(s.id);
      if (judgeable) {
        const v = ev(s.id), pos = order().indexOf(s.id);
        meta.appendChild(h('span', { html: '<span class="n">' + (s.recipeLabel || '') + '</span>' + (s.model ? ' · ' + s.model : '') + (v === 'approved' && pos >= 0 ? ' · <span class="n">' + (pos === 0 ? 'the cover' : '№ ' + (pos + 1)) + '</span>' : '') }));
        // founder, 2026-09-05: "case notes don't work" - a note typed and followed by Keep / Drop / Next
        // died with the textarea (the field is rebuilt before its change event fires). Every keystroke
        // is saved now; the grid redraws on change.
        const ta = h('textarea', { placeholder: 'A note on this one · artifact, excessive, off look, or your words', rows: 1, value: noteOf(s.id), oninput: e => setNote(s.id, e.target.value, { quiet: true }), onchange: e => setNote(s.id, e.target.value.trim()) });
        ta.value = noteOf(s.id); meta.appendChild(ta);
        foot.appendChild(h('button', { type: 'button', class: 'nav', 'aria-label': 'Previous', text: '‹', onclick: () => go(-1) }));
        foot.appendChild(h('button', { type: 'button', class: 'k' + (v === 'approved' ? ' on' : ''), onclick: () => { verdict(s.id, v === 'approved' ? 'pending' : 'approved', { quiet: true }); show(); } }, h('span', { class: 'x', text: '✓' }), v === 'approved' ? 'Kept' : 'Keep'));
        foot.appendChild(h('button', { type: 'button', class: 'd' + (v === 'rejected' ? ' on' : ''), onclick: () => { const nv = v === 'rejected' ? 'pending' : 'rejected'; verdict(s.id, nv, { quiet: true }); show(); if (nv === 'rejected' && !s.archive) toast(s.id + ' · dropped · why?', { chips: true, id: s.id }); } }, h('span', { class: 'x', text: '✗' }), s.archive ? 'Remove' : (v === 'rejected' ? 'Dropped' : 'Drop')));
        foot.appendChild(h('button', { type: 'button', class: 'nav', 'aria-label': 'Next', text: '›', onclick: () => go(1) }));
      } else {
        meta.appendChild(h('span', { text: s.label || s.recipeLabel || s.file || '' }));
        if (list.length > 1) { foot.appendChild(h('button', { type: 'button', text: '‹ previous', onclick: () => go(-1) })); foot.appendChild(h('button', { type: 'button', text: 'next ›', onclick: () => go(1) })); }
      }
    }
    function go(d) { if (list.length < 2) return; i = (i + d + list.length) % list.length; show(); }
    img.addEventListener('load', fit);
    const show0 = show;
    show = function () { show0(); fit(); requestAnimationFrame(fit); };
    room = { el: el, go: go, key: function (e) {
      if (e.key === 'Escape') closeRoom(); else if (e.key === 'ArrowRight') go(1); else if (e.key === 'ArrowLeft') go(-1);
      else if (D.kind === 'poster' && list[i] && byId(list[i].id)) { if (e.key === 'a' || e.key === 'k') { verdict(list[i].id, 'approved', { quiet: true }); show(); } else if (e.key === 'r' || e.key === 'x') { verdict(list[i].id, 'rejected', { quiet: true }); show(); } }
    } };
    show();
  }
  function closeRoom() {
    try { window.dispatchEvent(new Event('lomb-room-close')); } catch (e) { }
    if (room) { room.el.remove(); room = roomStack.pop() || null; }
    if (!room) { document.body.classList.remove('locked'); if (D.kind === 'poster') { renderOrder(); renderGrid(); renderTools(); } }
  }
  // founder, 2026-09-05 ("notes still don't work"): a note typed in the lightbox fed every letter to
  // the shortcuts - a/k kept, r/x dropped, arrows jumped shots - and each rebuilt the field mid-word.
  // Keys typed into any field belong to the field.
  const typing = e => { const t = e.target; return !!t && (/^(INPUT|TEXTAREA|SELECT)$/i.test(t.tagName) || t.isContentEditable); };
  document.addEventListener('keydown', e => { if (typing(e)) return; if (room && room.key) room.key(e); });
  document.addEventListener('click', function (e) {
    const a = e.target.closest('a.lb'); if (!a) return;
    e.preventDefault();
    if (a.dataset.sheet) { openRoom([{ id: 'the sheet', inspect: D.sheet.inspect, label: D.sheet.file }], 0, { readonly: true }); return; }
    const hs = $$('a.lb[data-house]');
    if (a.dataset.house) { const list = hs.map(x => ({ id: x.dataset.house, inspect: x.getAttribute('href').replace(/^\.\.\//, ''), label: x.querySelector('img').alt })); openRoom(list, hs.indexOf(a), { readonly: true }); return; }
    openRoom([{ id: a.querySelector('img') ? a.querySelector('img').alt : '', inspect: a.getAttribute('href').replace(/^\.\.\//, '') }], 0, { readonly: true });
  });

  // ---------------------------------------------------------------- review: one at a time, swipe
  function openReview() {
    closeRoom(); hideToast();
    const queue = allShots().filter(s => ev(s.id) === 'pending').map(s => s.id);
    if (!queue.length) { toast('Nothing waiting'); return; }
    const el = h('div', { class: 'room review', role: 'dialog', 'aria-modal': 'true' });
    const bar = h('div', { class: 'bar' }), deck = h('div', { class: 'deck' }), foot = h('div', { class: 'foot' });
    el.appendChild(bar); el.appendChild(deck); el.appendChild(foot);
    ['tl', 'tr', 'bl', 'br'].forEach(c => deck.appendChild(h('i', { class: 'reg ' + c })));
    document.body.appendChild(el); document.body.classList.add('locked');
    let i = 0; const done = [];
    const total = queue.length;
    function close() { el.remove(); room = null; roomStack = []; document.body.classList.remove('locked'); render(); }
    function card(id, under) {
      const s = byId(id); if (!s) return null;
      const c = h('div', { class: 'card' + (under ? ' under' : ''), data: { id: id } },
        h('img', { src: UP + s.inspect, alt: id, decoding: 'async' }),
        h('div', { class: 'cmeta', html: '<b>' + id + '</b> · ' + s.recipeLabel + (s.model ? ' · ' + s.model.replace('nano-banana-', 'nb-').replace('-edit', '') : '') + '<span class="swipehint">← drop · keep → · pinch or double-tap to zoom</span>' }),
        h('span', { class: 'stamp k', text: 'keep' }), h('span', { class: 'stamp d', text: 'drop' }));
      return c;
    }
    function show() {
      bar.innerHTML = ''; deck.innerHTML = ''; foot.innerHTML = '';
      bar.appendChild(h('span', { class: 'id prog', text: 'Review · ' + Math.min(i + 1, total) + ' of ' + total }));
      bar.appendChild(h('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '×', onclick: close }));
      if (i >= queue.length) {
        const k = done.filter(d => d.v === 'approved').length, r = done.filter(d => d.v === 'rejected').length;
        deck.appendChild(h('div', { class: 'done' }, h('h2', { text: 'Done' }), h('p', { text: k + ' kept · ' + r + ' dropped · ' + order().length + ' in the lot' }),
          h('button', { class: 'btn primary', type: 'button', text: 'Send to Claude now', onclick: () => { sendMail(false, true); toast('Sending…'); } }),
          h('button', { class: 'btn', type: 'button', text: 'Back to the page', onclick: close })));
        return;
      }
      if (queue[i + 1]) deck.appendChild(card(queue[i + 1], true));
      const c = card(queue[i]); deck.appendChild(c);
      attachZoom(c, $('img', c), {
        onDrag: (dx, dy) => { c.style.transition = 'none'; c.style.transform = 'translate(' + dx + 'px,' + (dy * .2) + 'px) rotate(' + (dx / 22) + 'deg)'; $('.stamp.k', c).style.opacity = Math.min(1, Math.max(0, dx - 30) / 70); $('.stamp.d', c).style.opacity = Math.min(1, Math.max(0, -dx - 30) / 70); },
        onRelease: (dx) => { if (dx > 90) decide('approved'); else if (dx < -90) decide('rejected'); else { c.style.transition = 'transform .18s'; c.style.transform = ''; $('.stamp.k', c).style.opacity = 0; $('.stamp.d', c).style.opacity = 0; } }
      });
      foot.appendChild(h('button', { type: 'button', class: 'd', onclick: () => decide('rejected') }, h('span', { class: 'x', text: '✗' }), 'Drop'));
      foot.appendChild(h('button', { type: 'button', class: 'nav', 'aria-label': 'Undo', text: '↶', disabled: done.length ? null : true, onclick: undo }));
      foot.appendChild(h('button', { type: 'button', class: 'nav', 'aria-label': 'Inspect', text: '⤢', onclick: () => openRoom([byId(queue[i])], 0) }));
      foot.appendChild(h('button', { type: 'button', class: 'k', onclick: () => decide('approved') }, h('span', { class: 'x', text: '✓' }), 'Keep'));
      function decide(v) {
        const id = queue[i]; const cur = $('.card:not(.under)', deck);
        if (cur) { cur.style.transition = 'transform .22s, opacity .22s'; cur.style.transform = 'translate(' + (v === 'approved' ? 1 : -1) * 120 + '%, -6%) rotate(' + (v === 'approved' ? 14 : -14) + 'deg)'; cur.style.opacity = '0'; }
        verdict(id, v, { quiet: true }); done.push({ id: id, v: v }); i++;
        if (v === 'rejected') toast(id + ' · dropped · why?', { chips: true, id: id }); else hideToast();
        setTimeout(show, 160);
      }
      function undo() { const d = done.pop(); if (!d) return; verdict(d.id, 'pending', { quiet: true }); i--; show(); }
    }
    show();
    room = { el: el, key: e => { if (e.key === 'Escape') close(); else if (e.key === 'a' || e.key === 'k' || e.key === 'ArrowRight') { const b = $('.foot .k', el); if (b) b.click(); } else if (e.key === 'r' || e.key === 'x' || e.key === 'ArrowLeft') { const b = $('.foot .d', el); if (b) b.click(); } } };
  }

  // ---------------------------------------------------------------- compare
  function openCompare(a, b) {
    closeRoom(); hideToast();
    const el = h('div', { class: 'room compare', role: 'dialog', 'aria-modal': 'true' });
    const bar = h('div', { class: 'bar' }, h('span', { class: 'id', text: 'Compare' }), h('button', { class: 'x', type: 'button', text: '×', 'aria-label': 'Close', onclick: closeRoom }));
    const panes = h('div', { class: 'panes' });
    function pane(s) {
      const v = ev(s.id);
      const pm = h('div', { class: 'pm' }, h('b', { text: s.id + ' · ' + s.recipeLabel }),
        h('button', { type: 'button', class: 'k' + (v === 'approved' ? ' on' : ''), text: '✓', onclick: () => { verdict(s.id, v === 'approved' ? 'pending' : 'approved', { quiet: true }); redraw(); } }),
        h('button', { type: 'button', class: 'd' + (v === 'rejected' ? ' on' : ''), text: '✗', onclick: () => { verdict(s.id, v === 'rejected' ? 'pending' : 'rejected', { quiet: true }); redraw(); } }),
        h('button', { type: 'button', text: '⤢', onclick: () => openRoom([s], 0) }));
      return h('div', { class: 'pane' }, h('img', { src: UP + s.inspect, alt: s.id }), pm);
    }
    function redraw() { panes.innerHTML = ''; panes.appendChild(pane(a)); panes.appendChild(pane(b)); }
    redraw();
    const foot = h('div', { class: 'foot' }, h('button', { type: 'button', text: '⇅ swap', onclick: () => { const t = a; a = b; b = t; redraw(); } }), h('button', { type: 'button', text: 'done', onclick: closeRoom }));
    el.appendChild(bar); el.appendChild(panes); el.appendChild(foot);
    document.body.appendChild(el); document.body.classList.add('locked');
    room = { el: el, key: e => { if (e.key === 'Escape') closeRoom(); } };
  }

  // ---------------------------------------------------------------- drawers
  let drawer = null;
  function openDrawer(title, build) {
    closeDrawer(); hideToast();
    const scrim = h('div', { class: 'scrim', onclick: closeDrawer });
    const el = h('div', { class: 'drawer', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'dh' }, h('h3', { text: title }), h('button', { class: 'x', type: 'button', text: '×', 'aria-label': 'Close', onclick: closeDrawer })));
    build(el);
    document.body.appendChild(scrim); document.body.appendChild(el); document.body.classList.add('locked');
    requestAnimationFrame(() => { scrim.classList.add('on'); el.classList.add('on'); });
    drawer = { el: el, scrim: scrim };
  }
  function closeDrawer() { if (drawer) { drawer.el.remove(); drawer.scrim.remove(); drawer = null; } if (!room) document.body.classList.remove('locked'); }

  let catalog = null;
  function openArchive() {
    openDrawer('Add from the archive', function (el) {
      const tabs = h('div', { class: 'tabs' }), search = h('div', { class: 'search' }), body = h('div', { class: 'body' });
      el.appendChild(tabs); el.appendChild(search); el.appendChild(body);
      body.appendChild(h('p', { class: 'hint', text: 'Loading the catalogue…' }));
      const q = h('input', { type: 'search', placeholder: 'Search · f40, macro, noir, cutout…', autocomplete: 'off' });
      const mine = h('input', { type: 'checkbox', checked: true });
      search.appendChild(q); search.appendChild(h('label', {}, mine, 'this car'));
      let grp = 'lots', limit = 120;
      const draw = function () {
        if (!catalog) return;
        const term = q.value.trim().toLowerCase();
        const items = catalog.items.filter(it => (grp === 'all' || it.group === grp) && (!mine.checked || !D.car || it.car === D.car || it.group === 'house')
          && (!term || (it.label + ' ' + it.id + ' ' + it.note + ' ' + it.src).toLowerCase().indexOf(term) >= 0));
        body.innerHTML = '';
        const grid = h('div', { class: 'arch' });
        items.slice(0, limit).forEach(it => grid.appendChild(h('button', { type: 'button', class: p.added.some(a => a.src === it.src) ? 'added' : '', onclick: () => detail(it) },
          h('img', { src: UP + it.thumb, alt: '', loading: 'lazy', decoding: 'async' }), h('span', { text: it.label }))));
        if (items.length > limit) grid.appendChild(h('button', { type: 'button', class: 'btn quiet more', text: 'Show more (' + (items.length - limit) + ')', onclick: () => { limit += 120; draw(); } }));
        if (!items.length) body.appendChild(h('p', { class: 'hint', text: 'Nothing under this filter.' }));
        body.appendChild(grid);
      };
      const detail = function (it) {
        body.innerHTML = '';
        const have = p.added.some(a => a.src === it.src);
        body.appendChild(h('div', { class: 'detail' },
          h('img', { src: UP + it.thumb, alt: it.label }),
          h('div', { class: 'dl' }, h('b', { text: it.label }), it.note ? it.note + ' · ' : '', it.src, ' · ', Math.round(it.bytes / 1e5) / 10 + ' MB'),
          h('div', { class: 'acts' },
            h('button', { class: 'btn keep big', type: 'button', text: have ? 'Already in the lot' : '✓ Add to this lot', disabled: have || null, onclick: () => {
              p.added.push({ id: 'arch-' + slug(it.id), src: it.src, label: it.label, thumb: it.thumb, inspect: it.thumb, w: it.tw, h: it.th, at: nowISO() });
              save(); render(); toast(it.label + ' · added to the lot, kept'); draw();
            } }),
            h('button', { class: 'btn quiet', type: 'button', text: '← back', onclick: draw }))));
      };
      const tabsDraw = function () {
        tabs.innerHTML = '';
        const gs = [['all', 'Everything']].concat(Object.keys(catalog.groups).map(k => [k, catalog.groups[k].split(' · ')[0]]));
        gs.forEach(g => { const n = g[0] === 'all' ? catalog.items.length : catalog.items.filter(x => x.group === g[0]).length; if (!n) return;
          tabs.appendChild(h('button', { type: 'button', class: grp === g[0] ? 'on' : '', onclick: () => { grp = g[0]; limit = 120; tabsDraw(); draw(); } }, g[1], h('span', { class: 'n', text: n }))); });
      };
      q.addEventListener('input', draw); mine.addEventListener('change', draw);
      const ready = () => { tabsDraw(); draw(); };
      if (catalog) ready();
      else fetch(UP + D.catalog).then(r => r.json()).then(j => { catalog = j; ready(); }).catch(() => { body.innerHTML = ''; body.appendChild(h('p', { class: 'hint', text: 'The catalogue is not on the site yet (python catalog.py, then deploy).' })); });
    });
  }

  function openSettings() {
    openDrawer('Sync and settings', function (el) {
      const body = h('div', { class: 'body' }); el.appendChild(body);
      const dev = h('input', { value: S.device, placeholder: 'This device' });
      const note = h('textarea', { class: 'notefield', placeholder: 'Anything Claude should know with these decisions - a wish, a correction, a next step', rows: 3 }); note.value = S.note || '';
      note.addEventListener('change', () => { S.note = note.value.trim(); save(); });
      const tok = h('input', { type: 'password', value: token(), placeholder: 'GitHub fine-grained token · Contents: read and write on ' + (D.cfg.repo || 'the site repo'), autocomplete: 'off' });
      const status = h('div', { class: 'status' });
      const drawStatus = function () {
        status.innerHTML = '';
        status.appendChild(h('div', { html: 'Saved on this ' + S.device + ': <b>' + dmy(S.savedAt) + '</b>' }));
        status.appendChild(h('div', { html: 'Sent to Claude: <b>' + (sent ? (sent.ok ? dmy(sent.at) + (sent.via ? ' via ' + sent.via : '') : 'failed ' + dmy(sent.at) + ' · ' + (sent.err || '')) : 'never') + '</b>' + (dirty ? ' · changes waiting' : '') }));
        status.appendChild(h('div', { html: 'GitHub: <b>' + (token() ? (gh ? (gh.ok ? 'committed ' + dmy(gh.at) : 'failed ' + gh.status + ' ' + dmy(gh.at)) : 'connected, nothing committed yet') : 'not connected') + '</b>' }));
      };
      drawStatus();
      body.appendChild(h('div', { class: 'settings' },
        h('p', { text: 'Every tap is saved on this device at once and stays here until you press Send. Send delivers the lot order and every verdict to Claude two ways - an instant channel he polls, and a copy to your own inbox. Connect a GitHub token and it is also committed straight into the site repo.' }),
        status,
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'button', text: 'Send to Claude now', onclick: () => { sendMail(false, true).then(() => { drawStatus(); toast(sent && sent.ok ? 'Sent' : 'Send failed · copy the summary instead'); }); } }),
          h('button', { class: 'btn', type: 'button', text: 'Copy summary', onclick: () => { navigator.clipboard.writeText(summary()).then(() => toast('Summary copied · paste it to Claude')).catch(() => toast('Copy failed')); } }),
          h('button', { class: 'btn quiet', type: 'button', text: 'Share…', onclick: () => { if (navigator.share) navigator.share({ title: 'Lombardia board', text: summary() }).catch(() => { }); else toast('Sharing is not available here'); } })),
        h('div', { class: 'f' }, h('label', { text: 'A note for Claude · goes with the next send' }), note),
        h('div', { class: 'f' }, h('label', { text: 'This device' }), dev),
        h('div', { class: 'f' }, h('label', { text: 'GitHub token (optional, one time)' }), tok,
          h('div', { class: 'row' },
            h('button', { class: 'btn', type: 'button', text: 'Connect', onclick: () => { try { localStorage.setItem(TOK, tok.value.trim()); } catch (e) { } if (tok.value.trim()) { pushGithub().then(() => { drawStatus(); toast(gh && gh.ok ? 'GitHub connected and committed' : 'GitHub refused it (' + (gh && gh.status) + ')'); }); } else { gh = null; drawStatus(); toast('GitHub disconnected'); } } }),
            h('a', { class: 'btn quiet', href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener', text: 'Make one ↗' })),
          h('p', { text: 'Repository access: only ' + (D.cfg.repo || 'the site repo') + ' · Permissions: Contents, read and write. It stays in this browser only.' })),
        h('div', { class: 'f' }, h('label', { text: 'Summary Claude reads' }), h('pre', { text: summary() })),
        h('div', { class: 'row' },
          h('button', { class: 'btn quiet', type: 'button', text: 'Forget local decisions', onclick: () => { if (confirm('Forget every unsent decision on this device?')) { S = { v: 1, savedAt: null, device: S.device, posters: {} }; try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { } location.reload(); } } }))));
      dev.addEventListener('change', () => { S.device = dev.value.trim() || deviceName(); save(); drawStatus(); });
    });
  }
  const gear = $('#btn-settings'); if (gear) gear.addEventListener('click', openSettings);

  // ---------------------------------------------------------------- sync
  function snapshot() { return { v: 1, savedAt: S.savedAt, sentAt: nowISO(), device: S.device, page: D.key || D.kind, note: S.note || '', posters: S.posters }; }
  function summary() {
    const lines = ['LOMBARDIA BOARD · ' + S.device + ' · ' + new Date().toLocaleString()];
    if (S.note) lines.push('', 'NOTE: ' + S.note);
    Object.keys(S.posters).forEach(function (k) {
      const q = S.posters[k]; const vs = Object.keys(q.verdicts || {});
      if (!vs.length && !(q.added || []).length && !q.sheet && !q.order) return;
      lines.push('', '## ' + k);
      if (q.sheet) lines.push('sheet: ' + q.sheet.v + (q.sheet.note ? ' — "' + q.sheet.note + '"' : ''));
      const by = { approved: [], rejected: [], pending: [] };
      vs.forEach(id => { const e = q.verdicts[id]; (by[e.v] || by.pending).push(id + (e.note ? ' ("' + e.note + '")' : '')); });
      if (by.approved.length) lines.push('keep: ' + by.approved.join(', '));
      if (by.rejected.length) lines.push('drop: ' + by.rejected.join(', '));
      if (by.pending.length) lines.push('back to waiting: ' + by.pending.join(', '));
      (q.added || []).forEach(a => lines.push('add: ' + a.id + ' ← ' + a.src));
      const ord = (D.kind === 'poster' && k === D.key) ? order() : q.order;
      if (ord && ord.length) lines.push('order: ' + ord.join(', ') + '  (all go up; the house third and last)');
      if (D.kind === 'poster' && k === D.key) { lines.push('upload: ' + uploadList().filter(x => !x.empty).map(x => x.house ? 'HOUSE ' + x.house.id : x.id).join(', ')); }
    });
    if (lines.length <= 3 && !Object.keys(S.posters).length) lines.push('', 'no decisions yet');
    return lines.join('\n');
  }
  function scheduleSync() {
    // founder 2026-09-04: "a button where I can press send instead of it being done every 20 sec" -
    // nothing leaves the phone until he presses Send; only a connected GitHub token commits on its own
    if (token()) { clearTimeout(ghTimer); ghTimer = setTimeout(pushGithub, 3000); }
    renderSendbar();
  }
  function unsentCount() {
    let c = 0;
    Object.keys(S.posters).forEach(k => { const q = S.posters[k]; c += Object.keys(q.verdicts || {}).length + (q.added || []).length + (q.sheet ? 1 : 0) + (q.order ? 1 : 0); });
    return c;
  }
  function renderSendbar() {
    let bar = $('#sendbar'); if (!bar) { bar = h('div', { id: 'sendbar', class: 'sendbar' }); document.body.appendChild(bar); }
    bar.innerHTML = ''; document.body.classList.toggle('has-sendbar', !!dirty);
    if (!dirty) { bar.classList.remove('on'); return; }
    const c = unsentCount();
    bar.appendChild(h('span', { class: 'sb-text' }, h('i', { class: 'dot' }), (c ? c + ' decision' + (c === 1 ? '' : 's') : 'Changes') + ' on this ' + S.device + ', not sent'));
    // founder, 2026-09-05: "i wanna see notes next to the send button" - every note that goes with this send
    const notes = [];
    Object.keys(S.posters || {}).forEach(function (k) {
      const q = S.posters[k]; if (!q) return;
      if (q.sheet && q.sheet.note) notes.push({ id: k + ' \u00b7 sheet ' + q.sheet.v, note: q.sheet.note });
      Object.keys(q.verdicts || {}).forEach(function (id) { const e = q.verdicts[id]; if (e && e.note) notes.push({ id: id + ' \u00b7 ' + e.v, note: e.note }); });
    });
    if (S.note) notes.push({ id: 'for Claude', note: S.note });
    if (notes.length) {
      const nl = h('div', { class: 'sb-notes' });
      notes.forEach(n => nl.appendChild(h('div', { class: 'sb-note' }, h('b', { text: n.id }), ' ', h('span', { text: '\u201c' + n.note + '\u201d' }))));
      bar.appendChild(nl);
    }
    bar.appendChild(h('button', { class: 'btn primary big', type: 'button', text: 'Send to Claude', onclick: () => {
      bar.classList.add('busy');
      sendMail(false, true).then(() => { bar.classList.remove('busy'); if (!(sent && sent.ok)) toast('Send failed · ' + ((sent && sent.err) || '') + ' · use Copy in Sync', { label: 'Sync', fn: openSettings }); });
    } }));
    bar.classList.add('on');
  }
  // Both mail relays choke on non-ASCII (FormSubmit answers 'Server Error' to any UTF-8 byte; header values must be Latin-1),
  // so everything that leaves the page is 7-bit: symbols mapped, the JSON with \uXXXX escapes (still valid JSON).
  function ascii(t) { return String(t).replace(/·/g, '-').replace(/←/g, '<-').replace(/→/g, '->').replace(/[✓✔]/g, 'OK').replace(/[✗✘×]/g, 'X').replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'").replace(/…/g, '...').replace(/[–—]/g, '-').replace(/[^\x00-\x7f]/g, '?'); }
  function asciiJSON(o) { return JSON.stringify(o).replace(/[\u007f-\uffff]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4)); }
  function sendMail(keepalive, manual) {
    if (!D.cfg || !dirty || !(D.cfg.form || D.cfg.ntfy)) return Promise.resolve();
    // a local preview never posts on its own (FormSubmit would mail an activation request for the new origin); the Send button still works
    if (!manual && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return Promise.resolve();
    clearTimeout(sendTimer);
    if (D.kind === 'poster' && p) { const o = order(); if (!p.order || p.order.join() !== o.join() || !p.orderAt) { p.order = o; p.orderAt = nowISO(); try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { } } }
    const title = ascii('Lombardia board - ' + S.device + ' - ' + new Date().toLocaleString());
    const sum = ascii(summary()), json = asciiJSON(snapshot());
    const jobs = [];
    if (D.cfg.ntfy) {
      // ntfy.sh: the summary as the message (kept 12 h), the JSON as an attachment (kept 3 h); python lotset.py inbox reads both
      jobs.push(fetch(D.cfg.ntfy, { method: 'POST', keepalive: !!keepalive, headers: { 'Title': title, 'Tags': 'clipboard' }, body: sum }).then(r => r.ok ? 'ntfy' : Promise.reject(new Error('ntfy ' + r.status)))
        .then(v => fetch(D.cfg.ntfy, { method: 'PUT', keepalive: !!keepalive, headers: { 'Filename': 'decisions.json', 'Title': title }, body: json }).then(() => v, () => v)));
    }
    if (D.cfg.form) {
      // form-encoded on purpose: FormSubmit drops the fields and the subject from JSON bodies (tested 2026-09-04)
      jobs.push(fetch(D.cfg.form, { method: 'POST', keepalive: !!keepalive, headers: { 'Accept': 'application/json' }, body: new URLSearchParams({ _subject: title, summary: sum, decisions: json }) })
        .then(r => r.json()).then(j => (j && (j.success === 'true' || j.success === true)) ? 'mail' : Promise.reject(new Error((j && j.message) || 'mail failed'))));
    }
    return Promise.allSettled(jobs).then(function (rs) {
      const ok = rs.filter(r => r.status === 'fulfilled').map(r => r.value), bad = rs.filter(r => r.status === 'rejected').map(r => String(r.reason && r.reason.message || r.reason));
      if (ok.length) { sent = { at: nowISO(), ok: true, via: ok.join('+'), warn: bad.join('; ') }; setDirty(false); if (!keepalive) toast('Sent to Claude ✓ · he has the order and every verdict' + (bad.length ? ' (' + ok.join('+') + ' only)' : '')); }
      else sent = { at: nowISO(), ok: false, err: bad.join('; ') || 'send failed' };
      try { localStorage.setItem(SENT, JSON.stringify(sent)); } catch (e) { } renderTitleblock();
    });
  }
  function pushGithub() {
    const tk = token(); if (!tk || !D.cfg || !D.cfg.repo) return Promise.resolve();
    clearTimeout(ghTimer);
    const api = 'https://api.github.com/repos/' + D.cfg.repo + '/contents/' + D.cfg.path;
    const H = { 'Authorization': 'Bearer ' + tk, 'Accept': 'application/vnd.github+json' };
    return fetch(api, { headers: H }).then(r => r.ok ? r.json() : null).catch(() => null).then(function (cur) {
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(snapshot(), null, 1))));
      const payload = { message: 'Founder decisions from the board (' + S.device + ')', content: content };
      if (cur && cur.sha) payload.sha = cur.sha;
      return fetch(api, { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify(payload) });
    }).then(r => { gh = { at: nowISO(), ok: r.ok, status: r.status }; }).catch(e => { gh = { at: nowISO(), ok: false, status: String(e.message || e) }; })
      .then(() => { try { localStorage.setItem(GH, JSON.stringify(gh)); } catch (e) { } renderTitleblock(); });
  }
  const flush = function () { if (dirty && token()) pushGithub(); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', flush);

  // ---------------------------------------------------------------- title block
  function renderTitleblock() {
    const tb = $('#titleblock'); if (!tb) return; tb.innerHTML = '';
    const row = (k, v) => { tb.appendChild(h('div', {}, h('span', { class: 'k', text: k }), typeof v === 'string' ? h('span', { class: 'v', text: v }) : h('span', { class: 'v' }, v))); };
    tb.appendChild(h('div', { class: 'head' }, h('span', { class: 'mono', text: 'LA' }), h('span', { text: 'Lombardia Automobili · il banco' })));
    if (D.kind === 'poster') {
      const c = counts(), o = order();
      row('Tavola', D.folio + ' · ' + D.name + ' · ' + D.collLabel);
      row('Stage', (D.stageIdx + 1) + '/6 · ' + D.stages[D.stageIdx].label + (sheetStatus() === 'approved' && D.stageIdx === 0 ? ' → approved here' : ''));
      row('The set', c.approved + ' kept · ' + c.pending + ' waiting · ' + c.rejected + ' dropped' + (p.added.length ? ' · ' + p.added.length + ' from the archive' : ''));
      row('Lot order', o.length ? o.slice(0, 6).map((id, i) => (i + 1) + ' ' + id).join(' · ') + (o.length > 6 ? ' · +' + (o.length - 6) : '') : '—');
    } else if (D.kind === 'index') {
      const ps = D.posters || [];
      let a = 0, w = 0; ps.forEach(x => { const c = overlayCounts(x); a += c.approved; w += c.pending; });
      row('Board', ps.length + ' posters · ' + a + ' kept · ' + w + ' waiting');
    }
    const pendingLocal = Object.keys(S.posters).some(k => { const q = S.posters[k]; return Object.keys(q.verdicts || {}).length || (q.added || []).length || q.sheet || q.order; });
    row('Saved', [h('i', { class: 'dot ' + (S.savedAt ? 'ok' : '') }), (S.savedAt ? 'on this ' + S.device + ' · ' + hhmm(S.savedAt) : 'nothing decided yet')]);
    row('Sent', [h('i', { class: 'dot ' + (sent ? (sent.ok ? (dirty ? 'wait' : 'ok') : 'bad') : (dirty ? 'wait' : '')) }),
      sent ? (sent.ok ? 'to Claude · ' + hhmm(sent.at) + (sent.via ? ' · ' + sent.via : '') + (dirty ? ' · new changes queued' : '') : 'failed · ' + (sent.err || '')) : (dirty ? 'queued' : pendingLocal ? 'not yet' : '—'),
      null]);
    if (token()) row('GitHub', [h('i', { class: 'dot ' + (gh ? (gh.ok ? 'ok' : 'bad') : '') }), gh ? (gh.ok ? 'committed · ' + hhmm(gh.at) : 'failed · ' + gh.status) : 'connected']);
    row('Built', D.built || '');
    renderSendbar();
    const g = $('#btn-settings');
    if (g) { g.innerHTML = ''; g.appendChild(h('i', { class: 'dot ' + (dirty ? 'wait' : sent ? (sent.ok ? 'ok' : 'bad') : '') })); g.appendChild(document.createTextNode('Sync')); g.title = dirty ? 'changes queued' : sent ? (sent.ok ? 'sent ' + hhmm(sent.at) : 'send failed') : 'nothing to send'; }
  }

  // ---------------------------------------------------------------- copy buttons (post kit)
  document.addEventListener('click', function (e) {
    const b = e.target.closest('.cp'); if (!b) return;
    navigator.clipboard.writeText(b.dataset.copy).then(() => { const was = b.textContent; b.textContent = 'Copied'; b.classList.add('ok'); setTimeout(() => { b.textContent = was; b.classList.remove('ok'); }, 1400); }).catch(() => { b.textContent = 'Copy failed'; });
  });

  // ---------------------------------------------------------------- go
  render();
  if (D.kind === 'poster') {
    if (location.hash === '#review') location.hash = '#sec-order';
    else if (location.hash === '#archive') setTimeout(openArchive, 60);
    else if (location.hash) { const t = $(location.hash === '#sheet' ? '#sec-sheet' : location.hash === '#order' ? '#sec-order' : location.hash); if (t) setTimeout(() => t.scrollIntoView({ block: 'start' }), 60); }
  }
})();
