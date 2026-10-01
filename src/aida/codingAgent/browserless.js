const fs = require('fs');
const path = require('path');
const config = require('../../config');

/**
 * AIDA roadmap item 7 — website inspection for the coding agent, via a
 * hosted headless-browser API (Browserless), not a self-hosted Playwright/
 * Chromium — see config.js's `aida.browserless` block for why self-hosting was
 * ruled out without spending the plan's own "spike this first" 30 minutes
 * on it (the coding-agent sandbox already confirmed `git` itself is missing
 * in this exact deployment environment).
 *
 * inspectWebsite() crawls up to `maxPages` same-origin pages via a single
 * Browserless `/function` call per page (navigate, grab the rendered HTML,
 * same-origin links, title, and a screenshot, all server-side in one round
 * trip). Critically, it does NOT return full HTML/screenshot bytes in its
 * own return value — both provider loops truncate a tool's JSON result at
 * 30,000 characters, which a single page's raw HTML + base64 screenshot can
 * blow through on its own, let alone 15 of them. Instead, each page's
 * cleaned HTML and screenshot are saved as real files under
 * <sandboxDir>/_website_inspection/, and the return value is just a short
 * index (url, title, a text preview, file paths) — the agent then uses the
 * EXISTING read_file tool to pull full content for whichever specific
 * page(s) it actually needs, the same "explore incrementally" pattern
 * list_files/read_file already established.
 */

const FUNCTION_CODE = `
export default async ({ page, context }) => {
  const { url } = context;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  // Rewrite every <img src> to its already-resolved absolute form BEFORE
  // capturing outerHTML — the raw attribute is often site-relative (e.g.
  // src="/logo.png"), which the cleaned HTML would otherwise carry through
  // verbatim; the .src PROPERTY (unlike getAttribute) is always fully
  // resolved by the browser itself, so this needs no URL-joining logic here.
  await page.evaluate(() => {
    document.querySelectorAll('img[src]').forEach((img) => img.setAttribute('src', img.src));
  });
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  const title = await page.title();
  const links = await page.evaluate(() => {
    const origin = window.location.origin;
    return Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.href)
      .filter((href) => { try { return new URL(href).origin === origin; } catch { return false; } });
  });
  // Explicit, capped list of real image URLs — so the agent doesn't have to
  // re-parse them back out of the HTML itself before calling download_file.
  const images = await page.evaluate(() => {
    const seen = new Set();
    const out = [];
    for (const img of document.querySelectorAll('img[src]')) {
      if (!img.src || seen.has(img.src)) continue;
      seen.add(img.src);
      out.push({ src: img.src, alt: img.alt || null });
      if (out.length >= 40) break;
    }
    return out;
  });
  const screenshot = await page.screenshot({ encoding: 'base64' });
  return { data: { html, title, links, images, screenshot }, type: 'application/json' };
};
`;

const FETCH_TIMEOUT_MS = 35_000; // headroom over the in-browser 30s navigation timeout above
const MAX_HTML_CHARS = 400_000; // sanity ceiling on raw HTML before cleaning — no real page should need more

async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.aida.browserless.baseUrl}/function?token=${config.aida.browserless.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: FUNCTION_CODE, context: { url } }),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.message || `Browserless request failed (${res.status})`);
    return json.data; // { html, title, links, screenshot }
  } finally {
    clearTimeout(timeout);
  }
}

/** Strips scripts/styles/svg/comments and every attribute except href/src/alt/class/id — keeps structure, drops bulk. */
function cleanHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '<svg/>')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    // Trailing (\/?) handles self-closing tags (<img .../>, <br/>) — without
    // it, the stray "/" before ">" doesn't match, so the whole tag skips
    // this replace entirely and keeps every original attribute untouched
    // (found by testing against a real sample with an <img /> tag).
    .replace(/<([a-z0-9]+)((?:\s+[a-zA-Z-:]+(?:="[^"]*"|='[^']*')?)*)\s*(\/?)>/gi, (match, tag, attrs, selfClose) => {
      const kept = [];
      const attrRegex = /([a-zA-Z-:]+)(?:="([^"]*)"|='([^']*)')?/g;
      let m;
      while ((m = attrRegex.exec(attrs))) {
        const name = m[1].toLowerCase();
        if (['href', 'src', 'alt', 'class', 'id'].includes(name)) {
          kept.push(m[2] !== undefined || m[3] !== undefined ? `${name}="${m[2] ?? m[3]}"` : name);
        }
      }
      return `<${tag}${kept.length ? ' ' + kept.join(' ') : ''}${selfClose ? ' /' : ''}>`;
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function extractText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function inspectWebsite(sandboxDir, startUrl, { maxPages = 15 } = {}) {
  if (!config.aida.browserless.enabled) {
    throw new Error('Website inspection is not configured on this server yet (missing BROWSERLESS_API_KEY).');
  }

  const startOrigin = new URL(startUrl).origin;
  const visited = new Set();
  const queue = [startUrl];
  const pages = [];

  const baseDir = path.join(sandboxDir, '_website_inspection');
  const pagesDir = path.join(baseDir, 'pages');
  const shotsDir = path.join(baseDir, 'screenshots');
  fs.mkdirSync(pagesDir, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });

  while (queue.length && pages.length < maxPages) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    let data;
    try {
      data = await fetchPage(url);
    } catch (e) {
      pages.push({ url, error: e.message });
      continue;
    }

    const rawHtml = (data.html || '').slice(0, MAX_HTML_CHARS);
    const cleaned = cleanHtml(rawHtml);
    const text = extractText(rawHtml);
    const index = pages.length;

    const htmlFile = `_website_inspection/pages/${index}.html`;
    fs.writeFileSync(path.join(pagesDir, `${index}.html`), cleaned, 'utf8');

    let screenshotFile = null;
    if (data.screenshot) {
      screenshotFile = `_website_inspection/screenshots/${index}.png`;
      fs.writeFileSync(path.join(shotsDir, `${index}.png`), Buffer.from(data.screenshot, 'base64'));
    }

    pages.push({
      url,
      title: data.title || null,
      htmlFile,
      screenshotFile,
      textPreview: text.slice(0, 400),
      // Real, already-absolute image URLs (see FUNCTION_CODE's img.src
      // resolution above) — pass these straight to download_file to get the
      // site's ACTUAL images into the sandbox; referencing the cleaned
      // HTML's own <img src> only points back at the original site, it
      // doesn't copy anything.
      images: data.images || [],
    });

    for (const link of data.links || []) {
      try {
        const linkUrl = new URL(link);
        linkUrl.hash = '';
        const normalized = linkUrl.toString();
        if (linkUrl.origin === startOrigin && !visited.has(normalized) && !queue.includes(normalized)) {
          queue.push(normalized);
        }
      } catch { /* malformed link — skip */ }
    }
  }

  return { startUrl, pagesFound: pages.length, pages };
}

module.exports = { inspectWebsite, fetchPage, extractText };
