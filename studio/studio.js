/* The Studio - three steps: which artwork, what do you want, review and send.
   The draft lives on this device (localStorage) until Send, bound to the master hash he looked at when
   he chose the artwork; a rebuild that changes that hash makes the draft stale and he chooses again.
   Send posts through the EXISTING route the board has used since 4 September (pipeline/board.config.json):
   FormSubmit -> the founder's Gmail, and the ntfy topic. Both relays choke on non-ASCII, so everything
   that leaves the page is 7-bit (board.js ascii()/asciiJSON, kept identical). "Sent" means FormSubmit
   answered success; ntfy alone is reported as a notification only and the draft is kept. The page never
   says "received" - the agent reads the inbox in the next task (pipeline/STUDIO-REQUESTS.md). */
(function () {
  'use strict';
  const DATA = window.STUDIO_DATA || { items: [], collections: [], route: {} };
  const KEY = 'lomb.studio.v2';
  const $ = (s, el) => (el || document).querySelector(s);
  const nowISO = () => new Date().toISOString();
  const hhmm = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const dmy = iso => iso ? new Date(iso).toLocaleDateString([], { day: '2-digit', month: 'short' }) + ' ' + hhmm(iso) : '';
  const IS_TEST = /(^|[?&])test=1(&|$)/.test(location.search);

  function h(tag, attrs) {
    const el = document.createElement(tag); attrs = attrs || {};
    for (const k in attrs) {
      const v = attrs[k]; if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else if (k === 'html') el.innerHTML = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i]; if (c === null || c === undefined || c === false) continue;
      (Array.isArray(c) ? c : [c]).forEach(x => x && el.appendChild(typeof x === 'string' ? document.createTextNode(x) : x));
    }
    return el;
  }
  let toastTimer = null;
  function toast(msg) { const t = $('#toast'); if (!t) return; t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2800); }
  function uuid() { return (crypto.randomUUID ? crypto.randomUUID() : 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)); }

  // ---------------------------------------------------------------- the request types
  const OTHER = '__other__';
  const TYPES = [
    { id: 'approve', label: 'Approve the artwork', desc: 'Build the lot from this exact master: prints, nine photos, listing, Notion. Needs a collection.', needs: 'artwork', collection: true },
    { id: 'edit', label: 'Request an edit', desc: 'Say what should change on the artwork. The agent edits this exact master.', needs: 'artwork', note: true },
    { id: 'reject', label: 'Reject the artwork', desc: 'Retire this artwork. A short reason helps the next one.', needs: 'artwork', note: true },
    { id: 'lot', label: 'Photos or listing', desc: 'A note on the lot photographs, the title, the description or the fields.', needs: 'lot', note: true },
    { id: 'other', label: 'Something else', desc: 'A new poster idea, a question, anything that is not one of the above.', needs: null, note: true }
  ];
  const typeById = id => TYPES.find(t => t.id === id);
  const itemByKey = key => DATA.items.find(x => x.key === key);
  const validCollection = c => !!c && DATA.collections.indexOf(c) >= 0;

  // ---------------------------------------------------------------- store
  function load() {
    try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.v === 2) return s; } catch (e) { }
    return { v: 2, draft: null, sent: [] };
  }
  let S = load();
  if (!Array.isArray(S.sent)) S.sent = [];
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(S)); return true; } catch (e) { return false; } }
  function newDraft(key) {
    const p = key && key !== OTHER ? itemByKey(key) : null;
    return { id: uuid(), key: key || null, artwork_sha256: p ? (p.source_sha256 || null) : null, artwork_name: p ? p.name : null,
      type: key === OTHER ? 'other' : null, collection: null, note: '', created_at: nowISO(), updated_at: nowISO(), step: 1 };
  }
  function draft() { if (!S.draft) S.draft = newDraft(null); return S.draft; }
  function touch() { draft().updated_at = nowISO(); const ok = persist(); renderDraftline(ok); renderTitleblock(); }
  // a saved draft is checked against the current build: unknown artwork, changed master, unknown type or collection
  function reconcile() {
    const d = S.draft; if (!d) return;
    d.stale = null;
    if (d.key && d.key !== OTHER) {
      const p = itemByKey(d.key);
      if (!p) d.stale = 'That artwork is no longer in the Studio. Choose again.';
      else if ((p.source_sha256 || null) !== (d.artwork_sha256 || null)) d.stale = 'The artwork changed since you drafted this (new master ' + (p.source_sha256 || '').slice(0, 12) + '). Look at it again and choose it afresh.';
    }
    if (d.type && !typeById(d.type)) d.type = null;
    if (d.collection && !validCollection(d.collection)) d.collection = null;
    if (d.stale) { d.key = null; d.artwork_sha256 = null; d.step = 1; }
    persist();
  }
  reconcile();

  // ---------------------------------------------------------------- state of an artwork, in his words
  function stateLine(p) {
    if (!p) return '';
    const bits = [];
    if (p.recorded_approval === 'owner_review_pending') bits.push('new hero · your review');
    else if (p.owner_collection_pending) bits.push('approved · collection needed');
    else if (p.recorded_approval === 'approved') bits.push('approved');
    else if (p.recorded_approval === 'rejected') bits.push('sent back');
    else bits.push('waiting for your word');
    if (p.saved_collection) bits.push(p.saved_collection + ' · your choice');
    if (p.delivery_status && !/^Approved/.test(p.delivery_status)) bits.push(p.delivery_status.toLowerCase());
    return bits.filter((b, i) => bits.indexOf(b) === i).join(' · ');
  }
  function collectionOf(p) { return p ? (p.saved_collection || p.collection_choice || '') : ''; }
  function isLandscape(p) { return p && p.preview_pixels && p.preview_pixels[0] > p.preview_pixels[1]; }

  // ---------------------------------------------------------------- 01 · the grid
  function renderGrid() {
    const g = $('#grid'); g.innerHTML = '';
    const term = ($('#search').value || '').trim().toLowerCase();
    const d = draft();
    const list = DATA.items.filter(p => !term || (p.name + ' ' + (p.existing_collection || '') + ' ' + (p.saved_collection || '') + ' ' + p.key).toLowerCase().indexOf(term) >= 0);
    list.forEach(p => {
      const on = d.key === p.key;
      g.appendChild(h('article', { class: 'card' + (on ? ' on' : '') + (isLandscape(p) ? ' land' : ''), role: 'listitem', 'data-key': p.key },
        h('a', { class: 'cimg', href: p.preview, onclick: e => { e.preventDefault(); openViewer(p); } }, h('img', { src: p.preview, alt: p.name + ' · artwork', loading: 'lazy', decoding: 'async' })),
        h('div', { class: 'cbody' },
          h('span', { class: 'ccoll', text: collectionOf(p) || p.existing_collection || 'collection not chosen' }),
          h('span', { class: 'cname', text: p.name }),
          h('span', { class: 'cstate', text: stateLine(p) }),
          h('div', { class: 'cacts' },
            h('button', { type: 'button', text: 'View', 'aria-label': 'View ' + p.name, onclick: () => openViewer(p) }),
            h('button', { type: 'button', class: 'pick', text: on ? 'Chosen' : 'Choose', 'aria-pressed': String(on), 'aria-label': (on ? 'Chosen: ' : 'Choose ') + p.name, onclick: () => pick(p.key) })))));
    });
    const onOther = d.key === OTHER;
    g.appendChild(h('article', { class: 'card other' + (onOther ? ' on' : ''), role: 'listitem' },
      h('span', { class: 'cimg', 'aria-hidden': 'true', text: '+' }),
      h('div', { class: 'cbody' }, h('span', { class: 'ccoll', text: 'no artwork' }), h('span', { class: 'cname', text: 'Something else' }),
        h('span', { class: 'cstate', text: 'a new poster idea, a question, a note' }),
        h('div', { class: 'cacts' }, h('button', { type: 'button', class: 'pick', text: onOther ? 'Chosen' : 'Choose', 'aria-pressed': String(onOther), onclick: () => pick(OTHER) })))));
    if (!list.length) g.insertBefore(h('p', { class: 'empty', text: 'Nothing matches that. Clear the search.' }), g.firstChild);
  }
  function pick(key) {
    const d = draft();
    if (d.key !== key) {
      const keep = d.note;                                     // a note written first survives a change of artwork
      S.draft = newDraft(key); S.draft.note = keep;
    }
    touch(); renderGrid();
    go(2);
  }

  // ---------------------------------------------------------------- 02 · the request
  function renderRequest() {
    const d = draft(), p = d.key && d.key !== OTHER ? itemByKey(d.key) : null;
    const pk = $('#picked'); pk.innerHTML = '';
    if (p) {
      pk.appendChild(h('img', { src: p.preview, alt: '' }));
      pk.appendChild(h('div', { class: 'pk' }, h('b', { text: p.name }), h('span', { text: stateLine(p) }),
        h('span', { text: (p.photo_count ? p.photo_count + ' lot photos' : 'no lot photos yet') + ' · chosen ' + hhmm(d.created_at) }),
        h('button', { type: 'button', class: 'change', text: 'Change artwork', onclick: () => go(1) })));
    } else {
      pk.appendChild(h('span', { class: 'cimg', 'aria-hidden': 'true', style: 'display:grid;place-items:center;width:96px;aspect-ratio:3/4;border:1px solid var(--rule);background:var(--paper-3);font:700 40px var(--cond);color:var(--ink-3)', text: '+' }));
      pk.appendChild(h('div', { class: 'pk' }, h('b', { text: 'Something else' }), h('span', { text: 'no artwork attached' }),
        h('button', { type: 'button', class: 'change', text: 'Choose an artwork instead', onclick: () => go(1) })));
    }
    // request types
    const ts = $('#types'); Array.from(ts.querySelectorAll('.opt')).forEach(x => x.remove());
    TYPES.forEach(t => {
      const na = (t.needs === 'artwork' && !p) || (t.needs === 'lot' && !(p && p.photo_count));
      const on = d.type === t.id;
      const input = h('input', { type: 'radio', name: 'type', value: t.id, id: 'type-' + t.id, checked: on || null, disabled: na || null,
        onchange: () => { d.type = t.id; if (!t.collection) d.collection = null; touch(); renderRequest(); } });
      ts.appendChild(h('label', { class: 'opt' + (on ? ' on' : '') + (na ? ' na' : ''), for: 'type-' + t.id }, input,
        h('span', {}, h('b', { text: t.label }), h('span', { text: na ? (t.needs === 'lot' ? 'This artwork has no lot photos yet.' : 'Choose an artwork first.') : t.desc }))));
    });
    // collection (approve only)
    const t = typeById(d.type), cw = $('#collections');
    cw.hidden = !(t && t.collection);
    if (t && t.collection) {
      const saved = collectionOf(p);
      if (saved && !d.collection && validCollection(saved)) d.collection = saved;
      $('#collhint').textContent = p && p.saved_collection ? 'Your saved choice is ' + p.saved_collection + '. Change it here if you want.' : (saved ? 'The existing label is ' + saved + '.' : 'Choose one of the five. Nothing is assigned on its own.');
      const co = $('#collopts'); co.innerHTML = '';
      DATA.collections.forEach(c => {
        const on = d.collection === c, id = 'coll-' + c.replace(/\W+/g, '-');
        co.appendChild(h('label', { class: 'opt' + (on ? ' on' : ''), for: id },
          h('input', { type: 'radio', name: 'collection', value: c, id: id, checked: on || null, onchange: () => { d.collection = c; touch(); renderRequest(); } }),
          h('span', {}, h('b', { text: c }))));
      });
    }
    const note = $('#note'); if (note.value !== (d.note || '')) note.value = d.note || '';
    $('#notelabel').textContent = t && t.note ? 'Notes · needed' : 'Notes · optional';
    $('#notehint').textContent = t ? (t.id === 'approve' ? 'Anything the agent should know while building the lot.' : t.id === 'edit' ? 'Be concrete: what, where on the poster, and how it should look.' : '') : 'Pick a request above.';
    $('#notehint').classList.remove('err'); note.removeAttribute('aria-invalid');
    renderBar();
  }
  $('#note').addEventListener('input', () => { draft().note = $('#note').value; touch(); renderBar(); });
  $('#search').addEventListener('input', renderGrid);

  function problems() {
    const d = draft(), t = typeById(d.type), p = d.key && d.key !== OTHER ? itemByKey(d.key) : null;
    const out = [];
    if (!d.key) out.push('Choose an artwork, or Something else.');
    if (p && (p.source_sha256 || null) !== (d.artwork_sha256 || null)) out.push('The artwork changed since you chose it. Choose it again.');
    if (!t) out.push('Pick a request.');
    if (t && t.needs === 'artwork' && !p) out.push('That request needs an artwork.');
    if (t && t.needs === 'lot' && !(p && p.photo_count)) out.push('That request needs a lot with photos.');
    if (t && t.collection && !validCollection(d.collection)) out.push('Choose a collection.');
    if (t && t.note && !(d.note || '').trim()) out.push('Write a note.');
    if (p && !p.source_sha256) out.push('This artwork has no bound master; the agent cannot act on it.');
    return out;
  }

  // ---------------------------------------------------------------- 03 · review and send
  function deviceName() { const u = navigator.userAgent; return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'PC' : 'device'; }
  function requestObject(d, sentAt) {
    const p = d.key && d.key !== OTHER ? itemByKey(d.key) : null, t = typeById(d.type);
    return {
      kind: 'lombardia_studio_request', schema_version: 2, request_id: d.id, created_at: d.created_at, sent_at: sentAt || null, is_test: IS_TEST,
      request_type: d.type, request_label: t ? t.label : '',
      lot_key: p ? p.key : null, artwork_name: p ? p.name : null, artwork_sha256: d.artwork_sha256 || null, source_file: p ? p.source_file : null,
      recorded_stage: p ? p.recorded_stage : null, recorded_approval: p ? p.recorded_approval : null,
      collection: d.collection || null, previous_collection: p ? (p.saved_collection || p.existing_collection || null) : null,
      note: d.note || '', notion_url: p ? p.notion_url : null, board_url: p ? p.board_url : null,
      studio_built: DATA.built || '', device: deviceName()
    };
  }
  function summaryText(r) {
    const lines = [(r.is_test ? '[TEST] ' : '') + 'LOMBARDIA STUDIO REQUEST - ' + r.device + ' - ' + new Date().toLocaleString()];
    if (r.is_test) lines.push('THIS IS A TEST SUBMISSION - not an approval, not a task.');
    lines.push('', 'Request: ' + r.request_label + (r.request_type ? ' [' + r.request_type + ']' : ''));
    if (r.lot_key) { lines.push('Artwork: ' + r.artwork_name, 'Lot: ' + r.lot_key, 'Master SHA256: ' + r.artwork_sha256); }
    else lines.push('Artwork: none (general request)');
    if (r.request_type === 'approve') lines.push('Collection: ' + (r.collection || 'not chosen - do not assign'));
    lines.push('Notes: ' + (r.note || 'none'));
    lines.push('', 'Request id: ' + r.request_id, 'Apply only to this exact master hash. Sent from the Studio; not read automatically.');
    return lines.join('\n');
  }
  let sending = false, sentView = null;   // sentView: the record just sent, shown in place of the draft
  function renderReview() {
    const rv = $('#review'); rv.innerHTML = '';
    if (sentView) { renderSentView(); return; }
    const d = draft(), r = requestObject(d, null), p = r.lot_key ? itemByKey(r.lot_key) : null;
    const row = (k, v) => rv.appendChild(h('div', {}, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v })));
    rv.appendChild(h('div', { class: 'head' }, p ? h('img', { src: p.preview, alt: '' }) : h('span', { 'aria-hidden': 'true', style: 'display:grid;place-items:center;width:72px;aspect-ratio:3/4;border:1px solid var(--rule);background:var(--paper-3);font:700 30px var(--cond);color:var(--ink-3)', text: '+' }),
      h('div', {}, h('b', { text: p ? p.name : 'Something else' }), h('span', { text: r.request_label + (IS_TEST ? ' · TEST' : '') }))));
    if (r.request_type === 'approve') row('Collection', r.collection || 'not chosen');
    if (p && r.request_type === 'approve' && p.saved_collection && p.saved_collection !== r.collection) row('Changes', 'your saved choice was ' + p.saved_collection);
    row('Notes', r.note || 'none');
    const route = DATA.route || {};
    $('#routenote').textContent = (route.form || route.ntfy)
      ? 'Send puts this request in the Lombardia inbox on the route the board has always used. It is not read automatically; the agent reads it in the next task. Nothing leaves this page until you press Send.'
      : 'No request route is configured on this build. Use Copy and paste the request into the task.';
    $('#payload').textContent = summaryText(r) + '\n\n---- agent metadata ----\n' + JSON.stringify(r, null, 1);
    $('#send').hidden = false; $('#copy').hidden = false; $('#share').hidden = false; const nb = $('#newreq'); if (nb) nb.remove();
    renderStatus();
  }
  function renderSentView() {
    const rv = $('#review'), s = sentView, r = s.request, p = r.lot_key ? itemByKey(r.lot_key) : null;
    const row = (k, v) => rv.appendChild(h('div', {}, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v })));
    rv.appendChild(h('div', { class: 'head' }, p ? h('img', { src: p.preview, alt: '' }) : h('span', { 'aria-hidden': 'true', style: 'display:grid;place-items:center;width:72px;aspect-ratio:3/4;border:1px solid var(--rule);background:var(--paper-3);font:700 30px var(--cond);color:var(--ink-3)', text: '+' }),
      h('div', {}, h('b', { text: r.artwork_name || 'Something else' }), h('span', { text: r.request_label + (r.is_test ? ' · TEST' : '') }))));
    if (r.request_type === 'approve') row('Collection', r.collection || 'not chosen');
    row('Notes', r.note || 'none');
    row('Sent', dmy(s.at) + ' · via ' + s.via);
    $('#routenote').textContent = 'In the Lombardia inbox. The agent reads it in the next task; nothing happens on its own.';
    $('#payload').textContent = summaryText(r) + '\n\n---- agent metadata ----\n' + JSON.stringify(r, null, 1);
    $('#send').hidden = true; $('#copy').hidden = true; $('#share').hidden = true;
    if (!$('#newreq')) $('.acts').appendChild(h('button', { class: 'btn primary big', type: 'button', id: 'newreq', text: 'New request', onclick: () => { sentView = null; lastSend = null; renderAll(1); } }));
    renderStatus();
  }
  let lastSend = null;   // {draftId, ok, at, via, err, partial} for the current draft
  function renderStatus() {
    const st = $('#status'); st.className = 'status'; st.innerHTML = '';
    if (sentView) { st.classList.add('ok'); st.append(h('i', { class: 'dot' }), h('span', {}, h('b', { text: 'Sent · ' + hhmm(sentView.at) + ' · via ' + sentView.via }), sentView.warn ? ' · ' + sentView.warn : '')); $('#send').disabled = true; return; }
    const d = draft();
    if (sending) { st.classList.add('wait'); st.append(h('i', { class: 'dot' }), h('span', { text: 'Sending…' })); }
    else if (lastSend && lastSend.draftId === d.id && !lastSend.ok) {
      st.classList.add('bad'); st.append(h('i', { class: 'dot' }), h('span', {}, h('b', { text: lastSend.partial ? 'Notification sent, email failed' : 'Not sent' }),
        ' · ' + (lastSend.err || 'the route did not answer') + '. Your draft is kept: send again, or use Copy request and paste it into the task.'));
    } else st.append(h('i', { class: 'dot' }), h('span', { text: 'Not sent yet. Your draft is saved on this device.' }));
    $('#send').disabled = sending;
    $('#send').textContent = lastSend && lastSend.draftId === d.id && lastSend.partial ? 'Send the email again' : 'Send request';
  }
  function ascii(t) { return String(t).replace(/·/g, '-').replace(/←/g, '<-').replace(/→/g, '->').replace(/[✓✔]/g, 'OK').replace(/[✗✘×]/g, 'X').replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'").replace(/…/g, '...').replace(/[–—]/g, '-').replace(/[^\x00-\x7f]/g, '?'); }
  function asciiJSON(o) { return JSON.stringify(o).replace(/[\u007f-￿]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4)); }
  function send() {
    const route = DATA.route || {}; const probs = problems();
    if (probs.length) { toast(probs[0]); go(2); markProblems(probs); return; }
    if (!(route.form || route.ntfy)) { toast('No route configured · use Copy request'); return; }
    const d = draft(), at = nowISO(), r = requestObject(d, at);
    const title = ascii((r.is_test ? '[TEST] ' : '') + 'Lombardia board - Studio - ' + r.request_label + (r.artwork_name ? ' - ' + r.artwork_name : '') + ' - ' + r.device);
    const sum = ascii(summaryText(r)), json = asciiJSON(r);
    const skipNtfy = lastSend && lastSend.draftId === d.id && lastSend.partial;   // the notification already went once
    sending = true; renderStatus();
    const jobs = [];
    if (route.ntfy && !skipNtfy) jobs.push(fetch(route.ntfy, { method: 'POST', headers: { 'Title': title, 'Tags': 'art' }, body: sum }).then(x => x.ok ? 'ntfy' : Promise.reject(new Error('ntfy ' + x.status)))
      .then(v => fetch(route.ntfy, { method: 'PUT', headers: { 'Filename': 'studio-request.json', 'Title': title }, body: json }).then(() => v, () => v)));
    const mail = route.form ? fetch(route.form, { method: 'POST', headers: { 'Accept': 'application/json' }, body: new URLSearchParams({ _subject: title, summary: sum, request: json }) })
      .then(x => x.json()).then(j => (j && (j.success === 'true' || j.success === true)) ? 'mail' : Promise.reject(new Error((j && j.message) || 'mail failed'))) : Promise.reject(new Error('no mail route'));
    jobs.push(mail);
    return Promise.allSettled(jobs).then(rs => {
      const ok = rs.filter(x => x.status === 'fulfilled').map(x => x.value), bad = rs.filter(x => x.status === 'rejected').map(x => String(x.reason && x.reason.message || x.reason));
      sending = false;
      if (ok.indexOf('mail') >= 0) {
        const via = ok.concat(skipNtfy ? ['ntfy (earlier)'] : []).join('+');
        sentView = { id: d.id, at: at, via: via, warn: bad.length ? 'notification failed: ' + bad.join('; ') : '', request: r };
        S.sent.unshift({ id: d.id, at: at, via: via, request: r }); S.sent = S.sent.slice(0, 40);
        S.draft = null; lastSend = null; persist();
        toast('Sent · ' + via);
        renderSent(); renderDraftline(true); renderTitleblock(); renderReview();
      } else {
        lastSend = { draftId: d.id, ok: false, at: at, partial: ok.indexOf('ntfy') >= 0 || skipNtfy, err: bad.join('; ') || 'send failed' };
        renderStatus();
      }
    });
  }
  function copyText() {
    const r = sentView ? sentView.request : requestObject(draft(), null), text = summaryText(r) + '\n\n---- agent metadata ----\n' + JSON.stringify(r);
    return navigator.clipboard.writeText(text).then(() => toast('Copied · paste it into the task'), () => { $('#payload').textContent = text; $('.meta').open = true; toast('Copy failed · select the text below'); });
  }
  $('#send').addEventListener('click', send);
  $('#copy').addEventListener('click', copyText);
  $('#share').addEventListener('click', () => { const r = requestObject(draft(), null); if (navigator.share) navigator.share({ title: 'Lombardia Studio request', text: summaryText(r) }).catch(() => { }); else toast('Sharing is not available here'); });

  // ---------------------------------------------------------------- sent list
  function renderSent() {
    const w = $('#sentwrap'), ul = $('#sentlist'); ul.innerHTML = '';
    w.hidden = !S.sent.length; $('#sentcount').textContent = S.sent.length ? String(S.sent.length) : '';
    S.sent.forEach(s => {
      const r = s.request || {};
      ul.appendChild(h('li', {}, h('span', { class: 'folio', text: dmy(s.at) }),
        h('span', { class: 'what', text: (r.is_test ? '[TEST] ' : '') + (r.request_label || '') + (r.artwork_name ? ' · ' + r.artwork_name : '') + (r.collection ? ' · ' + r.collection : '') }),
        h('span', { class: 'via', text: 'sent via ' + (s.via || '') + ' · ' + (r.request_id || '').slice(0, 8) + (r.artwork_sha256 ? ' · master ' + r.artwork_sha256.slice(0, 12) : '') })));
    });
  }

  // ---------------------------------------------------------------- steps and bar
  let step = 1;
  function go(n, opts) {
    opts = opts || {};
    const d = draft();
    if (n === 2 && !d.key) { toast('Choose an artwork first'); n = 1; }
    if (n === 3 && !sentView) { const probs = problems(); if (probs.length) { markProblems(probs); toast(probs[0]); n = d.key ? 2 : 1; } }
    step = n; d.step = n; persist();
    [1, 2, 3].forEach(i => { $('#step-' + i).hidden = i !== n; });
    Array.from($('#steps').children).forEach(li => { const i = +li.dataset.step; li.className = i < n ? 'done' : i === n ? 'now' : ''; });
    if (n === 1) renderGrid(); if (n === 2) renderRequest(); if (n === 3) renderReview();
    renderBar();
    if (!opts.silent) { const hd = $('#h-step-' + n); if (hd) { hd.focus({ preventScroll: true }); window.scrollTo({ top: Math.max(0, hd.getBoundingClientRect().top + window.scrollY - 70) }); } }
  }
  function markProblems(probs) {
    const t = typeById(draft().type);
    if (t && t.note && !(draft().note || '').trim()) { $('#note').setAttribute('aria-invalid', 'true'); $('#notehint').textContent = 'Write a note for this request.'; $('#notehint').classList.add('err'); $('#note').focus(); }
  }
  function renderBar() {
    const d = draft(), back = $('#back'), next = $('#next'), note = $('#barnote');
    back.hidden = step === 1 || !!sentView;
    if (sentView) { next.hidden = true; note.textContent = 'Sent. Start a new request above when you want.'; return; }
    if (step === 1) { next.textContent = d.key ? 'Next →' : 'Choose an artwork'; next.disabled = !d.key; note.textContent = d.key ? ((d.key === OTHER ? 'Something else' : d.artwork_name || d.key) + ' chosen') : DATA.items.length + ' artworks'; }
    else if (step === 2) { const probs = problems(); next.textContent = 'Review →'; next.disabled = false; note.textContent = probs.length ? probs[0] : 'Ready to review'; }
    else { next.hidden = true; note.textContent = 'Press Send when it reads right.'; return; }
    next.hidden = false;
  }
  $('#back').addEventListener('click', () => go(step - 1));
  $('#next').addEventListener('click', () => go(step + 1));
  Array.from($('#steps').children).forEach(li => li.addEventListener('click', () => { if (sentView) return; const i = +li.dataset.step; if (i < step || (i === 2 && draft().key)) go(i); }));
  function renderDraftline(saveOk) {
    const d = S.draft, el = $('#draftline'); el.innerHTML = '';
    if (d && d.stale) { el.appendChild(h('b', { text: 'Draft needs a fresh look · ' })); el.appendChild(document.createTextNode(d.stale)); d.stale = null; persist(); return; }
    if (!d || (!d.key && !d.note)) return;
    el.appendChild(h('b', { text: saveOk === false ? 'Draft not saved · device storage unavailable' : 'Draft saved on this device · ' + hhmm(d.updated_at) }));
    el.appendChild(document.createTextNode(' · not sent'));
    el.appendChild(h('button', { type: 'button', class: 'btn quiet', style: 'min-height:28px;margin-left:10px;padding:0 8px;font-size:10px', text: 'Discard', onclick: () => { if (confirm('Discard this draft?')) { S.draft = null; lastSend = null; persist(); renderAll(1); } } }));
  }
  function renderTitleblock() {
    const tb = $('#titleblock'); if (!tb) return; tb.innerHTML = '';
    const row = (k, v) => tb.appendChild(h('div', {}, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v })));
    tb.appendChild(h('div', { class: 'head' }, h('span', { class: 'mono', text: 'LA' }), h('span', { text: 'Lombardia Automobili · studio' })));
    row('Artworks', DATA.items.length + ' · ' + DATA.items.filter(p => p.recorded_approval === 'owner_review_pending' || p.owner_collection_pending).length + ' waiting for your word');
    row('Draft', S.draft && S.draft.key ? 'saved on this device · ' + hhmm(S.draft.updated_at) : 'none');
    row('Sent', S.sent.length ? S.sent.length + ' from this device · last ' + hhmm(S.sent[0].at) : 'nothing yet');
    row('Built', DATA.built || '');
  }
  function renderAll(n, opts) { renderGrid(); renderSent(); renderDraftline(true); renderTitleblock(); go(n, Object.assign({ silent: true }, opts || {})); }

  // ---------------------------------------------------------------- the viewer
  function openViewer(p) {
    const dlg = $('#view'); $('#vtitle').textContent = p.name; const img = $('#vimg'); img.src = p.preview; img.alt = p.name + ' · complete artwork · ' + (p.preview_pixels || []).join(' × ') + ' px preview';
    const f = $('#vfoot'); f.innerHTML = '';
    if (p.full_source_kind === 'exact_current_png' && p.full_source_sha256 === p.source_sha256) {
      f.appendChild(h('a', { href: p.full_source_url, target: '_blank', rel: 'noopener', text: 'Exact master file · ' + (p.full_source_pixels || []).join(' × ') + ' px · ' + Math.round((p.full_source_bytes || 0) / 1e5) / 10 + ' MB' }));
    } else if (p.full_source_kind === 'notion_print_page') {
      f.appendChild(h('a', { href: p.full_source_url, target: '_blank', rel: 'noopener', text: 'Print file · Notion (private) ↗' }));
    } else f.appendChild(h('span', { text: 'Full-quality file: follows the lot build' }));
    if (p.review_url) f.appendChild(h('a', { href: p.review_url, target: '_blank', rel: 'noopener', text: 'MuAPI review link ↗' }));
    if (p.board_url) f.appendChild(h('a', { href: '../posters/' + encodeURIComponent(p.key) + '.html', text: 'Lot page ↗' }));
    f.appendChild(h('span', { text: 'this view is a ' + (p.preview_pixels || []).join(' × ') + ' px preview' }));
    document.body.classList.add('viewing');
    if (!dlg.open) dlg.showModal();
  }
  $('#vclose').addEventListener('click', () => $('#view').close());
  $('#view').addEventListener('close', () => document.body.classList.remove('viewing'));
  $('#view').addEventListener('click', e => { if (e.target === $('#view')) $('#view').close(); });

  // ---------------------------------------------------------------- go
  const q = new URLSearchParams(location.search), lot = q.get('lot');
  if (IS_TEST) $('#draftline').insertAdjacentElement('beforebegin', h('p', { class: 'hint', style: 'margin-top:10px;color:var(--drop);font-weight:600', text: 'TEST MODE · anything sent from here is marked [TEST] and is never an approval or a task.' }));
  if (lot && itemByKey(lot)) { if (!S.draft || S.draft.key !== lot) { S.draft = newDraft(lot); if (q.get('type') && typeById(q.get('type'))) S.draft.type = q.get('type'); } persist(); renderAll(2); }
  else if (lot) { renderAll(1); toast('That artwork is not in the current Studio'); }
  else renderAll(S.draft && S.draft.key ? Math.min(S.draft.step || 1, 2) : 1);
})();
