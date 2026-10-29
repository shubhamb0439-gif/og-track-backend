const PDFDocument = require('pdfkit');
const { uploadBuffer, logoContainerName } = require('../../../utils/blobStorage');

/**
 * Fast, synchronous PDF generation from structured data (a title, optional
 * narrative text, and/or a flat table of rows) — built specifically because
 * generate_document (devops.js, Anthropic's pptx/xlsx/docx/pdf Skills) is a
 * background job that can take 2+ minutes and only ever returns a job id,
 * not a file. That doesn't fit a Flow step, which needs one synchronous
 * result to hand straight to the next step (e.g. message_contact's
 * attachFileUrl). This renders directly via pdfkit (pure JS, already a
 * dependency, no external API call) — typically well under a second — and
 * uploads to the same public "branding-logos" container + "aida-generated/"
 * prefix convention generateDocument.js already established, so its fileUrl
 * is interchangeable with that job's own output for send_email/
 * message_contact's attachFileUrl.
 */

const FILES_CONTAINER = logoContainerName;
const BLOB_PREFIX = 'aida-generated/';
const PAGE_MARGIN = 50;

/** Renders doc's content, returns the finished PDF as a Buffer. */
function renderPdfBuffer({ title, text, rows }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(18).text(title, { align: 'left' });
    doc.moveDown();

    if (text && text.trim()) {
      doc.font('Helvetica').fontSize(11).text(text.trim(), { align: 'left' });
      doc.moveDown();
    }

    if (Array.isArray(rows) && rows.length) {
      renderTable(doc, rows);
    }

    doc.end();
  });
}

/** A plain, bordered table — no external table library needed for flat objects. Paginates by checking remaining space before each row. */
function renderTable(doc, rows) {
  const columns = Object.keys(rows[0] || {});
  if (!columns.length) return;

  const usableWidth = doc.page.width - PAGE_MARGIN * 2;
  const colWidth = usableWidth / columns.length;
  const rowHeight = 20;

  const drawHeader = () => {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9);
    columns.forEach((col, i) => {
      doc.text(String(col), PAGE_MARGIN + i * colWidth, y, { width: colWidth - 4, ellipsis: true });
    });
    doc.moveDown(0.8);
    doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + usableWidth, doc.y).strokeColor('#999999').stroke();
    doc.moveDown(0.3);
  };

  drawHeader();
  doc.font('Helvetica').fontSize(9);

  for (const row of rows) {
    if (doc.y + rowHeight > doc.page.height - PAGE_MARGIN) {
      doc.addPage();
      drawHeader();
      doc.font('Helvetica').fontSize(9);
    }
    const y = doc.y;
    columns.forEach((col, i) => {
      const value = row[col];
      const display = value === null || value === undefined ? '' : String(value);
      doc.text(display, PAGE_MARGIN + i * colWidth, y, { width: colWidth - 4, ellipsis: true });
    });
    doc.moveDown(0.9);
  }
}

module.exports = [
  {
    name: 'make_pdf',
    category: 'Documents',
    description:
      'Generates a real PDF file from data you already have — a title, optional narrative text, and/or a flat ' +
      'table of rows (an array of plain objects; each object\'s keys become the table\'s columns) — and returns ' +
      'its fileUrl immediately (typically under a second, unlike generate_document which is a multi-minute ' +
      'background job). Use this specifically when you need the file right away to pass to another step or tool ' +
      '— e.g. a Flow step whose output feeds message_contact/send_email\'s attachFileUrl. For a richly designed ' +
      'slide deck/spreadsheet/formatted Word document instead, use generate_document — this tool is deliberately ' +
      'plain (title + text + a simple bordered table), not a layout engine.',
    requiredModules: ['__masteradmin__'],
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The document title, shown as a heading at the top of page 1.' },
        text: { type: 'string', description: 'Optional narrative paragraph shown below the title, above any table.' },
        rows: {
          type: 'array',
          description: 'Optional tabular data — an array of flat objects, e.g. [{paymentId: "...", email: "...", amount: 500}]. Rendered as a bordered table, one column per key found on the first row.',
          items: { type: 'object' },
        },
      },
      required: ['title'],
    },
    async handler(context, { title, text, rows }) {
      let buffer;
      try {
        buffer = await renderPdfBuffer({ title, text, rows });
      } catch (e) {
        return { error: `PDF rendering failed: ${e.message}` };
      }

      const safeTitle = title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60) || 'document';
      const filename = `${safeTitle}.pdf`;
      const blobName = `${BLOB_PREFIX}${Date.now()}-${safeTitle}.pdf`;

      try {
        const fileUrl = await uploadBuffer(buffer, blobName, 'application/pdf', FILES_CONTAINER);
        return { success: true, fileUrl, filename, rowCount: Array.isArray(rows) ? rows.length : 0 };
      } catch (e) {
        return { error: `PDF generated but upload failed: ${e.message}` };
      }
    },
  },
];
