// smoke.spec.js — tool-specific checks for PDF Form Filler and Flattener.
// Fixtures: tests/fixtures/tenant-application.pdf and encrypted.pdf (fictional, made by tests/fixtures/make-fixtures.js).
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { PDFDocument } = require('../vendor/pdf-lib/pdf-lib.min.js');

const fixture = (name) => path.join(__dirname, 'fixtures', name);
const FORM = fixture('tenant-application.pdf');

async function openForm(page) {
  await page.goto('./');
  await page.setInputFiles('#file-input', FORM);
  await expect(page.locator('#options')).toBeVisible();
  await expect(page.locator('#form-panel .ff')).toHaveCount(6);
}

const field = (page, name) => page.locator(`.ff[data-field-name="${name}"]`);

async function saveAndDownload(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
  expect(download.suggestedFilename()).toBe('tenant-application_filled.pdf');
  const bytes = fs.readFileSync(await download.path());
  expect(bytes.length).toBeGreaterThan(1000);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  return bytes;
}

// All stream contents (inflated where possible) plus the raw file, as latin1 text.
function pdfText(bytes) {
  const raw = Buffer.from(bytes).toString('latin1');
  let out = raw;
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const chunk = Buffer.from(raw.slice(start, end), 'latin1');
    try { out += zlib.inflateSync(chunk).toString('latin1'); } catch { /* not compressed */ }
  }
  return out;
}
const hex = (s) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();
const containsText = (bytes, s) => { const t = pdfText(bytes); return t.includes(s) || t.toUpperCase().includes(hex(s)); };

// Font size and text positions of the appearance stream that draws `s` (hex encoded, as pdf-lib writes it).
function drawnText(bytes, s) {
  const raw = Buffer.from(bytes).toString('latin1');
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    let text;
    try { text = zlib.inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'); } catch { text = raw.slice(start, end); }
    if (!text.toUpperCase().includes(hex(s))) continue;
    const size = Number((text.match(/([\d.]+)\s+Tf/) || [])[1]);
    const ys = [...text.matchAll(/1 0 0 1 [\d.-]+ ([\d.-]+) Tm/g)].map((x) => Number(x[1]));
    return { size, ys };
  }
  return null;
}

