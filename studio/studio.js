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
  // The sixth collection choice: New / Other. An owner proposal (a name and a "1 of N"), carried in the request as
  // proposed_collection; it changes no existing edition and migrates nothing by itself (EDITION-POLICY.md).
  const NEW = DATA.new_option || '__new__';
  const NEW_DEFAULT_EDITION = +DATA.new_collection_default_edition || 77;
  const isNew = c => c === NEW;
  const validEdition = n => Number.isInteger(n) && n > 0;
  const parseEdition = v => { const s = String(v == null ? '' : v).trim(); return /^\d+$/.test(s) ? parseInt(s, 10) : NaN; };
  const recOf = p => (p && p.recommendation) || {};
  const fixedEdition = p => (p && p.edition && p.edition.fixed && p.edition.limit) ? p.edition : null;
  const edText = fe => /^edition/i.test(fe.label || '') ? fe.label : 'Edition ' + fe.label;   // "1of100" -> "Edition 1of100"; "Edition of 77" stays
  // the edition the New / Other field starts from: the artwork's fixed edition when it has one, else 77
  const suggestedEdition = p => { const n = recOf(p).new; return (n && validEdition(+n.edition)) ? +n.edition : NEW_DEFAULT_EDITION; };   // the proposed collection's size for new artworks, never this artwork's own edition
  const suggestedName = p => ((recOf(p).new || {}).name || '');
  // the full-quality file: exact bytes (the review PNG under studio/full, or the print master under ../artwork) or the Notion page
  function fullLink(p) {
    if (!p) return null;
    if (/^exact_current_/.test(p.full_source_kind || '') && p.full_source_sha256 === p.source_sha256 && p.full_source_url) {
      const px = (p.full_source_pixels || []).join(' × '), mb = Math.round((p.full_source_bytes || 0) / 1e5) / 10;
      return { href: p.full_source_url, exact: true, kind: p.full_source_kind, text: 'Open full poster · exact master' + (px ? ' · ' + px + ' px' : '') + (mb ? ' · ' + mb + ' MB' : ''), short: 'Full poster ↗' };
    }
    if (p.full_source_kind === 'notion_print_page' && p.full_source_url) return { href: p.full_source_url, exact: false, kind: 'notion', text: 'Print file · Notion (private) ↗', short: 'Print file · Notion ↗' };
    return null;
  }
  function absolute(href) { try { return new URL(href, location.href).href; } catch (e) { return href; } }

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
      type: key === OTHER ? 'other' : null, collection: null, new_name: null, new_edition: null, note: '', created_at: nowISO(), updated_at: nowISO(), step: 1 };
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
    if (d.collection && !validCollection(d.collection) && !isNew(d.collection)) d.collection = null;
    if (d.stale) { d.key = null; d.artwork_sha256 = null; d.step = 1; }
    persist();
  }
  reconcile();

  // ---------------------------------------------------------------- state of an artwork: one status, one colour
  // `status` is derived by mk-studio.py from the ledger and the receipts (approval, master, package, delivery); the
  // page shows that and one detail line, never the older fragments (delivery_status, saved choice) that used to pile up.
  const FALLBACK_STATUS = { code: 'pending', label: 'Waiting for your word', tone: 'wait', detail: '' };
  const statusOf = p => (p && p.status && p.status.code) ? p.status : FALLBACK_STATUS;
  const WAITING = { review: 1, collection: 1, pending: 1 };
  function statusPill(p, small) {
    const s = statusOf(p);
    return h('span', { class: 'pill ' + s.tone + (small ? ' sm' : ''), 'data-status': s.code, title: s.meaning || '' }, h('i', { class: 'dot', 'aria-hidden': 'true' }), s.label);
  }
  const dShort = iso => { const t = Date.parse(iso || ''); return isNaN(t) ? '' : new Date(t).toLocaleDateString([], { day: '2-digit', month: 'short' }); };
  function detailLine(p) {
    const s = statusOf(p), t = p.timeline || {}, bits = [];
    if (s.detail) bits.push(s.detail);
    else if (p.photo_count) bits.push(p.photo_count + ' lot photos');
    if (t.updated_at) bits.push(dShort(t.updated_at) + (t.updated_source ? ' · ' + t.updated_source : ''));
    return bits.join(' · ');
  }
  function stateLine(p) { if (!p) return ''; const s = statusOf(p), d = detailLine(p); return s.label + (d ? ' · ' + d : ''); }
  function collectionOf(p) { return p ? (p.saved_collection || p.collection_choice || '') : ''; }
  function categoryOf(p) { return p ? (p.collection_category || collectionOf(p) || p.existing_collection || '') : ''; }
  function isLandscape(p) { return p && p.preview_pixels && p.preview_pixels[0] > p.preview_pixels[1]; }
  // the honest MuAPI trail: one link per paid call. A generation page only when the build knows a real route
  // (page_url); otherwise the real History page plus the full request id. The CDN file is labelled as the result image.
  function genLinks(p, compact) {
    const out = [];
    (p && p.generations || []).forEach((g, i) => {
      const id = g.request_id || '', role = g.role || 'call';
      const label = compact ? ('MuAPI ' + role + ' ' + id.slice(0, 8)) : ('MuAPI ' + role + ' · ' + (g.page_url ? 'generation page' : 'history') + ' · ' + id.slice(0, 8) + ' ↗');
      out.push(h('a', { class: 'change gen', href: g.page_url || g.history_url || DATA.muapi_history_url, target: '_blank', rel: 'noopener', text: label,
        title: (g.page_url ? 'MuAPI generation page' : 'MuAPI history (find request ' + id + ')') + (g.model ? ' · ' + g.model : '') + (g.created_at ? ' · ' + g.created_at : '') }));
    });
    if (!out.length && p && p.review_url) out.push(h('a', { class: 'change gen', href: p.review_url, target: '_blank', rel: 'noopener', text: compact ? 'Result image' : 'MuAPI result image (file) ↗', title: 'the generated file on MuAPI’s CDN, not a generation page' }));
    return out;
  }

  // ---------------------------------------------------------------- 01 · the grid: sort, legend, cards
  const SORTS = [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['collection', 'By collection']];
  const SORT_KEY = 'lomb.studio.sort';
  function sortMode() { try { const v = localStorage.getItem(SORT_KEY); if (SORTS.some(s => s[0] === v)) return v; } catch (e) { } return DATA.sort_default || 'newest'; }
  function setSort(v) { try { localStorage.setItem(SORT_KEY, v); } catch (e) { } renderGrid(); }
  const tsOf = (p, which) => { const t = p.timeline || {}; const v = Date.parse((which === 'created' ? (t.created_at || t.updated_at) : (t.updated_at || t.created_at)) || ''); return isNaN(v) ? 0 : v; };
  function renderSortbar() {
    const sb = $('#sortbar'); if (!sb) return; sb.innerHTML = '';
    const mode = sortMode();
    SORTS.forEach(([v, label]) => sb.appendChild(h('button', { type: 'button', class: 'sortbtn' + (mode === v ? ' on' : ''), 'aria-pressed': String(mode === v), text: label, onclick: () => setSort(v) })));
    const lg = $('#legendlist'); if (!lg) return; lg.innerHTML = '';
    (DATA.statuses || []).forEach(s => lg.appendChild(h('li', {}, h('span', { class: 'pill ' + s.tone + ' sm' }, h('i', { class: 'dot', 'aria-hidden': 'true' }), s.label), h('span', { class: 'lgmean', text: s.meaning || '' }))));
  }
  function renderGrid() {
    const g = $('#grid'); g.innerHTML = '';
    renderSortbar();
    const term = ($('#search').value || '').trim().toLowerCase();
    const d = draft(), mode = sortMode();
    let list = DATA.items.filter(p => !term || (p.name + ' ' + (p.existing_collection || '') + ' ' + (p.saved_collection || '') + ' ' + categoryOf(p) + ' ' + statusOf(p).label + ' ' + p.key).toLowerCase().indexOf(term) >= 0);
    // newest / oldest by when the artwork came into being (timeline.created_at, real provenance); ties by latest activity, then name
    if (mode === 'oldest') list = list.slice().sort((a, b) => tsOf(a, 'created') - tsOf(b, 'created') || tsOf(a, 'updated') - tsOf(b, 'updated') || a.name.localeCompare(b.name));
    else list = list.slice().sort((a, b) => tsOf(b, 'created') - tsOf(a, 'created') || tsOf(b, 'updated') - tsOf(a, 'updated') || a.name.localeCompare(b.name));
    const groups = [];
    if (mode === 'collection') {
      const order = ['No collection yet'].concat(DATA.collections || []);
      const by = {};
      list.forEach(p => { const c = categoryOf(p) || 'No collection yet'; (by[c] = by[c] || []).push(p); });
      Object.keys(by).sort((a, b) => { const ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b); }).forEach(c => groups.push([c, by[c]]));
    } else groups.push([null, list]);
    groups.forEach(([name, ps]) => {
      if (name) g.appendChild(h('h3', { class: 'ggroup', text: name + ' · ' + ps.length }));
      ps.forEach(p => g.appendChild(cardOf(p, d)));
    });
    if (!list.length) g.insertBefore(h('p', { class: 'empty', text: 'Nothing matches that. Clear the search.' }), g.firstChild);
    appendOtherCard(g, d);
  }
  function cardOf(p, d) {
      const on = d.key === p.key;
      return h('article', { class: 'card' + (on ? ' on' : '') + (isLandscape(p) ? ' land' : ''), role: 'listitem', 'data-key': p.key, 'data-status': statusOf(p).code },
        h('a', { class: 'cimg', href: p.preview, onclick: e => { e.preventDefault(); openViewer(p); } }, h('img', { src: p.preview, alt: p.name + ' · artwork', loading: 'lazy', decoding: 'async' })),
        h('div', { class: 'cbody' },
          h('span', { class: 'ccoll' + (!categoryOf(p) && recOf(p).kind ? ' rec' : '') }, categoryOf(p) || (recOf(p).kind ? ['no collection · ', h('em', { text: 'recommended ' + (recOf(p).collection || 'new: ' + (suggestedName(p) || 'a new collection')) })] : 'no collection yet')),
          h('span', { class: 'cname', text: p.name }),
          statusPill(p, true),
          h('span', { class: 'cstate', text: detailLine(p) }),
          h('div', { class: 'cacts' },
            h('button', { type: 'button', text: 'View', 'aria-label': 'View ' + p.name, onclick: () => openViewer(p) }),
            h('button', { type: 'button', class: 'pick', text: on ? 'Chosen' : 'Choose', 'aria-pressed': String(on), 'aria-label': (on ? 'Chosen: ' : 'Choose ') + p.name, onclick: () => pick(p.key) }))));
  }
  function appendOtherCard(g, d) {
    const onOther = d.key === OTHER;
    g.appendChild(h('article', { class: 'card other' + (onOther ? ' on' : ''), role: 'listitem' },
      h('span', { class: 'cimg', 'aria-hidden': 'true', text: '+' }),
      h('div', { class: 'cbody' }, h('span', { class: 'ccoll', text: 'no artwork' }), h('span', { class: 'cname', text: 'Something else' }),
        h('span', { class: 'cstate', text: 'a new poster idea, a question, a note' }),
        h('div', { class: 'cacts' }, h('button', { type: 'button', class: 'pick', text: onOther ? 'Chosen' : 'Choose', 'aria-pressed': String(onOther), onclick: () => pick(OTHER) })))));
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
      const fl = fullLink(p), fe = fixedEdition(p);
      pk.appendChild(h('a', { class: 'pkimg', href: p.preview, 'aria-label': 'View ' + p.name, onclick: e => { e.preventDefault(); openViewer(p); } }, h('img', { src: p.preview, alt: '' })));
      pk.appendChild(h('div', { class: 'pk' }, h('b', { text: p.name }),
        h('span', { class: 'pkstatus' }, statusPill(p), categoryOf(p) ? h('span', { class: 'pkcoll', text: categoryOf(p) }) : null),
        h('span', { text: detailLine(p) || ((p.photo_count ? p.photo_count + ' lot photos' : 'no lot photos yet')) }),
        h('span', { text: 'chosen ' + hhmm(d.created_at) }),
        fe ? h('span', { class: 'edn', text: edText(fe) + ' · this artwork’s own edition, stays as promised' }) : null,
        h('div', { class: 'pklinks' },
          h('button', { type: 'button', class: 'change', text: 'View', onclick: () => openViewer(p) }),
          fl ? h('a', { class: 'change' + (fl.exact ? ' exact' : ''), href: fl.href, target: '_blank', rel: 'noopener', text: fl.short, title: fl.text }) : h('span', { class: 'change na', text: 'full file follows the build' }),
          genLinks(p, true),
          h('button', { type: 'button', class: 'change', text: 'Change artwork', onclick: () => go(1) }))));
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
      const saved = collectionOf(p), rec = recOf(p), fe = fixedEdition(p), eds = DATA.collection_editions || {};
      if (saved && !d.collection && validCollection(saved)) d.collection = saved;
      const hint = [];
      hint.push(p && p.saved_collection ? 'Your saved choice is ' + p.saved_collection + '. Change it here if you want.' : (saved ? 'The existing label is ' + saved + '.' : 'Choose one of the five, or propose a new one. Nothing is assigned on its own.'));
      if (rec.kind === 'existing') hint.push('Recommended: ' + rec.collection + (rec.why ? ' · ' + rec.why : '') + '.');
      else if (rec.kind === 'new') hint.push('Recommended: a new collection' + (suggestedName(p) ? ', ' + suggestedName(p) : '') + (rec.why ? ' · ' + rec.why : '') + '.');
      // the artwork's own edition is said once, here; the numbers under the options are each collection's size for NEW artworks
      if (fe) hint.push('This artwork keeps its own edition, ' + fe.label + ', whatever you choose; the numbers below are what new artworks in each collection get.');
      else hint.push('The number under each collection is the edition a new artwork there gets.');
      $('#collhint').textContent = hint.join(' ');
      const co = $('#collopts'); co.innerHTML = '';
      const tag = txt => h('em', { class: 'rec', text: txt });
      DATA.collections.forEach(c => {
        const on = d.collection === c, id = 'coll-' + c.replace(/\W+/g, '-'), isRec = rec.kind === 'existing' && rec.collection === c;
        co.appendChild(h('label', { class: 'opt' + (on ? ' on' : '') + (isRec ? ' isrec' : ''), for: id },
          h('input', { type: 'radio', name: 'collection', value: c, id: id, checked: on || null, onchange: () => { d.collection = c; touch(); renderRequest(); } }),
          h('span', {}, h('b', {}, c, isRec ? tag('recommended') : null),
            h('span', { text: eds[c] ? 'new artworks here: edition of ' + eds[c] : '' }))));
      });
      // New / Other: an owner proposal. Name and edition size editable; the number is the size for new artworks in the
      // proposed collection (77 by default), never this artwork's own edition.
      const onNew = isNew(d.collection), isRecNew = rec.kind === 'new';
      if (onNew) {
        if (d.new_name == null) d.new_name = suggestedName(p);
        if (d.new_edition == null) d.new_edition = String(suggestedEdition(p));
      }
      const nameIn = h('input', { type: 'text', id: 'newname', maxlength: 80, autocomplete: 'off', autocapitalize: 'words', placeholder: 'Name the collection', value: d.new_name || '',
        oninput: e => { d.new_name = e.target.value; touch(); renderBar(); } });
      const edIn = h('input', { type: 'text', id: 'newedition', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 6, autocomplete: 'off', value: d.new_edition || '', 'aria-describedby': 'newedhint',
        oninput: e => { d.new_edition = e.target.value; touch(); renderBar(); const ok = validEdition(parseEdition(e.target.value)); e.target.setAttribute('aria-invalid', ok ? 'false' : 'true'); } });
      const newBody = h('div', { class: 'newcoll', hidden: onNew ? null : true },
        h('label', { class: 'nf' }, h('span', { text: 'Collection name' }), nameIn),
        h('label', { class: 'nf' }, h('span', { text: 'Edition of' }), edIn),
        h('p', { class: 'hint', id: 'newedhint', text: (rec.new && rec.new.edition_reason ? rec.new.edition_reason : NEW_DEFAULT_EDITION + ' is the usual start for a new collection; it is the edition size for new artworks in it' + (fe ? '; this artwork’s own edition (' + fe.label + ') stays as promised' : '')) + '. Your proposal, read by the agent; it creates nothing on its own.' }));
      co.appendChild(h('label', { class: 'opt other' + (onNew ? ' on' : '') + (isRecNew ? ' isrec' : ''), for: 'coll-new' },
        h('input', { type: 'radio', name: 'collection', value: NEW, id: 'coll-new', checked: onNew || null, onchange: () => { d.collection = NEW; touch(); renderRequest(); setTimeout(() => { const n = $('#newname'); if (n && !n.value) n.focus(); }, 0); } }),
        h('span', {}, h('b', {}, 'New / Other', isRecNew ? tag('recommended') : null),
          h('span', { text: 'Propose a collection that is not one of the five' + (suggestedName(p) ? ' · suggested: ' + suggestedName(p) : '') + ' · new artworks there: edition of ' + suggestedEdition(p) }))));
      co.appendChild(newBody);
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
    if (t && t.collection && !validCollection(d.collection) && !isNew(d.collection)) out.push('Choose a collection.');
    if (t && t.collection && isNew(d.collection)) {
      if (!(d.new_name || '').trim()) out.push('Name the new collection.');
      if (!validEdition(parseEdition(d.new_edition))) out.push('The edition must be a whole number above 0.');
    }
    if (t && t.note && !(d.note || '').trim()) out.push('Write a note.');
    if (p && !p.source_sha256) out.push('This artwork has no bound master; the agent cannot act on it.');
    return out;
  }

  // ---------------------------------------------------------------- 03 · review and send
  function deviceName() { const u = navigator.userAgent; return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'PC' : 'device'; }
  function requestObject(d, sentAt) {
    const p = d.key && d.key !== OTHER ? itemByKey(d.key) : null, t = typeById(d.type);
    const approve = !!(t && t.collection), newColl = approve && isNew(d.collection), rec = recOf(p), fe = fixedEdition(p), fl = fullLink(p);
    const proposed = newColl ? { name: (d.new_name || '').trim(), edition: parseEdition(d.new_edition), edition_basis: 'proposed edition size for new artworks in this collection (default ' + NEW_DEFAULT_EDITION + ')' + (fe ? '; this artwork keeps its own edition ' + fe.label : ''), status: 'owner proposal; not a migration, not an allocation' } : null;
    const chosen = approve ? (newColl ? (proposed.name || null) : (d.collection || null)) : null;
    return {
      kind: 'lombardia_studio_request', schema_version: 3, request_id: d.id, created_at: d.created_at, sent_at: sentAt || null, is_test: IS_TEST,
      request_type: d.type, request_label: t ? t.label : '',
      lot_key: p ? p.key : null, artwork_name: p ? p.name : null, artwork_sha256: d.artwork_sha256 || null, source_file: p ? p.source_file : null,
      recorded_stage: p ? p.recorded_stage : null, recorded_approval: p ? p.recorded_approval : null,
      collection: chosen, collection_kind: approve ? (newColl ? 'new' : (chosen ? 'existing' : null)) : null,
      proposed_collection: proposed, previous_collection: p ? (p.saved_collection || p.existing_collection || null) : null,
      recommended_collection: approve ? (rec.kind === 'existing' ? rec.collection : rec.kind === 'new' ? 'new: ' + (suggestedName(p) || 'unnamed') : null) : null,
      recommendation_followed: approve ? (rec.kind === 'existing' ? chosen === rec.collection : rec.kind === 'new' ? newColl : null) : null,
      edition_fixed: fe ? { label: fe.label, limit: fe.limit, kind: fe.kind } : null,
      full_source_url: fl ? absolute(fl.href) : null, full_source_kind: fl ? fl.kind : null,
      note: d.note || '', notion_url: p ? p.notion_url : null, board_url: p ? p.board_url : null,
      studio_built: DATA.built || '', device: deviceName()
    };
  }
  function collectionText(r) {
    if (r.collection_kind === 'new' && r.proposed_collection) return 'New / Other · ' + r.proposed_collection.name + ' · edition of ' + r.proposed_collection.edition + ' for new artworks (your proposal)';
    return r.collection || 'not chosen - do not assign';
  }
  function summaryText(r) {
    const lines = [(r.is_test ? '[TEST] ' : '') + 'LOMBARDIA STUDIO REQUEST - ' + r.device + ' - ' + new Date().toLocaleString()];
    if (r.is_test) lines.push('THIS IS A TEST SUBMISSION - not an approval, not a task.');
    lines.push('', 'Request: ' + r.request_label + (r.request_type ? ' [' + r.request_type + ']' : ''));
    if (r.lot_key) { lines.push('Artwork: ' + r.artwork_name, 'Lot: ' + r.lot_key, 'Master SHA256: ' + r.artwork_sha256); }
    else lines.push('Artwork: none (general request)');
    if (r.request_type === 'approve') {
      lines.push('Collection: ' + collectionText(r));
      if (r.recommended_collection) lines.push('Recommended was: ' + r.recommended_collection + (r.recommendation_followed ? ' (followed)' : ' (owner chose otherwise)'));
      if (r.edition_fixed) lines.push('Edition: ' + r.edition_fixed.label + ' - fixed, unchanged by this request');
    }
    if (r.full_source_url) lines.push('Full poster: ' + r.full_source_url);
    lines.push('Notes: ' + (r.note || 'none'));
    lines.push('', 'Request id: ' + r.request_id, 'Apply only to this exact master hash. Sent from the Studio; not read automatically.');
    return lines.join('\n');
  }
  let sending = false, sentView = null;   // sentView: the record just sent, shown in place of the draft
  // the full-quality file, in the review table: a real link (exact bytes when we have them), plus View for the preview
  function fullRow(p) {
    if (!p) return;
    const rv = $('#review'), fl = fullLink(p);
    rv.appendChild(h('div', {}, h('span', { class: 'k', text: 'Status' }), h('span', { class: 'v links' }, statusPill(p), h('span', { text: detailLine(p) }))));
    rv.appendChild(h('div', {}, h('span', { class: 'k', text: 'Full poster' }), h('span', { class: 'v links' },
      fl ? h('a', { href: fl.href, target: '_blank', rel: 'noopener', text: fl.text }) : h('span', { text: 'full-quality file follows the lot build' }),
      h('button', { type: 'button', class: 'change', text: 'View preview', onclick: () => openViewer(p) }))));
    const gl = genLinks(p, false);
    if (gl.length) rv.appendChild(h('div', {}, h('span', { class: 'k', text: 'MuAPI' }), h('span', { class: 'v links' }, gl)));
  }
  function renderReview() {
    const rv = $('#review'); rv.innerHTML = '';
    if (sentView) { renderSentView(); return; }
    const d = draft(), r = requestObject(d, null), p = r.lot_key ? itemByKey(r.lot_key) : null;
    const row = (k, v) => rv.appendChild(h('div', {}, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v })));
    rv.appendChild(h('div', { class: 'head' }, p ? h('img', { src: p.preview, alt: '' }) : h('span', { 'aria-hidden': 'true', style: 'display:grid;place-items:center;width:72px;aspect-ratio:3/4;border:1px solid var(--rule);background:var(--paper-3);font:700 30px var(--cond);color:var(--ink-3)', text: '+' }),
      h('div', {}, h('b', { text: p ? p.name : 'Something else' }), h('span', { text: r.request_label + (IS_TEST ? ' · TEST' : '') }))));
    if (r.request_type === 'approve') row('Collection', collectionText(r));
    if (r.request_type === 'approve' && r.recommended_collection) row('Recommended', r.recommended_collection + (r.recommendation_followed ? ' · followed' : ' · you chose otherwise'));
    if (r.edition_fixed) row('Edition', r.edition_fixed.label + ' · fixed, unchanged by this request');
    if (p && r.request_type === 'approve' && p.saved_collection && p.saved_collection !== r.collection) row('Changes', 'your saved choice was ' + p.saved_collection);
    fullRow(p);
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
    if (r.request_type === 'approve') row('Collection', collectionText(r));
    if (r.edition_fixed) row('Edition', r.edition_fixed.label + ' · fixed');
    fullRow(p);
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
    if (n === 3 && !sentView) { const probs = problems(); if (probs.length) { markProblems(probs); toast(probs[0]); n = d.key ? 2 : 1; if (n === step) opts.silent = true; } }   // stay where the problem is; keep the field focus markProblems set
    step = n; d.step = n; persist();
    [1, 2, 3].forEach(i => { $('#step-' + i).hidden = i !== n; });
    Array.from($('#steps').children).forEach(li => { const i = +li.dataset.step; li.className = i < n ? 'done' : i === n ? 'now' : ''; });
    if (n === 1) renderGrid(); if (n === 2) renderRequest(); if (n === 3) renderReview();
    renderBar();
    if (!opts.silent) { const hd = $('#h-step-' + n); if (hd) { hd.focus({ preventScroll: true }); window.scrollTo({ top: Math.max(0, hd.getBoundingClientRect().top + window.scrollY - 70) }); } }
  }
  function markProblems(probs) {
    const d = draft(), t = typeById(d.type);
    if (t && t.collection && isNew(d.collection)) {
      const n = $('#newname'), e = $('#newedition');
      if (e) e.setAttribute('aria-invalid', validEdition(parseEdition(d.new_edition)) ? 'false' : 'true');
      if (n && !(d.new_name || '').trim()) { n.setAttribute('aria-invalid', 'true'); n.focus(); return; }
      if (e && !validEdition(parseEdition(d.new_edition))) { e.focus(); return; }
    }
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
    row('Artworks', DATA.items.length + ' · ' + DATA.items.filter(p => WAITING[statusOf(p).code]).length + ' waiting for your word');
    row('Draft', S.draft && S.draft.key ? 'saved on this device · ' + hhmm(S.draft.updated_at) : 'none');
    row('Sent', S.sent.length ? S.sent.length + ' from this device · last ' + hhmm(S.sent[0].at) : 'nothing yet');
    row('Built', DATA.built || '');
  }
  function renderAll(n, opts) { renderGrid(); renderSent(); renderDraftline(true); renderTitleblock(); go(n, Object.assign({ silent: true }, opts || {})); }

  // ---------------------------------------------------------------- the viewer
  function openViewer(p) {
    const dlg = $('#view'); $('#vtitle').textContent = p.name; const img = $('#vimg'); img.src = p.preview; img.alt = p.name + ' · complete artwork · ' + (p.preview_pixels || []).join(' × ') + ' px preview';
    const f = $('#vfoot'); f.innerHTML = '';
    const fl = fullLink(p);
    if (fl && fl.exact) f.appendChild(h('a', { href: fl.href, target: '_blank', rel: 'noopener', text: 'Exact master file · ' + (p.full_source_pixels || []).join(' × ') + ' px · ' + Math.round((p.full_source_bytes || 0) / 1e5) / 10 + ' MB' }));
    else if (fl) f.appendChild(h('a', { href: fl.href, target: '_blank', rel: 'noopener', text: fl.text }));
    else f.appendChild(h('span', { text: 'Full-quality file: follows the lot build' }));
    genLinks(p, true).forEach(a => f.appendChild(a));
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
