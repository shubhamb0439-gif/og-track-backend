const { MASTERADMIN_SENTINEL_MODULE } = require('../contextBuilder');
const config = require('../../config');
const browserless = require('../codingAgent/browserless');

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

  {
    name: 'browse_website',
    description:
      'Like scrape_webpage, but uses a REAL browser that renders JavaScript (the same engine the coding-agent\'s ' +
      'inspect_website uses) — slower and not free, so only reach for this when scrape_webpage either (a) came back ' +
      'with suspiciously little text for a real page (a sign the site is a JS-rendered app — React/Vue/Shopify/etc, ' +
      'where the raw HTML is mostly empty until a browser runs it), or (b) the user wants something searched for ' +
      'across a few linked pages on the same site, not just one (set maxPages > 1 to follow same-origin links). ' +
      'Returns each page\'s title and real rendered text — read through it yourself for whatever the user asked ' +
      'about; this tool does not do the "searching" itself, it just gets you real content to reason over.',
    requiredModules: [MASTERADMIN_SENTINEL_MODULE],
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'A full URL, e.g. https://example.com/page' },
        maxPages: { type: 'integer', description: 'How many same-origin pages to visit, following links from the start page (default 1, max 5). Only raise this when you actually need to search across multiple pages.' },
      },
      required: ['url'],
    },
    async handler(context, { url, maxPages }) {
      if (!config.aida.browserless.enabled) {
        return { error: 'Real-browser browsing is not configured on this server yet (missing BROWSERLESS_API_KEY) — use scrape_webpage instead.' };
      }
      let startUrl;
      try {
        startUrl = new URL(url);
      } catch {
        return { error: `"${url}" is not a valid URL.` };
      }
      if (!/^https?:$/.test(startUrl.protocol)) {
        return { error: 'Only http:// and https:// URLs are supported.' };
      }

      const cappedMaxPages = Math.min(Math.max(Number(maxPages) || 1, 1), 5);
      const visited = new Set();
      const queue = [startUrl.toString()];
      const pages = [];

      while (queue.length && pages.length < cappedMaxPages) {
        const pageUrl = queue.shift();
        if (visited.has(pageUrl)) continue;
        visited.add(pageUrl);

        let data;
        try {
          data = await browserless.fetchPage(pageUrl);
        } catch (e) {
          pages.push({ url: pageUrl, error: e.message });
          continue;
        }

        const text = browserless.extractText((data.html || '').slice(0, 400_000));
        pages.push({
          url: pageUrl,
          title: data.title || null,
          textContent: text.slice(0, 6_000),
          truncated: text.length > 6_000,
        });

        if (cappedMaxPages > 1) {
          for (const link of data.links || []) {
            try {
              const linkUrl = new URL(link);
              linkUrl.hash = '';
              const normalized = linkUrl.toString();
              if (linkUrl.origin === startUrl.origin && !visited.has(normalized) && !queue.includes(normalized)) {
                queue.push(normalized);
              }
            } catch { /* malformed link — skip */ }
          }
        }
      }

      return { startUrl: startUrl.toString(), pagesVisited: pages.length, pages };
    },
  },
];
