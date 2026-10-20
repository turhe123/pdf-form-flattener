// app.js — PDF Form Filler and Flattener. Everything runs on this device; pdf-lib work happens in worker.js.
import { toast, downloadBlob, formatBytes, wireDropzone } from './site.js';

const $ = (id) => document.getElementById(id);
const zone = $('dropzone');
const input = $('file-input');
const panel = $('options');
const formPanel = $('form-panel');
const results = $('results');
const notice = $('notice');
const summary = $('summary');
const fileName = $('file-name');
const flattenBox = $('flatten');
const saveBtn = $('save');
const resetBtn = $('reset');
const progress = $('progress');
const modeFill = $('mode-fill');
const modeFlattenOnly = $('mode-flatten-only');

const KIND_LABEL = { text: 'Text', checkbox: 'Checkbox', radio: 'Radio group', dropdown: 'Dropdown', optionlist: 'Option list', signature: 'Signature', button: 'Button', unknown: 'Unknown' };
const FILLABLE = new Set(['text', 'checkbox', 'radio', 'dropdown', 'optionlist']);

// Characters the standard Helvetica font (WinAnsi encoding) can draw.
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const isDrawable = (ch) => {
  const c = ch.codePointAt(0);
  return ch === '\n' || ch === '\r' || ch === '\t' || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.includes(ch);
};
const unsupportedChars = (text) => [...new Set([...String(text)].filter((ch) => !isDrawable(ch)))];
// Keep drawable characters; otherwise try the letter without its accent (Ą → A), else a visible '?'.
const toDrawable = (text) => [...String(text).normalize('NFC')].map((ch) => {
  if (isDrawable(ch)) return ch;
  const base = ch.normalize('NFKD').replace(/\p{M}/gu, '');
  return base && [...base].every(isDrawable) ? base : '?';
}).join('');

const state = { quiet: false, file: null, bytes: null, info: null, entries: [], busy: false, lastBlob: null, lastName: '' };

// ---------- worker ----------
let worker = null;
let taskId = 0;
const pending = new Map();
function runTask(type, payload, onProgress) {
  if (!worker) {
    worker = new Worker('./worker.js');
    worker.onmessage = (e) => {
      const { id, type: kind } = e.data;
      const task = pending.get(id);
      if (!task) return;
      if (kind === 'progress') return task.onProgress && task.onProgress(e.data.value);
      pending.delete(id);
      if (kind === 'done') task.resolve(e.data.result);
      else task.reject(Object.assign(new Error(e.data.message), { code: e.data.code }));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      pending.forEach((t) => t.reject(new Error('The PDF engine stopped unexpectedly. Reload the page and try again.')));
      pending.clear();
      worker = null;
    };
  }
  const id = ++taskId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    // Send a copy so the original bytes stay usable for the next save.
    const bytes = new Uint8Array(state.bytes.slice(0));
    worker.postMessage({ id, type, bytes, ...payload }, [bytes.buffer]);
  });
}

// ---------- helpers ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.filter(Boolean));
  return node;
}

function showError(message) {
  results.replaceChildren(el('div', { class: 'alert alert--error', role: 'alert', text: message }));
  results.firstElementChild.scrollIntoView({ block: 'nearest' });
}

function setProgress(value) {
  if (value == null) { progress.hidden = true; return; }
  progress.hidden = false;
  const pct = Math.floor(Math.max(0, Math.min(1, value)) * 1000) / 10; // never round 99.9 up to 100
  progress.firstElementChild.style.width = `${pct}%`;
  progress.setAttribute('aria-valuenow', String(Math.floor(pct)));
}

const outputName = () => `${(state.file?.name || 'form').replace(/\.pdf$/i, '')}_filled.pdf`;
const isFilled = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'boolean' ? v : String(v ?? '').trim() !== '');
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- loading ----------
async function handleFiles(files) {
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  const rejected = files.filter((f) => !pdfs.includes(f));
  results.replaceChildren();
  if (!pdfs.length) {
    showError(`${rejected.map((f) => f.name).join(', ')} ${rejected.length === 1 ? 'is' : 'are'} not a PDF. This tool takes one PDF form.`);
    return;
  }
  const file = pdfs[0];
  const skipped = [...rejected.map((f) => `${f.name} (not a PDF)`), ...pdfs.slice(1).map((f) => `${f.name} (one form at a time)`)];
  await loadFile(file);
  if (skipped.length) {
    results.prepend(el('div', { class: 'alert alert--error', role: 'alert', text: `Skipped: ${skipped.join(', ')}. Opened ${file.name}.` }));
  }
}

