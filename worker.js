// worker.js — PDF form work off the main thread (classic worker, pdf-lib from vendor/).
// Messages in:  { id, type: 'inspect', bytes }  |  { id, type: 'save', bytes, values, flatten, flattenOnly }
// Messages out: { id, type: 'progress', value } | { id, type: 'done', result } | { id, type: 'error', code, message }
/* global PDFLib */
importScripts('vendor/pdf-lib/pdf-lib.min.js');

const { PDFDocument, PDFName, PDFRef, StandardFonts, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, PDFSignature, PDFButton } = PDFLib;

function kindOf(field) {
  // The minified build mangles constructor names, so classify with instanceof.
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'optionlist';
  if (field instanceof PDFSignature) return 'signature';
  if (field instanceof PDFButton) return 'button';
  return 'unknown';
}

async function load(bytes) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    const msg = String(err && err.message || err);
    if (/encrypt/i.test(msg)) {
      const e = new Error('This PDF is encrypted or password protected. Remove the protection in the app that created it, then try again.');
      e.code = 'encrypted';
      throw e;
    }
    const e = new Error('This file could not be read as a PDF. It may be damaged or not a PDF at all.');
    e.code = 'invalid';
    throw e;
  }
}

function hasXFA(doc) {
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
  return Boolean(acro && acro.has && acro.has(PDFName.of('XFA')));
}

function widgetPosition(form, widget) {
  let page = 0;
  try {
    const p = form.findWidgetPage(widget);
    page = form.doc.getPages().indexOf(p);
  } catch { /* widget not attached to a page */ }
  const r = widget.getRectangle();
  return { page: Math.max(0, page), x: r.x, y: r.y + r.height };
}

function describe(form, field, index) {
  const kind = kindOf(field);
  const widgets = field.acroField.getWidgets();
  const pos = widgets.length ? widgetPosition(form, widgets[0]) : { page: 0, x: 0, y: 0 };
  const info = { index, name: field.getName(), kind, readOnly: field.isReadOnly(), ...pos };
  try {
    if (kind === 'text') {
      info.value = field.getText() || '';
      info.multiline = field.isMultiline();
      info.maxLength = field.getMaxLength() ?? null;
      info.comb = field.isCombed();
    } else if (kind === 'checkbox') {
      info.value = field.isChecked();
    } else if (kind === 'radio') {
      info.options = field.getOptions();
      info.value = field.getSelected() || '';
    } else if (kind === 'dropdown') {
      info.options = field.getOptions();
      info.value = field.getSelected()[0] || '';
    } else if (kind === 'optionlist') {
      info.options = field.getOptions();
      info.value = field.getSelected();
      info.multiple = field.isMultiselect();
    }
  } catch (err) {
    info.warning = `Could not read the current value (${err.message || err}).`;
  }
  return info;
}

async function inspect(bytes) {
  const doc = await load(bytes);
  const xfa = hasXFA(doc);
  let fields = [];
  if (doc.catalog.lookup(PDFName.of('AcroForm'))) {
    const form = doc.getForm();
    fields = form.getFields().map((f, i) => describe(form, f, i));
  }
  // Order the way a person reads the form: page, then top to bottom, then left to right.
  fields.sort((a, b) => a.page - b.page || (b.y - a.y > 4 ? 1 : a.y - b.y > 4 ? -1 : a.x - b.x));
  return { pages: doc.getPageCount(), xfa, fields };
}

function fontSizeOf(field) {
  const da = field.acroField.getDefaultAppearance() || '';
  const m = da.match(/([\d.]+)\s+Tf/);
  return m ? Number(m[1]) : 0;
}

// pdf-lib's auto font size (0) for multi-line fields picks a huge size and pushes every line after the
// first outside the box, so compute a size where the wrapped text really fits and set it explicitly.
function fitMultilineSize(field, font, text) {
  const widget = field.acroField.getWidgets()[0];
  if (!widget) return 10;
  const rect = widget.getRectangle();
  const width = Math.max(1, rect.width - 6);
  const height = Math.max(1, rect.height - 4);
  const lineHeight = 1.15;
  const countLines = (size) => {
    let lines = 0;
    for (const para of String(text).split(/\r\n|\r|\n/)) {
      const words = para.split(' ');
      let line = '';
      lines += 1;
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= width || !line) line = candidate;
        else { lines += 1; line = word; }
      }
    }
    return lines;
  };
  for (let size = 12; size >= 4; size -= 0.5) {
    if (countLines(size) * size * lineHeight <= height) return size;
  }
  return 4;
}

// Auto size (0) or a size the text no longer fits at (pdf-lib writes its oversized guess into the DA): shrink.
function fitMultiline(field, font, text) {
  if (!text) return;
  const current = fontSizeOf(field);
  const fitted = fitMultilineSize(field, font, text);
  if (current === 0 || current > fitted) field.setFontSize(fitted);
}

// Widgets with no normal appearance make pdf-lib's flatten() and removeField() throw ("Unexpected N type").
// Give them an empty appearance so they can be drawn (as nothing) or removed cleanly.
function ensureAppearance(doc, widget) {
  try { widget.getNormalAppearance(); return true; } catch { /* no /AP /N: repair below */ }
  try {
    const r = widget.getRectangle();
    const xo = doc.context.formXObject([], { BBox: [0, 0, Math.max(1, r.width), Math.max(1, r.height)] });
    widget.setNormalAppearance(doc.context.register(xo));
    return true;
  } catch {
    return false;
  }
}