test.describe('PDF Form Filler and Flattener', () => {
  test('loading the bundled form lists its fields with types', async ({ page }) => {
    await openForm(page);
    await expect(page.locator('#summary')).toHaveText(/6 fields · 0 filled · 1 page/);
    await expect(page.locator('.fill__page legend').first()).toHaveText('Page 1');
    const expected = [
      ['Full name', 'Text'],
      ['Current address', 'Text (multi-line)'],
      ['Date', 'Text'],
      ['Pets', 'Checkbox'],
      ['Unit type', 'Radio group'],
      ['Move-in month', 'Dropdown'],
    ];
    const names = await page.locator('#form-panel .ff').evaluateAll((els) => els.map((e) => e.dataset.fieldName));
    expect(names).toEqual(expected.map(([n]) => n)); // reading order, top to bottom
    for (const [name, type] of expected) {
      await expect(field(page, name).locator('.ff__name')).toHaveText(name);
      await expect(field(page, name).locator('.ff__type').first()).toHaveText(type);
    }
    await expect(page.getByLabel('Full name')).toHaveJSProperty('tagName', 'INPUT');
    await expect(page.getByLabel('Current address')).toHaveJSProperty('tagName', 'TEXTAREA');
    await expect(field(page, 'Unit type').locator('input[type=radio]')).toHaveCount(3);
    await expect(page.getByLabel('Move-in month').locator('option')).toHaveCount(13);
    await expect(page.locator('#flatten')).toBeChecked();
  });

  test('typing a name in a text field and saving produces a PDF containing that text', async ({ page }) => {
    await openForm(page);
    await page.locator('#flatten').uncheck({ force: true });
    await page.getByLabel('Full name').fill('Jordan Example');
    // Enter in a single-line field must not submit or save anything.
    await page.getByLabel('Full name').press('Enter');
    await expect(page.locator('#results .result')).toHaveCount(0);
    await expect(page.locator('#summary')).toHaveText(/1 filled/);
    const bytes = await saveAndDownload(page);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getForm().getTextField('Full name').getText()).toBe('Jordan Example');
    expect(containsText(bytes, 'Jordan Example')).toBe(true);
    await expect(page.locator('#results .result')).toContainText('still editable');
  });

  test('with flatten enabled the saved PDF has zero form fields', async ({ page }) => {
    await openForm(page);
    await expect(page.locator('#flatten')).toBeChecked();
    await page.getByLabel('Full name').fill('Riley Sample');
    await page.getByLabel('Current address').fill('7 Placeholder Road\nSampleville');
    const bytes = await saveAndDownload(page);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getForm().getFields()).toHaveLength(0);
    expect(containsText(bytes, 'Riley Sample')).toBe(true);
    expect(containsText(bytes, 'Sampleville')).toBe(true); // second line of the multi-line field kept
    await expect(page.locator('#result-info')).toContainText('0 form fields left');
    // The download button in the result card offers the same file again.
    const [again] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
    expect(again.suggestedFilename()).toBe('tenant-application_filled.pdf');
  });

  test('multi-line text stays inside its box at a readable size when flattened', async ({ page }) => {
    await openForm(page);
    await page.getByLabel('Current address').fill('12 Sample Street\nExampletown, EX 00000\nThird line');
    const bytes = await saveAndDownload(page);
    expect((await PDFDocument.load(bytes)).getForm().getFields()).toHaveLength(0);
    // pdf-lib's auto size used to pick ~53 pt and push lines 2+ below the 63 pt box, where they were clipped.
    const drawn = drawnText(bytes, 'Exampletown, EX 00000');
    expect(drawn, 'the second line is drawn').not.toBeNull();
    expect(drawn.size).toBeGreaterThanOrEqual(4);
    expect(drawn.size).toBeLessThanOrEqual(14);
    expect(drawn.ys).toHaveLength(3);
    for (const y of drawn.ys) { expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(63); }
  });

  test('a form with an unsigned signature field that has no appearance still flattens', async ({ page }) => {
    await page.goto('./');
    await page.setInputFiles('#file-input', fixture('signature-form.pdf'));
    await expect(page.locator('#summary')).toHaveText(/2 fields · 0 filled · 1 page · 1 skipped/);
    await expect(field(page, 'Signature').locator('.ff__type').first()).toHaveText('Signature');
    await expect(field(page, 'Signature')).toContainText('skipped');
    await page.getByLabel('Applicant').fill('Casey Placeholder');
    await page.getByLabel('Notes').fill('first line\nsecond line');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
    expect(download.suggestedFilename()).toBe('signature-form_filled.pdf');
    const bytes = fs.readFileSync(await download.path());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getForm().getFields()).toHaveLength(0);
    expect(containsText(bytes, 'Casey Placeholder')).toBe(true);
    expect(containsText(bytes, 'second line')).toBe(true);
    // No stale widget references are left on the page after flattening.
    const annots = doc.getPage(0).node.Annots();
    expect(annots ? annots.size() : 0).toBe(0);
    await expect(page.locator('#results .alert--error')).toHaveCount(0);
    await expect(page.locator('#warnings')).toContainText('Signature: signature field skipped');
    // Flatten only works on the same file too.
    await page.locator('label.seg', { hasText: 'Flatten only' }).click();
    const [again] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
    expect((await PDFDocument.load(fs.readFileSync(await again.path()))).getForm().getFields()).toHaveLength(0);
  });

  test('flatten only mode flattens the form as is', async ({ page }) => {
    await openForm(page);
    await page.locator('label.seg', { hasText: 'Flatten only' }).click();
    await expect(page.getByLabel('Full name')).toBeDisabled();
    const bytes = await saveAndDownload(page);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getForm().getFields()).toHaveLength(0);
  });

  test('checkboxes and dropdown choices can be set', async ({ page }) => {
    await openForm(page);
    await page.locator('#flatten').uncheck({ force: true });
    await page.getByLabel('Pets').check();
    await page.getByLabel('One bedroom').check();
    await page.getByLabel('Move-in month').selectOption('November');
    await expect(page.locator('#summary')).toHaveText(/3 filled/);
    const bytes = await saveAndDownload(page);
    const form = (await PDFDocument.load(bytes)).getForm();
    expect(form.getCheckBox('Pets').isChecked()).toBe(true);
    expect(form.getRadioGroup('Unit type').getSelected()).toBe('One bedroom');
    expect(form.getDropdown('Move-in month').getSelected()).toEqual(['November']);
    // Reset brings back the original (empty) values.
    await page.click('#reset');
    await expect(page.getByLabel('Pets')).not.toBeChecked();
    await expect(page.getByLabel('Move-in month')).toHaveValue('');
    await expect(page.locator('#summary')).toHaveText(/0 filled/);
  });

  test('characters outside the standard font are reported and can be replaced', async ({ page }) => {
    await openForm(page);
    await page.getByLabel('Full name').fill('Zoë Ąnna ☺');
    const warn = field(page, 'Full name').locator('.ff__warn');
    await expect(warn).toBeVisible();
    await expect(warn).toContainText('☺');
    await page.click('#save');
    await expect(page.locator('#results .alert--error')).toContainText('Full name');
    await warn.getByRole('button', { name: 'Replace them' }).click();
    await expect(page.getByLabel('Full name')).toHaveValue('Zoë Anna ?');
    await expect(warn).toBeHidden();
  });

  test('wrong file types, PDFs without fields and encrypted PDFs get clear inline messages', async ({ page }) => {
    await page.goto('./');
    await page.setInputFiles('#file-input', fixture('sample.png'));
    await expect(page.locator('#results .alert--error')).toContainText('sample.png is not a PDF');

    await page.setInputFiles('#file-input', fixture('encrypted.pdf'));
    await expect(page.locator('#results .alert--error')).toContainText('encrypted');
    await expect(page.locator('#options')).toBeHidden();

    await page.setInputFiles('#file-input', fixture('sample.pdf'));
    await expect(page.locator('#notice')).toContainText('no fillable form fields');
    await expect(page.locator('#mode-flatten-only')).toBeDisabled();
    await expect(page.locator('#save')).toBeDisabled();
  });

  test('layout works at 390px wide', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openForm(page);
    await page.getByLabel('Full name').fill('Jordan Example');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
    expect(download.suggestedFilename()).toMatch(/_filled\.pdf$/);
    await expect(page.locator('#results .result')).toBeVisible();
    const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
    expect(widths.doc).toBeLessThanOrEqual(widths.win + 1);
    for (const sel of ['#save', '#reset', '#download', '#form-panel', '.fill__modes']) {
      const box = await page.locator(sel).boundingBox();
      expect(box.x, `${sel} starts inside the viewport`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${sel} ends inside the viewport`).toBeLessThanOrEqual(391);
    }
  });

  test('demo shows a filled, saved tenant form', async ({ page }) => {
    await page.goto('./');
    await page.evaluate(() => window.__demo());
    await expect(page.locator('#results .result')).toContainText('tenant-application_filled.pdf');
    await expect(page.locator('#summary')).toHaveText(/6 fields · 6 filled/);
  });
});