async function loadFile(file) {
  if (state.busy) return;
  state.busy = true;
  try {
    const buf = await file.arrayBuffer();
    const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength)));
    if (!head.includes('%PDF')) {
      showError(`${file.name} does not look like a PDF file. Choose a PDF form.`);
      return;
    }
    state.file = file;
    state.bytes = buf;
    const info = await runTask('inspect', {});
    state.info = info;
    renderForm(info);
    zone.classList.add('dropzone--compact');
    if (!state.quiet) toast(`${file.name} opened on this device — nothing was uploaded`);
  } catch (err) {
    resetPanel();
    showError(err.code === 'encrypted' ? err.message : `Could not open ${file.name}: ${err.message}`);
  } finally {
    state.busy = false;
  }
}

function resetPanel() {
  panel.hidden = true;
  formPanel.replaceChildren();
  state.entries = [];
  state.info = null;
  state.file = null;
  state.bytes = null;
  zone.classList.remove('dropzone--compact');
}

// ---------- form rendering ----------
function typeBadge(info) {
  const extra = info.kind === 'text' && info.multiline ? ' (multi-line)' : info.kind === 'optionlist' && info.multiple ? ' (multi-select)' : '';
  return el('span', { class: 'ff__type', text: `${KIND_LABEL[info.kind] || info.kind}${extra}` });
}

function charWarning(entry) {
  const box = el('div', { class: 'ff__warn', hidden: true });
  const update = () => {
    const bad = unsupportedChars(entry.get());
    box.hidden = bad.length === 0;
    if (!bad.length) return box.replaceChildren();
    const fix = el('button', { class: 'btn btn--small', type: 'button', text: 'Replace them' });
    fix.addEventListener('click', () => { entry.set(toDrawable(entry.get())); update(); updateSummary(); entry.focus(); });
    box.replaceChildren(el('span', { text: `Not in the standard PDF font: ${bad.join(' ')} ` }), fix);
  };
  entry.checkChars = update;
  return box;
}

function buildEntry(info) {
  const id = `ff-${info.index}`;
  const disabled = info.readOnly;
  const wrap = el('div', { class: `field ff ff--${info.kind}`, 'data-field-name': info.name, 'data-kind': info.kind });
  const ro = info.readOnly ? el('span', { class: 'ff__type ff__type--ro', text: 'Read only' }) : null;
  const entry = { info, wrap, initial: info.value };

  if (info.kind === 'text') {
    const control = info.multiline
      ? el('textarea', { id, rows: 3, disabled })
      : el('input', { id, type: 'text', disabled, autocomplete: 'off' });
    if (info.maxLength) control.maxLength = info.maxLength;
    control.value = info.value || '';
    if (!info.multiline) control.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    Object.assign(entry, { get: () => control.value, set: (v) => { control.value = v || ''; }, focus: () => control.focus() });
    wrap.append(el('label', { for: id, class: 'ff__label' }, el('span', { class: 'ff__name', text: info.name }), typeBadge(info), ro), control, charWarning(entry));
    control.addEventListener('input', () => { entry.checkChars(); updateSummary(); });
  } else if (info.kind === 'checkbox') {
    const control = el('input', { id, type: 'checkbox', disabled });
    control.checked = Boolean(info.value);
    Object.assign(entry, { get: () => control.checked, set: (v) => { control.checked = Boolean(v); }, focus: () => control.focus() });
    wrap.append(el('label', { class: 'check ff__label', for: id }, control, el('span', { class: 'ff__name', text: info.name }), typeBadge(info), ro));
    control.addEventListener('change', updateSummary);
  } else if (info.kind === 'radio') {
    const group = el('fieldset', { class: 'ff__group', disabled });
    const radios = info.options.map((opt, k) => {
      const r = el('input', { type: 'radio', name: id, id: `${id}-${k}`, value: opt });
      r.checked = opt === info.value;
      r.addEventListener('change', updateSummary);
      group.append(el('label', { class: 'check', for: `${id}-${k}` }, r, el('span', { text: opt })));
      return r;
    });
    group.prepend(el('legend', { class: 'ff__label' }, el('span', { class: 'ff__name', text: info.name }), typeBadge(info), ro));
    Object.assign(entry, {
      get: () => radios.find((r) => r.checked)?.value || '',
      set: (v) => radios.forEach((r) => { r.checked = r.value === v; }),
      focus: () => (radios.find((r) => r.checked) || radios[0])?.focus(),
    });
    wrap.append(group);
  } else if (info.kind === 'dropdown' || info.kind === 'optionlist') {
    const multiple = info.kind === 'optionlist' && info.multiple;
    const control = el('select', { id, disabled, multiple });
    if (info.kind === 'optionlist') control.size = Math.min(6, Math.max(2, info.options.length));
    if (!multiple) control.append(el('option', { value: '', text: '(none)' }));
    info.options.forEach((opt) => control.append(el('option', { value: opt, text: opt })));
    const set = (v) => {
      const list = Array.isArray(v) ? v : [v];
      [...control.options].forEach((o) => { o.selected = list.includes(o.value) && (o.value !== '' || !multiple); });
    };
    set(info.value);
    const get = () => (info.kind === 'optionlist' ? [...control.selectedOptions].map((o) => o.value).filter(Boolean) : control.value);
    Object.assign(entry, { get, set, focus: () => control.focus() });
    wrap.append(el('label', { for: id, class: 'ff__label' }, el('span', { class: 'ff__name', text: info.name }), typeBadge(info), ro), control);
    control.addEventListener('change', updateSummary);
  } else {
    wrap.classList.add('ff--skip');
    wrap.append(
      el('div', { class: 'ff__label' }, el('span', { class: 'ff__name', text: info.name }), typeBadge(info)),
      el('p', { class: 'field__hint', text: info.kind === 'signature' ? 'Signature fields are skipped. This tool does not sign.' : 'Not a fillable field; left as is.' }),
    );
  }
  if (info.warning) wrap.append(el('p', { class: 'field__hint', text: info.warning }));
  return entry;
}

