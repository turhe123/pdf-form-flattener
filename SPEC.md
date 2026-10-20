# PDF Form Filler and Flattener — specification

**Tagline:** Fill in PDF form fields and flatten them into plain pages in your browser, with no upload.

**Category:** PDF

**Free alternative to:** Smallpdf and Sejda Flatten PDF (uploads forms with personal data, free task limits, account or paid plan for more)

**Search phrases:** fill pdf form online, flatten pdf, flatten pdf form fields, make pdf form non editable, fill and save pdf free, lock pdf form fields

**Allowed libraries:** pdf-lib

**Published at:** https://turhe123.github.io/pdf-form-flattener/

## Acceptance checks (each must have a test)

- loading the bundled form lists its fields with types
- typing a name in a text field and saving produces a PDF containing that text
- with flatten enabled the saved PDF has zero form fields
- checkboxes and dropdown choices can be set
- layout works at 390px wide

## Spec

People search fill pdf form online and flatten pdf when they must submit tax, visa, rental or HR forms. Incumbents upload the file with personal data such as addresses and ID numbers, limit free daily tasks, and charge for flattening or batch use. The need to make a filled form non editable is especially common because recipients reject forms that can be altered.

Our version does one job: list the interactive fields of an AcroForm PDF, let the user fill them, and optionally flatten so the values become fixed page content. It does not draw free text on non form PDFs and it does not sign.

UI: a drop zone for one PDF. After loading, a form panel lists each field grouped by page, with the proper control: text input or textarea for text fields, checkbox, radio group, dropdown and option list. Field names are shown as labels. A switch Flatten after filling is on by default. A secondary mode named Flatten only skips editing and flattens as is. A summary shows the number of fields and how many are filled. Buttons: Save PDF producing name_filled.pdf, and Reset. When the PDF has no form fields a friendly message explains this and offers flatten only to be disabled. Errors for encrypted files are inline. Keyboard: Tab moves through fields in order, Enter in a single line input does not submit.

Technical approach: pdf-lib loads the document, getForm lists fields via getFields and their constructor names to decide the control. On Save, set values with setText, check or uncheck, select, then call form.updateFieldAppearances using an embedded Helvetica font so values render, and if flatten is on call form.flatten to merge appearances into page content. Save to bytes and offer a Blob download. Since pdf-lib sometimes fails on odd fields, wrap each field assignment in try and collect warnings shown after saving. Characters outside the standard font range are reported per field, and the user may replace them. Preview is optional and omitted to keep the code short.

Edge cases: XFA forms are not supported and a message says so, required fields flags are ignored, multiline fields keep line breaks, fields with the same name share values, signature fields are skipped, read only fields are shown disabled, very long text may overflow the field box and shrinks with the auto font size of zero where the field allows it, and mobile Safari downloads happen on a tap.

Demo data: a bundled fictional one page form made with pdf-lib named Tenant Application Demo, with text fields for name and address, a date, a checkbox for pets, a radio group for unit type and a dropdown for move in month.
