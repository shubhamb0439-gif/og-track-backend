const { MASTERADMIN_SENTINEL_MODULE } = require('../contextBuilder');

/**
 * Master-admin-only "AIDA can look at a real webpage" tool. Lightweight,
 * dependency-free HTML-to-text extraction (regex-based, same spirit as
 * voice/textCleaner.js's markdown stripping elsewhere in this codebase) —
 * good enough for "summarize this" and "use this as content/design
 * reference", not a full browser-grade readability parser.
 */

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' '));
}

const MAX_TEXT_CHARS = 12_000;
const MAX_HEADINGS = 30;

function extractReadableContent(html) {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(cleaned);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : null;

  const descMatch = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(cleaned)
    || /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i.exec(cleaned);
  const description = descMatch ? decodeEntities(descMatch[1]).trim() : null;

  const headings = [];
  const headingRe = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = headingRe.exec(cleaned)) && headings.length < MAX_HEADINGS) {
    const text = stripTags(m[2]).replace(/\s+/g, ' ').trim();
    if (text) headings.push({ level: Number(m[1]), text });
  }

  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(cleaned);
  const textContent = stripTags(bodyMatch ? bodyMatch[1] : cleaned)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_CHARS);

  return { title, description, headings, textContent };
}

module.exports = [
  {
    name: 'scrape_webpage',
    description:
      "Fetches a real webpage and extracts its title, meta description, headings, and text content. Use this " +
      "whenever the user references an existing URL — to summarize what's on it, or to gather its actual content " +
      "before redesigning/rebuilding something based on it. IMPORTANT: the coding-agent tools (create_module, " +
      "dev_repo_fix) have NO internet access themselves — they can only see whatever text you put directly in " +
      "their task description. So if the user asks you to rebuild/redesign a page based on a URL, call this tool " +
      "FIRST, then paste the actual extracted content (not just the URL) into the task you give create_module or " +
      "dev_repo_fix, with instructions like 'use this exact content, redesign the presentation'.",
    requiredModules: [MASTERADMIN_SENTINEL_MODULE],
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'A full URL, e.g. https://example.com/page' } },
      required: ['url'],
    },
    async handler(context, { url }) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return { error: `"${url}" is not a valid URL.` };
      }
      if (!/^https?:$/.test(parsed.protocol)) {
        return { error: 'Only http:// and https:// URLs are supported.' };
      }

      let res;
      try {
        res = await fetch(parsed.toString(), {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OGTrackAIDA/1.0)' },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        return { error: `Could not reach that URL: ${e.message}` };
      }
      if (!res.ok) {
        return { error: `That URL returned HTTP ${res.status}.` };
      }
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) {
        return { error: `That URL isn't an HTML page (content-type: ${contentType || 'unknown'}) — nothing to extract.` };
      }

      const html = await res.text();
      const { title, description, headings, textContent } = extractReadableContent(html);
      return {
        url: parsed.toString(),
        title,
        description,
        headings,
        textContent,
        truncated: textContent.length >= MAX_TEXT_CHARS,
      };
    },
  },
];
