/**
 * Strips markdown/code/structural noise an LLM reply can contain before it
 * reaches TTS, without disturbing punctuation that carries speech rhythm
 * (periods, commas, question marks — textChunker.js relies on those).
 * Pure, no I/O.
 */

function stripCodeFences(text) {
  // Replace fenced code blocks with a short spoken stand-in rather than
  // reading punctuation/symbols aloud line by line.
  return text.replace(/```[\s\S]*?```/g, ' (code block omitted) ');
}

function stripInlineCode(text) {
  return text.replace(/`([^`]+)`/g, '$1');
}

function stripMarkdownEmphasis(text) {
  return text
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1');
}

function stripMarkdownHeadings(text) {
  return text.replace(/^#{1,6}\s+/gm, '');
}

function stripMarkdownLinks(text) {
  // "[label](url)" -> "label"; bare URLs are dropped entirely (not useful spoken aloud).
  return text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '');
}

function stripListMarkers(text) {
  return text.replace(/^\s*[-*+]\s+/gm, '').replace(/^\s*\d+\.\s+/gm, '');
}

function stripJsonBlocks(text) {
  // A reply is never *supposed* to be raw JSON/tool-call syntax (only the
  // final user-facing text ever reaches this layer), but strip defensively
  // in case a stray object literal slips through.
  return text.replace(/\{[^{}]{0,400}\}/g, (m) => (/["']\s*:\s*/.test(m) ? ' ' : m));
}

function collapseWhitespace(text) {
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function cleanForSpeech(text) {
  if (!text) return '';
  let out = text;
  out = stripCodeFences(out);
  out = stripJsonBlocks(out);
  out = stripMarkdownLinks(out);
  out = stripInlineCode(out);
  out = stripMarkdownEmphasis(out);
  out = stripMarkdownHeadings(out);
  out = stripListMarkers(out);
  out = collapseWhitespace(out);
  return out;
}

module.exports = { cleanForSpeech };