// Remove a field even when pdf-lib's own removeField cannot (widget without a page or appearance).
function removeFieldSafely(form, field) {
  try { form.removeField(field); return true; } catch { /* fall back to detaching it from the field tree */ }
  try {
    const refs = [];
    const kids = field.acroField.normalizedEntries().Kids;
    if (kids) for (let i = 0; i < kids.size(); i++) { const k = kids.get(i); if (k instanceof PDFRef) refs.push(k); }
    refs.push(field.ref);
    for (const page of form.doc.getPages()) for (const ref of refs) { try { page.node.removeAnnot(ref); } catch { /* ignore */ } }
    form.acroForm.removeField(field.acroField);
    return true;
  } catch {
    return false;
  }
}

// pdf-lib leaves the removed widgets' references in each page's /Annots; drop the ones that no longer resolve.
function pruneAnnots(doc) {
  for (const page of doc.getPages()) {
    let annots;
    try { annots = page.node.Annots(); } catch { continue; }
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const ref = annots.get(i);
      if (ref instanceof PDFRef && !doc.context.lookup(ref)) annots.remove(i);
    }
  }
}

function applyValue(form, font, v) {
  const field = form.getField(v.name);
  const kind = kindOf(field);
  if (field.isReadOnly()) return;
  if (kind === 'text') {
    let text = String(v.value ?? '');
    const max = field.getMaxLength();
    if (max !== undefined && text.length > max) {
      text = text.slice(0, max);
      throw Object.assign(new Error(`text was cut to the field's limit of ${max} characters`), { partial: () => field.setText(text) });
    }
    field.setText(text);
    if (field.isMultiline()) {
      fitMultiline(field, font, text);
    } else if (text && !field.isCombed()) {
      // Long single-line text: switch to auto font size (0) so it shrinks to fit the box.
      const size = fontSizeOf(field) || 12;
      const widget = field.acroField.getWidgets()[0];
      if (widget && font.widthOfTextAtSize(text, size) > widget.getRectangle().width - 4) field.setFontSize(0);
    }
  } else if (kind === 'checkbox') {
    if (v.value) field.check(); else field.uncheck();
  } else if (kind === 'radio') {
    if (v.value) field.select(v.value); else field.clear();
  } else if (kind === 'dropdown') {
    if (v.value) field.select(v.value); else field.clear();
  } else if (kind === 'optionlist') {
    const list = Array.isArray(v.value) ? v.value : [v.value].filter(Boolean);
    if (list.length) field.select(list); else field.clear();
  }
}

async function save(bytes, values, flatten, flattenOnly, progress) {
  const doc = await load(bytes);
  const warnings = [];
  const xfa = hasXFA(doc);
  if (!doc.catalog.lookup(PDFName.of('AcroForm'))) throw Object.assign(new Error('This PDF has no form fields to fill or flatten.'), { code: 'nofields' });
  const form = doc.getForm(); // drops XFA data, so viewers fall back to the AcroForm fields
  if (xfa) warnings.push({ field: '', message: 'The XFA part of this form was removed; only the standard AcroForm fields were kept.' });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  progress(0.15);

  if (!flattenOnly) {
    values.forEach((v, i) => {
      try {
        applyValue(form, font, v);
      } catch (err) {
        if (err.partial) { try { err.partial(); } catch { /* keep going */ } }
        warnings.push({ field: v.name, message: err.message || String(err) });
      }
      progress(0.15 + 0.35 * ((i + 1) / Math.max(1, values.length)));
    });
  }

  // Redraw appearances field by field (Helvetica), so one odd field cannot break the rest.
  for (const field of form.getFields()) {
    const kind = kindOf(field);
    if (kind === 'signature' || kind === 'button') continue;
    try {
      if (field.needsAppearancesUpdate()) {
        // Prefilled multi-line fields with auto size get the same fitted size as the ones typed here.
        if (kind === 'text' && field.isMultiline()) fitMultiline(field, font, field.getText() || '');
        field.defaultUpdateAppearances(font);
      }
    } catch (err) {
      warnings.push({ field: field.getName(), message: `could not draw the value (${err.message || err})` });
    }
    try { field.markAsClean(); } catch { /* ignore */ }
  }
  progress(0.65);

  if (flatten || flattenOnly) {
    for (const field of form.getFields()) {
      const kind = kindOf(field);
      let ok = true;
      for (const w of field.acroField.getWidgets()) {
        if (!ensureAppearance(doc, w)) ok = false;
        try { form.findWidgetPage(w); form.findWidgetAppearanceRef(field, w); } catch { ok = false; }
      }
      if (!ok || kind === 'signature') {
        if (kind === 'signature') warnings.push({ field: field.getName(), message: 'signature field skipped and removed (signing is not supported)' });
        else warnings.push({ field: field.getName(), message: 'removed because it has no drawable appearance' });
        if (!removeFieldSafely(form, field)) warnings.push({ field: field.getName(), message: 'could not be removed; it was left as is' });
      }
    }
    try {
      form.flatten({ updateFieldAppearances: false });
    } catch (err) {
      throw Object.assign(new Error(`the form could not be flattened (${err.message || err}). Try saving with "Flatten after filling" off.`), { code: 'flatten' });
    }
    pruneAnnots(doc);
  }
  progress(0.85);
  const out = await doc.save();
  progress(1);
  return { bytes: out, warnings, fieldsLeft: doc.getForm().getFields().length };
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  const progress = (value) => self.postMessage({ id, type: 'progress', value });
  try {
    let result;
    if (type === 'inspect') result = await inspect(e.data.bytes);
    else if (type === 'save') result = await save(e.data.bytes, e.data.values || [], e.data.flatten, e.data.flattenOnly, progress);
    else throw new Error(`unknown task ${type}`);
    self.postMessage({ id, type: 'done', result }, result.bytes ? [result.bytes.buffer] : []);
  } catch (err) {
    self.postMessage({ id, type: 'error', code: err.code || 'failed', message: err.message || String(err) });
  }
};
