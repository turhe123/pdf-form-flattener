// Generates the fictional PDF fixtures used by the demo and the smoke tests.
// Run from the tool folder: node tests/fixtures/make-fixtures.js
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb, PDFString } = require('../../vendor/pdf-lib/pdf-lib.min.js');

const out = (name) => path.join(__dirname, name);

async function tenantForm() {
  const doc = await PDFDocument.create();
  doc.setTitle('Tenant Application Demo');
  doc.setAuthor('Example Property Co.');
  doc.setCreator('pdf-form-flattener fixtures');
  doc.setProducer('pdf-lib');
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const form = doc.getForm();
  const ink = rgb(0.12, 0.13, 0.18);
  const label = (text, x, y) => page.drawText(text, { x, y, size: 11, font: bold, color: ink });

  page.drawText('Tenant Application Demo', { x: 50, y: 780, size: 22, font: bold, color: ink });
  page.drawText('Example Property Co. - fictional sample form for testing', { x: 50, y: 760, size: 10, font, color: rgb(0.4, 0.42, 0.5) });

  label('Full name', 50, 715);
  form.createTextField('Full name').addToPage(page, { x: 50, y: 685, width: 495, height: 24 });

  label('Current address', 50, 660);
  const address = form.createTextField('Current address');
  address.enableMultiline();
  address.addToPage(page, { x: 50, y: 590, width: 495, height: 62 });

  label('Date', 50, 565);
  form.createTextField('Date').addToPage(page, { x: 50, y: 535, width: 200, height: 24 });

  label('Pets', 50, 505);
  form.createCheckBox('Pets').addToPage(page, { x: 50, y: 478, width: 18, height: 18 });
  page.drawText('I will keep pets in the unit', { x: 76, y: 482, size: 11, font, color: ink });

  label('Unit type', 50, 445);
  const unit = form.createRadioGroup('Unit type');
  [['Studio', 50], ['One bedroom', 190], ['Two bedroom', 350]].forEach(([opt, x]) => {
    unit.addOptionToPage(opt, page, { x, y: 418, width: 18, height: 18 });
    page.drawText(opt, { x: x + 26, y: 422, size: 11, font, color: ink });
  });

  label('Move-in month', 50, 385);
  const month = form.createDropdown('Move-in month');
  month.addOptions(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
  month.addToPage(page, { x: 50, y: 355, width: 200, height: 24 });

  form.updateFieldAppearances(font);
  fs.writeFileSync(out('tenant-application.pdf'), await doc.save());
}

// A tiny PDF whose trailer declares encryption, so the tool's encrypted-file error path can be tested.
async function encrypted() {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const bytes = Buffer.from(await doc.save({ useObjectStreams: false })).toString('latin1');
  const patched = bytes.replace('trailer\n<<', 'trailer\n<<\n/Encrypt << /Filter /Standard /V 1 /R 2 >>');
  if (patched === bytes) throw new Error('trailer not found');
  fs.writeFileSync(out('encrypted.pdf'), Buffer.from(patched, 'latin1'));
}

// A short form whose unsigned signature field has no appearance stream (common in generated forms); the text
// field has a multi-line box with auto font size. Both used to break flattening.
async function signatureForm() {
  const doc = await PDFDocument.create();
  doc.setTitle('Signature Demo');
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  page.drawText('Signature Demo - fictional sample form', { x: 50, y: 780, size: 14, font });
  form.createTextField('Applicant').addToPage(page, { x: 50, y: 700, width: 300, height: 24 });
  const notes = form.createTextField('Notes');
  notes.enableMultiline();
  notes.addToPage(page, { x: 50, y: 600, width: 400, height: 60 });
  const sig = doc.context.obj({ FT: 'Sig', T: PDFString.of('Signature'), Type: 'Annot', Subtype: 'Widget', Rect: [50, 480, 300, 540], F: 4, P: page.ref });
  const sigRef = doc.context.register(sig);
  form.acroForm.addField(sigRef);
  page.node.addAnnot(sigRef);
  form.updateFieldAppearances(font);
  fs.writeFileSync(out('signature-form.pdf'), await doc.save({ updateFieldAppearances: false }));
}

(async () => {
  await tenantForm();
  await encrypted();
  await signatureForm();
  console.log('fixtures written');
})();
