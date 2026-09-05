/* The board, v3 - the founder's approval desk.
   Every tap is a decision: kept on this device (localStorage), sent to Claude when he presses Send (ntfy +
   FormSubmit, read by Claude), and, when a token is connected, committed to the site repo as decisions/latest.json.
   `python lotset.py apply` reads them back into the pipeline.
   Decisions carry a timestamp; anything at or before the poster's `synced` time is already in the built page
   and is dropped from the overlay on load, so the page never argues with itself.

   v3, founder 2026-09-05: every shot is IN the lot by default - he drops the bad ones and leaves a note;
   02 is the one judging place (order + drop + note), 03 is just the photographs; every photograph downloads
   on its own; Send shows plainly that it went. */
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
  let dirty = false, ghTimer = null, justSent = null, sending = false;
  try { dirty = localStorage.getItem(DIRTY) === '1'; } catch (e) { }
  function setDirty(v) { dirty = v; try { localStorage.setItem(DIRTY, v ? '1' : '0'); } catch (e) { } }
  function P(key) {
    if (!S.posters[key]) S.posters[key] = { verdicts: {}, order: null, orderAt: null, added: [], sheet: null };
    const p = S.posters[key];
    p.verdicts = p.verdicts || {}; p.added = p.added || [];
    return p;
  }
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { } }
  function save() {
    S.savedAt = nowISO(); persist();
    setDirty(true); justSent = null; scheduleSync(); renderTitleblock();
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
    persist();
  }
  pruneSynced();
  const token = () => { try { return localStorage.getItem(TOK) || ''; } catch (e) { return ''; } };

  const KEYTOK = /^(tl|tr|bl|br|pro|nb2|flat|side|model|layered|noir|unframed|fixed|fixed2|r[1-6]|\d+)$/;
  function fmtId(id) {
    const el = h('span', { class: 'fid' });
    String(id).split('-').forEach((t, i, a) => { el.appendChild(KEYTOK.test(t) ? h('b', { text: t }) : document.createTextNode(t)); if (i < a.length - 1) el.appendChild(document.createTextNode('-')); });
    return el;
  }

  // ---------------------------------------------------------------- poster model
  const p = D.kind === 'poster' ? P(D.key) : null;
  function archiveShot(a) {
    return { id: a.id, file: a.src, recipe: 'archive', recipeLabel: 'from the archive · ' + a.label, group: 'archive', model: '',
      founder: 'approved', note: '', thumb: a.thumb, inspect: a.inspect || a.thumb, full: '', w: a.w, h: a.h, archive: true, src: a.src };
  }
  const allShots = () => D.shots.concat(p.added.map(archiveShot));
  const byId = id => allShots().find(s => s.id === id);
  const ev = id => (p.verdicts[id] && p.verdicts[id].v) || (byId(id) || {}).founder || 'pending';
  const inLot = id => ev(id) !== 'rejected';                 // in by default (founder 2026-09-05)
  // the note field is his: a local note first, else the short verdict note the pipeline kept from an earlier
  // send ("artifact", "off-look"); the pipeline's own long build annotations never fill his field
  function hisNote(id) {
    if (p.verdicts[id] && p.verdicts[id].note !== undefined) return p.verdicts[id].note;   // his, even when he cleared it
    const s = byId(id); let n = (s && s.note) || '';
    if (/RULES\.md|re-laid|first round|second build|one of the fixed rooms|the hero of every lot|the true print|fidelity/.test(n) || n.length > 90) return '';
    return n.replace(/^founder:\s*/i, '');
  }
  function order() {
    const ap = allShots().filter(s => inLot(s.id)).map(s => s.id);
    const base = (p.order || D.order || []).filter(id => ap.indexOf(id) >= 0);
    return base.concat(ap.filter(id => base.indexOf(id) < 0));
  }
  function setOrder(list) { p.order = list; p.orderAt = nowISO(); save(); }
  // founder 2026-09-04: his first two, house photograph one, every other kept shot, house photograph two last
  function uploadList() {
    const o = order().slice(), hs = (D.house || []).slice(0, 2), up = [];
    if (o.length) up.push({ id: o.shift() });
    if (o.length) up.push({ id: o.shift() });
    if (hs[0]) up.push({ house: hs[0] });
    o.forEach(id => up.push({ id: id }));
    if (hs[1]) up.push({ house: hs[1], last: true });
    return up;
  }
  function counts() {
    const c = { approved: 0, pending: 0, rejected: 0, total: 0, in: 0 };
    allShots().forEach(s => { const v = ev(s.id); c[v]++; c.total++; if (v !== 'rejected') c.in++; });
    return c;
  }
  function verdict(id, v, opts) {
    opts = opts || {};
    const s = byId(id); if (!s) return;
    const prev = ev(id), prevNote = p.verdicts[id] ? p.verdicts[id].note : undefined;
    if (s.archive && v === 'rejected') {           // an archive add is removed, not dropped
      const raw = addedRaw(s);
      // the pipeline may already hold this add from an earlier send, so the removal travels as a drop
      p.added = p.added.filter(a => a.id !== id); p.verdicts[id] = { v: 'rejected', at: nowISO() };
      p.order = order().filter(x => x !== id); p.orderAt = nowISO(); save(); render();
      if (!opts.quiet) toast(s.id + ' · removed from the lot', { label: 'Undo', fn: () => { delete p.verdicts[id]; p.added.push(raw); save(); render(); } });
      return;
    }
    const nv = { v: v, at: nowISO() };
    const nn = opts.note !== undefined ? opts.note : prevNote;
    if (nn !== undefined) nv.note = nn;             // a note key travels only when he wrote (or cleared) one
    p.verdicts[id] = nv;
    let o = order();
    if (v !== 'rejected') { if (o.indexOf(id) < 0) o.push(id); } else o = o.filter(x => x !== id);
    p.order = o; p.orderAt = nowISO();
    save(); render();
    if (!opts.quiet) toast(id + (v === 'rejected' ? ' · dropped' : ' · back in the lot'), {
      label: 'Undo', fn: () => { if (prev === 'pending') { delete p.verdicts[id]; p.order = order(); p.orderAt = nowISO(); save(); render(); } else verdict(id, prev, { quiet: true, note: prevNote }); }
    });
  }
  function addedRaw(s) { return { id: s.id, src: s.src, label: s.recipeLabel.replace('from the archive · ', ''), thumb: s.thumb, inspect: s.inspect, w: s.w, h: s.h, at: nowISO() }; }
  function setNote(id, note) {
    const cur = p.verdicts[id] || { v: ev(id) };
    p.verdicts[id] = { v: cur.v, at: nowISO(), note: note };
    save();
  }
  // in by default: on Send every shot he has not touched becomes an explicit keep, so the pipeline and the page agree
  function materialize() {
    if (D.kind !== 'poster' || !p) return 0;
    let n = 0;
    allShots().forEach(s => { if (ev(s.id) === 'pending') { const nv = { v: 'approved', at: nowISO() }; if (p.verdicts[s.id] && p.verdicts[s.id].note !== undefined) nv.note = p.verdicts[s.id].note; p.verdicts[s.id] = nv; n++; } });
    if (n) setDirty(true);                            // a failed send must leave the bar up, not strand the lot
    return n;
  }
  function sheetStatus() { return p.sheet ? p.sheet.v : (D.stageIdx >= 1 ? 'approved' : 'pending'); }

  // ---------------------------------------------------------------- toast
  let toastTimer = null;
  function toast(msg, act) {
    const t = $('#toast'); if (!t) return;
    t.innerHTML = ''; t.appendChild(h('span', { text: msg }));
    if (act && act.label) t.appendChild(h('button', { type: 'button', text: act.label, onclick: () => { act.fn(); hideToast(); } }));
    t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, act ? 5000 : 2600);
  }
  function hideToast() { const t = $('#toast'); if (t) t.classList.remove('on'); }

  // ---------------------------------------------------------------- render: poster page
  function render() { if (D.kind !== 'poster') { renderIndex(); renderTitleblock(); return; } renderGate(); renderLot(); renderPool(); renderTitleblock(); }

  function renderGate() {
    const g = $('#gate-sheet'); if (!g) return; g.innerHTML = '';
    const st = sheetStatus();
    if (st === 'pending') {
      const note = h('textarea', { placeholder: 'A note, if you like', rows: 2 });
      g.appendChild(h('div', { class: 'verdict' },
        h('button', { class: 'btn keep big', type: 'button', onclick: () => { p.sheet = { v: 'approved', at: nowISO(), note: note.value.trim() }; save(); renderGate(); toast('Sheet approved', { label: 'Undo', fn: () => { p.sheet = null; save(); renderGate(); } }); } }, h('span', { class: 'x', text: '✓' }), 'Approve the sheet'),
        h('button', { class: 'btn drop big', type: 'button', onclick: () => { p.sheet = { v: 'rejected', at: nowISO(), note: note.value.trim() }; save(); renderGate(); toast('Sheet sent back' + (note.value.trim() ? ' with your note' : ''), { label: 'Undo', fn: () => { p.sheet = null; save(); renderGate(); } }); } }, h('span', { class: 'x', text: '✗' }), 'Not yet')));
      g.appendChild(note);
    } else {
      const local = !!p.sheet;
      g.appendChild(h('span', { class: 'chip ' + (st === 'approved' ? 'ok' : 'no') + (local ? ' unsynced' : ''), text: st === 'approved' ? 'Sheet approved' : 'Sheet sent back' }));
      if (local && p.sheet.note) g.appendChild(h('span', { class: 'hint', text: '“' + p.sheet.note + '”' }));
      if (local) g.appendChild(h('button', { class: 'btn quiet', type: 'button', text: 'Change', onclick: () => { p.sheet = null; save(); renderGate(); } }));
      else if (D.sheet.approval && D.sheet.approval.note) g.appendChild(h('span', { class: 'hint', text: '“' + D.sheet.approval.note + '”' }));
    }
  }

  function dlLink(s, cls) {
    const href = UP + (s.full || s.inspect || s.thumb);
    return h('a', { class: cls || 'dl', href: href, download: '', title: s.full ? 'Download the full-size file' : 'Download (2000 px - the full-size file is on the site for shots in the lot)', 'aria-label': 'Download ' + (s.id || '') }, '⤓');
  }
  function noteField(id) {
    const wrap = h('div', { class: 'lnotewrap' });
    const ta = h('textarea', { class: 'lnote', placeholder: 'Note', rows: 1 });
    ta.value = hisNote(id);
    const saved = h('span', { class: 'lsaved', text: '' });
    let t = null;
    ta.addEventListener('input', function () {
      setNote(id, ta.value);
      saved.textContent = '✓ saved'; saved.classList.add('on');
      clearTimeout(t); t = setTimeout(() => saved.classList.remove('on'), 1600);
    });
    ta.addEventListener('change', () => setNote(id, ta.value.trim()));
    ta.addEventListener('focus', () => { ta.rows = 3; });
    ta.addEventListener('blur', () => { if (!ta.value.trim()) ta.rows = 1; });
    wrap.appendChild(ta); wrap.appendChild(saved);
    return wrap;
  }
  function renderLot() {
    const list = $('#lotlist'); if (!list) return; list.innerHTML = '';
    const o = order(), u = uploadList();
    const judgeList = () => o.map(byId).filter(Boolean).concat(allShots().filter(s => ev(s.id) === 'rejected'));
    const openAt = id => { const l = judgeList(); openRoom(l, l.findIndex(x => x.id === id)); };
    const row = function (s, pos, k) {
      const v = ev(s.id), dropped = v === 'rejected';
      const acts = h('div', { class: 'lacts' });
      acts.appendChild(dlLink(s));
      if (!dropped) {
        acts.appendChild(h('button', { type: 'button', class: 'handle', 'aria-label': 'Drag to reorder', text: '⋮⋮' }));
        acts.appendChild(h('button', { type: 'button', class: 'mv', 'aria-label': 'Move up', text: '▲', disabled: k === 0 || null, onclick: () => move(s.id, -1) }));
        acts.appendChild(h('button', { type: 'button', class: 'mv', 'aria-label': 'Move down', text: '▼', disabled: k === o.length - 1 || null, onclick: () => move(s.id, 1) }));
        acts.appendChild(h('button', { type: 'button', class: 'd', onclick: () => verdict(s.id, 'rejected') }, h('span', { class: 'x', text: '✗' }), s.archive ? 'Remove' : 'Drop'));
      } else {
        acts.appendChild(h('button', { type: 'button', class: 'k', onclick: () => verdict(s.id, 'approved') }, h('span', { class: 'x', text: '↶' }), 'Restore'));
      }
      return h('div', { class: 'lrow ' + (dropped ? 'no' : 'ok'), data: { id: s.id } },
        h('div', { class: 'limg' }, h('img', { src: UP + s.thumb, alt: s.id, loading: 'lazy', decoding: 'async', onclick: () => openAt(s.id) }),
          pos >= 0 ? h('span', { class: 'num' + (pos === 0 ? ' cover' : ''), text: pos === 0 ? 'cover' : String(pos + 1) }) : null),
        h('div', { class: 'lmeta' },
          h('div', { class: 'tid' }, fmtId(s.id)),
          h('div', { class: 'trec', text: s.recipeLabel }),
          noteField(s.id)),
        acts);
    };
    const houseRow = function (hh, pos, last) {
      return h('div', { class: 'lrow house' },
        h('div', { class: 'limg' }, h('img', { src: UP + hh.thumb, alt: hh.id, loading: 'lazy', decoding: 'async', onclick: () => openRoom((D.house || []).map(x => ({ id: x.id, inspect: x.inspect, full: x.full, label: x.label })), (D.house || []).indexOf(hh), { readonly: true }) }),
          h('span', { class: 'num house', text: String(pos + 1) })),
        h('div', { class: 'lmeta' }, h('div', { class: 'tid' }, '⌂ house · ' + (last ? 'last' : (['first', 'second', 'third'][pos] || '№ ' + (pos + 1)))), h('div', { class: 'trec', text: hh.label })),
        h('div', { class: 'lacts' }, dlLink(hh)));
    };
    u.forEach(function (x, i) {
      if (x.house) list.appendChild(houseRow(x.house, i, x.last));
      else { const s = byId(x.id); if (s) list.appendChild(row(s, i, o.indexOf(x.id))); }
    });
    const dropped = allShots().filter(s => ev(s.id) === 'rejected');
    if (dropped.length) {
      list.appendChild(h('div', { class: 'lhead', text: 'Dropped · ' + dropped.length }));
      dropped.forEach(s => list.appendChild(row(s, -1, -1)));
    }
    enableDrag(list);
    const ot = $('#ordertools'); if (ot) {
      ot.innerHTML = '';
      if (o.length) ot.appendChild(h('button', { class: 'btn quiet', type: 'button', text: '▣ Preview the lot as Catawiki shows it', onclick: openPreview }));
      ot.appendChild(h('button', { class: 'btn quiet', type: 'button', text: '+ From the archive', onclick: openArchive }));
    }
  }
  function renderPool() {
    const g = $('#pool'); if (!g) return; g.innerHTML = '';
    const o = order();
    const shots = o.map(byId).filter(Boolean).concat(allShots().filter(s => ev(s.id) === 'rejected'));
    const house = (D.house || []).map(x => ({ id: x.id, thumb: x.thumb, inspect: x.inspect, full: x.full, label: x.label, house: true }));
    const list = shots.concat(house);
    list.forEach(function (s, i) {
      const dropped = !s.house && ev(s.id) === 'rejected';
      g.appendChild(h('figure', { class: 'ph' + (dropped ? ' no' : '') + (s.house ? ' house' : ''), data: { id: s.id } },
        h('a', { class: 'pimg', href: UP + s.inspect, style: s.w && s.h ? 'aspect-ratio:' + s.w + '/' + s.h : '', onclick: e => { e.preventDefault(); openRoom(list, i, { readonly: true }); } },
          h('img', { src: UP + s.thumb, width: s.w || null, height: s.h || null, alt: s.id, loading: 'lazy', decoding: 'async' })),
        h('figcaption', {}, h('span', { class: 'pid' }, s.house ? '⌂ ' + s.id : fmtId(s.id)),
          dropped ? h('button', { type: 'button', class: 'restore', 'aria-label': 'Restore ' + s.id, title: 'Back in the lot', onclick: () => verdict(s.id, 'approved') }, '↶') : null,
          dlLink(s))));
    });
    const c = $('#poolcount'); if (c) c.textContent = shots.length + (house.length ? ' + ' + house.length + ' house' : '');
  }
  function openPreview() {
    closeRoom(); hideToast();
    const six = uploadList().map(x => x.house ? { id: x.house.id, thumb: x.house.thumb, inspect: x.house.inspect, full: x.house.full } : byId(x.id)).filter(Boolean);
    if (!six.length) return;
    const el = h('div', { class: 'room preview', role: 'dialog', 'aria-modal': 'true' });
    el.appendChild(h('div', { class: 'bar' }, h('span', { class: 'id', text: 'The lot · as Catawiki shows it' }), h('button', { class: 'x', type: 'button', text: '×', 'aria-label': 'Close', onclick: closeRoom })));
    const stage = h('div', { class: 'stage' });
    stage.appendChild(h('div', { class: 'cover' }, h('img', { src: UP + six[0].inspect, alt: six[0].id, onclick: () => openRoom(six, 0, { readonly: true }) })));
    stage.appendChild(h('div', { class: 'thumbs' }, six.map((s, i) => h('img', { src: UP + s.thumb, alt: s.id, class: i === 0 ? 'on' : '', onclick: () => openRoom(six, i, { readonly: true }) }))));
    stage.appendChild(h('div', { class: 'ptitle', text: D.kitTitle || (D.name + ' · ' + D.collLabel) }));
    stage.appendChild(h('div', { class: 'pnote', text: six.length + ' photographs, in this order' }));
    el.appendChild(stage);
    el.appendChild(h('div', { class: 'foot' }, h('button', { type: 'button', text: 'done', onclick: closeRoom })));
    document.body.appendChild(el); document.body.classList.add('locked');
    room = { el: el, key: e => { if (e.key === 'Escape') closeRoom(); } };
  }
  function move(id, dir) {
    const o = order(), i = o.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= o.length) return;
    o.splice(i, 1); o.splice(j, 0, id); setOrder(o); renderLot(); renderPool();
    const row = $('.lrow[data-id="' + id + '"]'); if (row) { row.classList.add('moved'); setTimeout(() => row.classList.remove('moved'), 500); }
    if (j === 0) toast(id + ' is the cover');
  }
  let dragBound = null;
  function enableDrag(list) {
    if (dragBound === list) return; dragBound = list;
    let drag = null, raf = null;
    // where the finger is, in the viewport; the row's transform follows it and the page scroll under it
    let landing = null;
    function landAt(top, n) {
      if (!landing) { landing = h('div', { class: 'landing' }, h('span', { class: 'll' })); list.appendChild(landing); }
      const lr = list.getBoundingClientRect();
      landing.style.top = (top - lr.top) + 'px';
      landing.firstChild.textContent = n ? 'lands here · ' + (n === 1 ? 'cover' : '№ ' + n) : 'lands here';
      landing.classList.add('on');
    }
    function landClear() { if (landing) landing.classList.remove('on'); }
    function aim() {
      if (!drag) return;
      drag.row.style.transform = 'translateY(' + (drag.cy - drag.y + (window.scrollY - drag.sy)) + 'px)';
      const el = document.elementFromPoint(drag.cx, drag.cy);
      const over = el && el.closest('.lrow.ok[data-id]');
      $$('.lrow.over', list).forEach(r => r.classList.remove('over', 'after'));
      if (over && over !== drag.row) {
        const r = over.getBoundingClientRect(), after = drag.cy > r.top + r.height / 2;
        over.classList.add('over'); if (after) over.classList.add('after');
        drag.over = { id: over.dataset.id, after: after };
        // the position it will take, counted the way the rows are numbered (house slots included)
        const o = order().filter(x => x !== drag.id); o.splice(o.indexOf(over.dataset.id) + (after ? 1 : 0), 0, drag.id);
        const k = o.indexOf(drag.id); const n = k + 1 + (k >= 2 ? 1 : 0);
        landAt(after ? r.bottom : r.top, n);
      } else { drag.over = null; landClear(); }
    }
    // runs every frame during a drag: near the top or bottom edge the page scrolls on its own, faster the
    // deeper the finger sits in the zone - a finger held still at the edge keeps scrolling (a pointermove-only
    // scroll stopped as soon as the finger stopped)
    function tick() {
      if (!drag) return;
      const top = 52 + 64, bottom = window.innerHeight - 64;   // below the sticky header; the send bar hides while dragging
      let dy = 0;
      if (drag.cy > bottom) dy = Math.min(22, 3 + (drag.cy - bottom) / 4);
      else if (drag.cy < top) dy = -Math.min(22, 3 + (top - drag.cy) / 4);
      if (dy) {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        if ((dy > 0 && window.scrollY < max) || (dy < 0 && window.scrollY > 0)) window.scrollBy(0, dy);
      }
      aim();
      raf = requestAnimationFrame(tick);
    }
    list.addEventListener('pointerdown', function (e) {
      const handle = e.target.closest('.handle'); if (!handle) return;
      const row = handle.closest('.lrow'); if (!row || !row.dataset.id) return;
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch (x) { }
      drag = { id: row.dataset.id, row: row, y: e.clientY, cx: e.clientX, cy: e.clientY, sy: window.scrollY, over: null };
      row.classList.add('drag'); document.body.classList.add('dragging');
      cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
    });
    list.addEventListener('pointermove', function (e) {
      if (!drag) return; e.preventDefault();
      drag.cx = e.clientX; drag.cy = e.clientY; aim();
    });
    const end = function () {
      if (!drag) return;
      cancelAnimationFrame(raf); raf = null;
      const o = order(); let list_ = o;
      if (drag.over) { list_ = o.filter(x => x !== drag.id); list_.splice(list_.indexOf(drag.over.id) + (drag.over.after ? 1 : 0), 0, drag.id); }
      drag.row.classList.remove('drag'); drag.row.style.transform = ''; document.body.classList.remove('dragging');
      $$('.lrow.over', list).forEach(r => r.classList.remove('over', 'after')); landClear();
      const changed = list_.join() !== o.join(); const moved = drag.id; drag = null;
      if (changed) {
        setOrder(list_); renderLot(); renderPool(); toast('Order updated');
        const row = $('.lrow[data-id="' + moved + '"]'); if (row) { row.classList.add('moved'); setTimeout(() => row.classList.remove('moved'), 700); }
      }
    };
    list.addEventListener('pointerup', end); list.addEventListener('pointercancel', end);
  }

  // ---------------------------------------------------------------- render: index
  function overlayCounts(x) {
    const q = S.posters[x.key] ? P(x.key) : null;
    const c = { approved: 0, pending: 0, rejected: 0, total: 0, in: 0 };
    x.shots.forEach(s => { const v = (q && q.verdicts[s.id] && q.verdicts[s.id].v) || s.founder; c[v]++; c.total++; if (v !== 'rejected') c.in++; });
    if (q) q.added.forEach(() => { c.approved++; c.total++; c.in++; });
    return c;
  }
  function renderIndex() {
    (D.posters || []).forEach(function (x) {
      const q = S.posters[x.key] ? P(x.key) : null, c = overlayCounts(x);
      const edited = q && (Object.keys(q.verdicts).length || q.added.length || q.sheet || q.order);
      if (!edited || !x.shots.length) return;   // the built line stands unless he changed something here
      const el = $('[data-counts="' + x.key + '"]');
      if (el) el.innerHTML = c.in + ' in the lot' + (c.pending ? ' · ' + c.pending + ' new' : '') + (c.rejected ? ' · ' + c.rejected + ' dropped' : '') + ' · <span class="tinted">edited here</span>';
    });
  }

  // ---------------------------------------------------------------- the room (lightbox)
  let room = null;
  function attachZoom(stage, img, opts) {
    // two fingers pinch about their midpoint, double-tap toggles 2.5x at the tap, one finger pans when zoomed and swipes only when not
    opts = opts || {};
    const Z = { s: 1, x: 0, y: 0 }, pts = new Map();
    let lastTap = 0, start = null, pinch = null;
    img.style.transformOrigin = '0 0';
    let base = null;
    function measure() { const r = img.getBoundingClientRect(), sr = stage.getBoundingClientRect(); base = { L0: r.left - sr.left, T0: r.top - sr.top, w0: r.width, h0: r.height, sw: sr.width, sh: sr.height }; }
    function clamp() {
      if (Z.s === 1) { Z.x = 0; Z.y = 0; return; }
      if (!base) measure();
      const W = base.w0 * Z.s, H = base.h0 * Z.s;
      Z.x = W > base.sw ? Math.min(-base.L0, Math.max(base.sw - W - base.L0, Z.x)) : (base.sw - W) / 2 - base.L0;
      Z.y = H > base.sh ? Math.min(-base.T0, Math.max(base.sh - H - base.T0, Z.y)) : (base.sh - H) / 2 - base.T0;
    }
    function apply() { clamp(); img.style.transform = Z.s === 1 ? '' : 'translate(' + Z.x + 'px,' + Z.y + 'px) scale(' + Z.s + ')'; }
    function reset() { Z.s = 1; Z.x = 0; Z.y = 0; base = null; apply(); }
    function zoomAt(cx, cy, s) {
      if (Z.s === 1 || !base) { Z.x = 0; Z.y = 0; img.style.transform = ''; measure(); }
      const sr = stage.getBoundingClientRect();
      const px = (cx - sr.left - base.L0 - Z.x) / Z.s, py = (cy - sr.top - base.T0 - Z.y) / Z.s;
      s = Math.min(6, Math.max(1, s));
      Z.s = s; Z.x = (cx - sr.left) - base.L0 - px * s; Z.y = (cy - sr.top) - base.T0 - py * s;
      if (s === 1) { Z.x = 0; Z.y = 0; base = null; }
      apply();
    }
    stage.addEventListener('pointerdown', function (e) {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); try { stage.setPointerCapture(e.pointerId); } catch (x) { }
      if (pts.size === 1) start = { x: e.clientX, y: e.clientY, zx: Z.x, zy: Z.y, t: Date.now(), moved: false };
      if (pts.size === 2) { const a = Array.from(pts.values()); pinch = { d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y), s: Z.s, cx: (a[0].x + a[1].x) / 2, cy: (a[0].y + a[1].y) / 2 }; start = null; }
    });
    stage.addEventListener('pointermove', function (e) {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && pinch) { const a = Array.from(pts.values()); zoomAt(pinch.cx, pinch.cy, pinch.s * Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) / pinch.d); return; }
      if (start && pts.size === 1) {
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) start.moved = true;
        if (Z.s > 1) { Z.x = start.zx + dx; Z.y = start.zy + dy; apply(); }
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
      } else if (pts.size === 0) start = null;
    };
    stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
    return { reset: reset, zoomed: () => Z.s > 1 };
  }
  function openRoom(list, idx, opts) {
    opts = opts || {};
    closeRoom(); hideToast();
    let i = Math.max(0, idx || 0);
    const el = h('div', { class: 'room', role: 'dialog', 'aria-modal': 'true' });
    const bar = h('div', { class: 'bar' }), stage = h('div', { class: 'stage' }), img = h('img', { alt: '' });
    const meta = h('div', { class: 'meta' }), foot = h('div', { class: 'foot' });
    stage.appendChild(img); stage.appendChild(h('span', { class: 'hintz', text: 'double-tap to zoom · swipe for the next' }));
    ['tl', 'tr', 'bl', 'br'].forEach(c => stage.appendChild(h('i', { class: 'reg ' + c })));
    el.appendChild(bar); el.appendChild(stage); el.appendChild(meta); el.appendChild(foot);
    document.body.appendChild(el); document.body.classList.add('locked');
    // the image is capped by the stage's own size (a landscape viewport sized it by width and it overflowed)
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
      foot.appendChild(h('button', { type: 'button', class: 'nav', 'aria-label': 'Previous', text: '‹', onclick: () => go(-1), disabled: list.length < 2 || null }));
      if (judgeable) {
        const v = ev(s.id), pos = order().indexOf(s.id);
        meta.appendChild(h('span', { html: '<span class="n">' + (s.recipeLabel || '') + '</span>' + (v !== 'rejected' && pos >= 0 ? ' · <span class="n">' + (pos === 0 ? 'the cover' : '№ ' + (pos + 1)) + '</span>' : ' · dropped') }));
        // every keystroke is saved (a note followed by Drop / Next used to die with the field)
        const ta = h('textarea', { placeholder: 'Note', rows: 1 });
        ta.value = hisNote(s.id);
        ta.addEventListener('input', () => setNote(s.id, ta.value)); ta.addEventListener('change', () => setNote(s.id, ta.value.trim()));
        meta.appendChild(ta);
        if (v === 'rejected') foot.appendChild(h('button', { type: 'button', class: 'k', onclick: () => { verdict(s.id, 'approved', { quiet: true }); show(); } }, h('span', { class: 'x', text: '↶' }), 'Restore'));
        else foot.appendChild(h('button', { type: 'button', class: 'd', onclick: () => { verdict(s.id, 'rejected', { quiet: true }); show(); toast(s.id + ' · dropped'); } }, h('span', { class: 'x', text: '✗' }), s.archive ? 'Remove' : 'Drop'));
      } else {
        meta.appendChild(h('span', { text: s.label || s.recipeLabel || s.file || '' }));
      }
      if (!judgeable && D.kind === 'poster' && byId(s.id) && ev(s.id) === 'rejected') foot.appendChild(h('button', { type: 'button', class: 'k', onclick: () => { verdict(s.id, 'approved', { quiet: true }); toast(s.id + ' · back in the lot'); show(); } }, h('span', { class: 'x', text: '↶' }), 'Restore'));
      if (s.full || s.inspect) foot.appendChild(dlLink(s, 'dlf'));
      foot.appendChild(h('button', { type: 'button', class: 'nav', 'aria-label': 'Next', text: '›', onclick: () => go(1), disabled: list.length < 2 || null }));
    }
    function go(d) { if (list.length < 2) return; i = (i + d + list.length) % list.length; show(); }
    img.addEventListener('load', fit);
    const show0 = show;
    show = function () { show0(); fit(); requestAnimationFrame(fit); };
    room = { el: el, go: go, key: function (e) {
      if (e.key === 'Escape') closeRoom(); else if (e.key === 'ArrowRight') go(1); else if (e.key === 'ArrowLeft') go(-1);
      else if (D.kind === 'poster' && !opts.readonly && list[i] && byId(list[i].id)) { if (e.key === 'a' || e.key === 'k') { verdict(list[i].id, 'approved', { quiet: true }); show(); } else if (e.key === 'r' || e.key === 'x') { verdict(list[i].id, 'rejected', { quiet: true }); show(); } }
    } };
    show();
  }
  function closeRoom() {
    try { window.dispatchEvent(new Event('lomb-room-close')); } catch (e) { }
    if (room) { room.el.remove(); room = null; }
    document.body.classList.remove('locked');
    if (D.kind === 'poster') { renderLot(); renderPool(); }
  }
  // keys typed into any field belong to the field, never to the shortcuts
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
      const q = h('input', { type: 'search', placeholder: 'Search', autocomplete: 'off' });
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
              save(); render(); toast(it.label + ' · added to the lot'); draw();
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
    openDrawer('Sync', function (el) {
      const body = h('div', { class: 'body' }); el.appendChild(body);
      const dev = h('input', { value: S.device, placeholder: 'This device' });
      const note = h('textarea', { class: 'notefield', placeholder: 'A note for Claude, sent with the next Send', rows: 3 }); note.value = S.note || '';
      note.addEventListener('input', () => { S.note = note.value; save(); });
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
        status,
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'button', text: 'Send to Claude now', onclick: () => { sendMail(false, true).then(() => { drawStatus(); }); } }),
          h('button', { class: 'btn', type: 'button', text: 'Copy summary', onclick: () => { navigator.clipboard.writeText(summary()).then(() => toast('Summary copied · paste it to Claude')).catch(() => toast('Copy failed')); } }),
          h('button', { class: 'btn quiet', type: 'button', text: 'Share…', onclick: () => { if (navigator.share) navigator.share({ title: 'Lombardia board', text: summary() }).catch(() => { }); else toast('Sharing is not available here'); } })),
        h('div', { class: 'f' }, h('label', { text: 'A note for Claude' }), note),
        h('div', { class: 'f' }, h('label', { text: 'This device' }), dev),
        h('div', { class: 'f' }, h('label', { text: 'GitHub token (optional)' }), tok,
          h('div', { class: 'row' },
            h('button', { class: 'btn', type: 'button', text: 'Connect', onclick: () => { try { localStorage.setItem(TOK, tok.value.trim()); } catch (e) { } if (tok.value.trim()) { pushGithub().then(() => { drawStatus(); toast(gh && gh.ok ? 'GitHub connected and committed' : 'GitHub refused it (' + (gh && gh.status) + ')'); }); } else { gh = null; drawStatus(); toast('GitHub disconnected'); } } }),
            h('a', { class: 'btn quiet', href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener', text: 'Make one ↗' }))),
        h('div', { class: 'f' }, h('label', { text: 'Summary Claude reads' }), h('pre', { text: summary() })),
        h('div', { class: 'row' },
          h('button', { class: 'btn quiet', type: 'button', text: 'Forget local decisions', onclick: () => { if (confirm('Forget every unsent decision on this device?')) { S = { v: 1, savedAt: null, device: S.device, posters: {} }; persist(); setDirty(false); location.reload(); } } }))));
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
      vs.forEach(id => { const e = q.verdicts[id]; (by[e.v] || by.pending).push(id + (e.note ? ' ("' + e.note + '")' : (e.note === '' ? ' (note cleared)' : ''))); });
      if (by.approved.length) lines.push('keep: ' + by.approved.join(', '));
      if (by.rejected.length) lines.push('drop: ' + by.rejected.join(', '));
      if (by.pending.length) lines.push('back to waiting: ' + by.pending.join(', '));
      (q.added || []).forEach(a => lines.push('add: ' + a.id + ' <- ' + a.src));
      const ord = (D.kind === 'poster' && k === D.key) ? order() : q.order;
      if (ord && ord.length) lines.push('order: ' + ord.join(', ') + '  (all go up; the house third and last)');
      if (D.kind === 'poster' && k === D.key) { lines.push('upload: ' + uploadList().map(x => x.house ? 'HOUSE ' + x.house.id : x.id).join(', ')); }
    });
    if (lines.length <= 3 && !Object.keys(S.posters).length) lines.push('', 'no decisions yet');
    return lines.join('\n');
  }
  function scheduleSync() {
    // nothing leaves the phone until he presses Send; only a connected GitHub token commits on its own
    if (token()) { clearTimeout(ghTimer); ghTimer = setTimeout(pushGithub, 3000); }
    renderSendbar();
  }
  // what is on this device and newer than the last successful send (the snapshot resends everything;
  // the pipeline skips what it already has, so the count here is what is actually new for Claude)
  const lastSent = () => (sent && sent.ok && sent.at) ? Date.parse(sent.at) : 0;
  const fresh = at => !!at && Date.parse(at) > lastSent();
  function unsentCount() {
    let c = 0;
    Object.keys(S.posters).forEach(k => {
      const q = S.posters[k];
      c += Object.keys(q.verdicts || {}).filter(id => fresh(q.verdicts[id].at)).length + (q.added || []).filter(a => fresh(a.at)).length + (q.sheet && fresh(q.sheet.at) ? 1 : 0);
    });
    return c;
  }
  function nameOf(key) {
    if (D.kind === 'poster' && key === D.key) return D.name;
    const x = (D.posters || []).find(y => y.key === key);
    return x ? x.name : key.replace(/-/g, ' ');
  }
  // one line per lot: "Porsche 911 Turbo (930) · 2 decisions · order changed"
  function pendingLines() {
    const lines = [];
    Object.keys(S.posters).forEach(k => {
      const q = S.posters[k]; const parts = [];
      const c = Object.keys(q.verdicts || {}).filter(id => fresh(q.verdicts[id].at)).length + (q.added || []).filter(a => fresh(a.at)).length;
      if (c) parts.push(c + ' decision' + (c === 1 ? '' : 's'));
      if (q.sheet && fresh(q.sheet.at)) parts.push('sheet ' + (q.sheet.v === 'approved' ? 'approved' : 'sent back'));
      if (q.order && fresh(q.orderAt)) parts.push('order changed');
      if (parts.length) lines.push({ key: k, name: nameOf(k), text: parts.join(' · ') });
    });
    return lines;
  }
  function unseenCount() { return D.kind === 'poster' && p ? allShots().filter(s => ev(s.id) === 'pending').length : 0; }
  function allNotes() {
    const notes = [];
    Object.keys(S.posters || {}).forEach(function (k) {
      const q = S.posters[k]; if (!q) return;
      if (q.sheet && q.sheet.note && fresh(q.sheet.at)) notes.push({ id: k + ' · sheet ' + q.sheet.v, note: q.sheet.note });
      Object.keys(q.verdicts || {}).forEach(function (id) { const e = q.verdicts[id]; if (e && e.note && fresh(e.at)) notes.push({ id: id, note: e.note }); });
    });
    if (S.note) notes.push({ id: 'for Claude', note: S.note });
    return notes;
  }
  function renderSendbar() {
    let bar = $('#sendbar'); if (!bar) { bar = h('div', { id: 'sendbar', class: 'sendbar' }); document.body.appendChild(bar); }
    bar.innerHTML = ''; bar.className = 'sendbar';
    const unseen = unseenCount();
    // founder 2026-09-05: "u leave the note, press a button and it gets over ... make it clear" - the bar says
    // what is waiting, what went, and stays on screen after a send until he dismisses it
    if (justSent) {
      bar.classList.add('on', 'sent'); document.body.classList.add('has-sendbar');
      bar.appendChild(h('span', { class: 'sb-text' }, h('i', { class: 'dot ok' }), h('span', { class: 'sb-lines' }, h('b', { text: 'Sent to Claude · ' + hhmm(justSent.at) }),
        h('span', { text: (justSent.n ? justSent.n + ' decision' + (justSent.n === 1 ? '' : 's') : 'the lot') + (justSent.notes ? ' · ' + justSent.notes + ' note' + (justSent.notes === 1 ? '' : 's') : '') + (justSent.via ? ' · via ' + justSent.via : '') }))));
      bar.appendChild(h('button', { class: 'btn', type: 'button', text: 'OK', onclick: () => { justSent = null; renderSendbar(); } }));
      return;
    }
    if (sent && !sent.ok && !dirty && sent.shown !== true) { /* a failed send with nothing new: the title block says so */ }
    if (!dirty && !unseen) { bar.classList.remove('on'); document.body.classList.remove('has-sendbar'); return; }
    bar.classList.add('on'); document.body.classList.add('has-sendbar');
    const lines = pendingLines();
    if (unseen) {
      const mine = lines.find(l => l.key === D.key);
      if (mine) mine.text += ' · ' + unseen + ' new, in by default'; else lines.unshift({ key: D.key, name: D.name, text: unseen + ' new, in the lot by default' });
    }
    if (!lines.length) lines.push({ key: '', name: '', text: 'changes' });
    bar.appendChild(h('span', { class: 'sb-text' }, h('i', { class: 'dot' }), h('span', { class: 'sb-lines' },
      lines.map(l => h('span', { class: 'sb-line' + (D.kind === 'poster' && l.key === D.key ? ' here' : '') }, l.name ? h('b', { text: l.name + ' · ' }) : null, l.text)),
      h('span', { class: 'sb-not', text: 'not sent yet' }))));
    const notes = allNotes();
    if (notes.length) {
      const nl = h('div', { class: 'sb-notes' });
      notes.forEach(n => nl.appendChild(h('div', { class: 'sb-note' }, h('b', { text: n.id }), ' ', h('span', { text: '“' + n.note + '”' }))));
      bar.appendChild(nl);
    }
    if (sent && !sent.ok && sent.at && (!S.savedAt || Date.parse(sent.at) > Date.parse(S.savedAt))) bar.appendChild(h('div', { class: 'sb-fail', text: 'Last send failed · ' + (sent.err || '') }));
    const btn = h('button', { class: 'btn primary big', type: 'button', text: sending ? 'Sending…' : 'Send to Claude', disabled: sending || null, onclick: () => {
      sending = true; renderSendbar();
      sendMail(false, true).then(() => { sending = false; renderSendbar(); if (!(sent && sent.ok)) toast('Send failed · ' + ((sent && sent.err) || '') + ' · use Copy in Sync', { label: 'Sync', fn: openSettings }); });
    } });
    bar.appendChild(btn);
  }
  // Both relays choke on non-ASCII, so everything that leaves the page is 7-bit: symbols mapped, the JSON with \uXXXX escapes
  function ascii(t) { return String(t).replace(/·/g, '-').replace(/←/g, '<-').replace(/→/g, '->').replace(/[✓✔]/g, 'OK').replace(/[✗✘×]/g, 'X').replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'").replace(/…/g, '...').replace(/[–—]/g, '-').replace(/[^\x00-\x7f]/g, '?'); }
  function asciiJSON(o) { return JSON.stringify(o).replace(/[\u007f-\uffff]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4)); }
  function sendMail(keepalive, manual) {
    if (!D.cfg || !(D.cfg.form || D.cfg.ntfy)) return Promise.resolve();
    if (!dirty && !unseenCount()) return Promise.resolve();
    // a local preview never posts on its own; the Send button still works
    if (!manual && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return Promise.resolve();
    if (D.kind === 'poster' && p) {
      materialize();
      const o = order(); if (!p.order || p.order.join() !== o.join() || !p.orderAt) { p.order = o; p.orderAt = nowISO(); }
      S.savedAt = nowISO(); persist();
    }
    const n = unsentCount(), notes = allNotes().length;
    const title = ascii('Lombardia board - ' + S.device + ' - ' + new Date().toLocaleString());
    const sum = ascii(summary()), json = asciiJSON(snapshot());
    const jobs = [];
    if (D.cfg.ntfy) {
      // ntfy.sh: the summary as the message (kept 12 h), the JSON as an attachment (kept 3 h); python lotset.py inbox reads both
      jobs.push(fetch(D.cfg.ntfy, { method: 'POST', keepalive: !!keepalive, headers: { 'Title': title, 'Tags': 'clipboard' }, body: sum }).then(r => r.ok ? 'ntfy' : Promise.reject(new Error('ntfy ' + r.status)))
        .then(v => fetch(D.cfg.ntfy, { method: 'PUT', keepalive: !!keepalive, headers: { 'Filename': 'decisions.json', 'Title': title }, body: json }).then(() => v, () => v)));
    }
    if (D.cfg.form) {
      // form-encoded on purpose: FormSubmit drops the fields and the subject from JSON bodies
      jobs.push(fetch(D.cfg.form, { method: 'POST', keepalive: !!keepalive, headers: { 'Accept': 'application/json' }, body: new URLSearchParams({ _subject: title, summary: sum, decisions: json }) })
        .then(r => r.json()).then(j => (j && (j.success === 'true' || j.success === true)) ? 'mail' : Promise.reject(new Error((j && j.message) || 'mail failed'))));
    }
    return Promise.allSettled(jobs).then(function (rs) {
      const ok = rs.filter(r => r.status === 'fulfilled').map(r => r.value), bad = rs.filter(r => r.status === 'rejected').map(r => String(r.reason && r.reason.message || r.reason));
      if (ok.length) { sent = { at: nowISO(), ok: true, via: ok.join('+'), warn: bad.join('; ') }; setDirty(false); justSent = { at: sent.at, n: n, notes: notes, via: sent.via }; hideToast(); }
      else sent = { at: nowISO(), ok: false, err: bad.join('; ') || 'send failed' };
      try { localStorage.setItem(SENT, JSON.stringify(sent)); } catch (e) { }
      if (D.kind === 'poster') { renderLot(); renderPool(); }
      renderTitleblock();
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
      if (c.total) row('The lot', c.in + ' in' + (c.pending ? ' · ' + c.pending + ' new' : '') + ' · ' + c.rejected + ' dropped' + (p.added.length ? ' · ' + p.added.length + ' from the archive' : ''));
      if (o.length) row('Order', o.slice(0, 4).map((id, i) => (i + 1) + ' ' + id).join(' · ') + (o.length > 4 ? ' · +' + (o.length - 4) : ''));
    } else if (D.kind === 'index') {
      const ps = D.posters || [];
      let a = 0, w = 0; ps.forEach(x => { const c = overlayCounts(x); a += c.in; w += c.pending; });
      row('Board', ps.length + ' posters · ' + a + ' in the lots · ' + w + ' new');
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

  // ---------------------------------------------------------------- copy buttons (listing text)
  document.addEventListener('click', function (e) {
    const b = e.target.closest('.cp'); if (!b) return;
    navigator.clipboard.writeText(b.dataset.copy).then(() => { const was = b.textContent; b.textContent = 'Copied'; b.classList.add('ok'); setTimeout(() => { b.textContent = was; b.classList.remove('ok'); }, 1400); }).catch(() => { b.textContent = 'Copy failed'; });
  });

  // ---------------------------------------------------------------- go
  render();
  if (D.kind === 'poster') {
    const map = { '#review': '#sec-order', '#order': '#sec-order', '#sheet': '#sec-sheet', '#judge': '#sec-order', '#sec-post': '#sec-stores', '#photos': '#sec-photos' };
    if (location.hash === '#archive') setTimeout(openArchive, 60);
    else if (location.hash) { const t = $(map[location.hash] || location.hash); if (t) setTimeout(() => t.scrollIntoView({ block: 'start' }), 60); }
  }
})();