function renderForm(info) {
  fileName.textContent = `${state.file.name} · ${formatBytes(state.file.size)}`;
  const entries = info.fields.map(buildEntry);
  state.entries = entries;
  const byPage = new Map();
  entries.forEach((e) => {
    if (!byPage.has(e.info.page)) byPage.set(e.info.page, []);
    byPage.get(e.info.page).push(e);
  });
  formPanel.replaceChildren(...[...byPage.entries()].map(([page, list]) => el('fieldset', { class: 'fill__page' },
    el('legend', { text: `Page ${page + 1}` }),
    ...list.map((e) => e.wrap),
  )));
  entries.forEach((e) => e.checkChars && e.checkChars());

  const fillable = entries.filter((e) => FILLABLE.has(e.info.kind));
  const messages = [];
  if (info.xfa) messages.push('This PDF contains an XFA form, which is not supported. Only its standard form fields are shown below; when you save, the XFA part is removed.');
  if (!info.fields.length) messages.push('This PDF has no fillable form fields, so there is nothing to fill or flatten. This tool works with interactive (AcroForm) PDF forms; it does not add free text to plain pages.');
  notice.hidden = messages.length === 0;
  notice.className = `fill__notice alert${info.fields.length ? '' : ' alert--warn'}`;
  notice.replaceChildren(...messages.map((m) => el('p', { text: m })));

  const none = fillable.length === 0 && info.fields.length === 0;
  modeFlattenOnly.disabled = none;
  modeFill.disabled = none;
  saveBtn.disabled = none;
  resetBtn.disabled = false;
  modeFill.checked = true;
  flattenBox.checked = true;
  applyMode();
  panel.hidden = false;
  updateSummary();
}

