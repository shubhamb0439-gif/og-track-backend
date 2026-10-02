/**
 * Shared "extract readable text from a file buffer" helper — originally
 * private to emailMonitor.js, pulled out once a second real caller (inbound
 * WhatsApp document/image attachments) needed the identical PDF/.docx
 * extraction logic. Returns '' for anything else (images, spreadsheets,
 * unknown types) rather than throwing — callers decide what, if anything,
 * to do when there's no text to show.
 */

async function extractTextFromBuffer(buffer, filename) {
  const lower = String(filename || '').toLowerCase();
  try {
    if (lower.endsWith('.pdf')) {
      // v2's API is a class, not the plain callable function older v1 had
      // (require('pdf-parse') returns { PDFParse, ...exception types }).
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse({ data: buffer });
      try {
        const parsed = await parser.getText();
        return parsed.text || '';
      } finally {
        await parser.destroy();
      }
    }
    if (lower.endsWith('.docx')) {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return result.value || '';
    }
  } catch (e) {
    console.error(`[attachmentText] failed to extract text from "${filename}":`, e.message);
    return '';
  }
  return '';
}

module.exports = { extractTextFromBuffer };