function updateSummary() {
  if (!state.info) return;
  const fillable = state.entries.filter((e) => FILLABLE.has(e.info.kind));
  const filled = fillable.filter((e) => isFilled(e.get())).length;
  const pages = state.info.pages;
  const skipped = state.entries.length - fillable.length;
  summary.textContent = `${fillable.length} field${fillable.length === 1 ? '' : 's'} · ${filled} filled · ${pages} page${pages === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped` : ''}`;
  saveBtn.textContent = `Save ${outputName()}`;
  saveBtn.setAttribute('aria-label', `Save PDF as ${outputName()}`);
}

function applyMode() {
  const flattenOnly = modeFlattenOnly.checked;
  formPanel.classList.toggle('is-locked', flattenOnly);
  formPanel.querySelectorAll('.fill__page').forEach((fs) => { fs.disabled = flattenOnly; });
  flattenBox.disabled = flattenOnly;
  if (flattenOnly) flattenBox.checked = true;
}
modeFill.addEventListener('change', applyMode);
modeFlattenOnly.addEventListener('change', applyMode);

// ---------- saving ----------
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

async function save({ autoDownload = true } = {}) {
  if (!state.bytes || state.busy) return;
  const flattenOnly = modeFlattenOnly.checked;
  const editable = state.entries.filter((e) => FILLABLE.has(e.info.kind) && !e.info.readOnly);
  if (!flattenOnly) {
    const bad = editable.filter((e) => e.info.kind === 'text' && unsupportedChars(e.get()).length);
    if (bad.length) {
      showError(`Some characters cannot be drawn with the standard PDF font in: ${bad.map((e) => e.info.name).join(', ')}. Use "Replace them" under each field, or edit the text, then save again.`);
      bad[0].focus();
      return;
    }
  }
  const values = flattenOnly ? [] : editable.filter((e) => !sameValue(e.get(), e.initial)).map((e) => ({ name: e.info.name, value: e.get() }));
  const flatten = flattenOnly || flattenBox.checked;
  state.busy = true;
  saveBtn.disabled = true;
  results.replaceChildren();
  setProgress(0.02);
  try {
    const out = await runTask('save', { values, flatten, flattenOnly }, setProgress);
    const blob = new Blob([out.bytes], { type: 'application/pdf' });
    state.lastBlob = blob;
    state.lastName = outputName();
    renderResult(out, blob, { flatten, flattenOnly, changed: values.length });
    if (autoDownload && !isIOS()) downloadBlob(blob, state.lastName);
  } catch (err) {
    showError(err.code === 'encrypted' ? err.message : `Saving failed: ${err.message}`);
  } finally {
    state.busy = false;
    saveBtn.disabled = false;
    setProgress(null);
  }
}

function renderResult(out, blob, { flatten, flattenOnly, changed }) {
  const detail = flatten
    ? `${formatBytes(blob.size)} · flattened, ${out.fieldsLeft} form field${out.fieldsLeft === 1 ? '' : 's'} left`
    : `${formatBytes(blob.size)} · ${changed} field${changed === 1 ? '' : 's'} changed, still editable`;
  const dl = el('button', { class: 'btn btn--primary', type: 'button', id: 'download', text: `Download ${state.lastName}` });
  dl.addEventListener('click', () => downloadBlob(state.lastBlob, state.lastName));
  const card = el('div', { class: 'result' },
    el('span', { class: 'result__badge', 'aria-hidden': 'true', text: 'PDF' }),
    el('div', { class: 'result__meta' },
      el('div', { class: 'result__name', text: state.lastName }),
      el('div', { class: 'result__info', id: 'result-info', text: `${detail}${flattenOnly ? ' · flatten only' : ''}` })),
    dl);
  const nodes = [card];
  if (out.warnings.length) {
    nodes.push(el('div', { class: 'alert alert--warn fill__warnings', id: 'warnings' },
      el('strong', { text: `${out.warnings.length} note${out.warnings.length === 1 ? '' : 's'} from saving:` }),
      el('ul', {}, ...out.warnings.map((w) => el('li', { text: w.field ? `${w.field}: ${w.message}` : w.message })))));
  }
  results.replaceChildren(...nodes);
  card.scrollIntoView({ block: 'nearest' });
  if (!state.quiet) toast(isIOS() ? 'Ready — tap Download to save the PDF' : `Saved ${state.lastName}`);
}

saveBtn.addEventListener('click', () => save());
resetBtn.addEventListener('click', () => {
  state.entries.forEach((e) => { if (e.set) { e.set(e.initial); e.checkChars && e.checkChars(); } });
  modeFill.checked = true;
  flattenBox.checked = true;
  applyMode();
  results.replaceChildren();
  updateSummary();
  toast('Fields reset to the values in the original PDF');
});

wireDropzone(zone, input, handleFiles);

// Called by the factory's screenshot script: opens the fictional tenant form, fills it and saves (no download).
window.__demo = async () => {
  const res = await fetch('./tests/fixtures/tenant-application.pdf');
  const blob = await res.blob();
  state.quiet = true; // no toasts over the screenshot
  await loadFile(new File([blob], 'tenant-application.pdf', { type: 'application/pdf' }));
  const values = {
    'Full name': 'Jordan Example',
    'Current address': '12 Sample Street\nExampletown, EX 00000',
    Date: '2026-11-01',
    Pets: true,
    'Unit type': 'One bedroom',
    'Move-in month': 'November',
  };
  state.entries.forEach((e) => { if (e.info.name in values) e.set(values[e.info.name]); });
  updateSummary();
  await save({ autoDownload: false });
  state.quiet = false;
};

export { handleFiles };
