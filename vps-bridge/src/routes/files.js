const express = require('express');
const fs = require('fs');
const path = require('path');
const { loadSandbox } = require('../loadSandbox');
const { resolveSafe } = require('../sandboxPath');

const router = express.Router();

// Same caps as ogtrack-backend's tools.js, so VPS-backed behavior matches
// local-backed behavior exactly from the agent's point of view.
const MAX_READ_BYTES = 200_000;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20_000;

router.post('/sandbox/:id/read-file', loadSandbox, (req, res) => {
  try {
    const abs = resolveSafe(req.sandbox.dir, req.body?.relPath);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return res.status(400).json({ error: `"${req.body.relPath}" is a directory, not a file.` });
    if (stat.size > MAX_READ_BYTES) {
      return res.status(400).json({ error: `"${req.body.relPath}" is ${stat.size} bytes — too large to read in full (limit ${MAX_READ_BYTES}).` });
    }
    res.json({ content: fs.readFileSync(abs, 'utf8') });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/sandbox/:id/write-file', loadSandbox, (req, res) => {
  try {
    const { relPath, content } = req.body || {};
    const abs = resolveSafe(req.sandbox.dir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content ?? '', 'utf8');
    res.json({ bytesWritten: Buffer.byteLength(content ?? '', 'utf8') });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/sandbox/:id/download-file', loadSandbox, async (req, res) => {
  const { relPath, url } = req.body || {};
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: `"${url}" is not a valid absolute URL.` });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: `Only http/https URLs can be downloaded, got "${parsed.protocol}".` });
  }
  let abs;
  try {
    abs = resolveSafe(req.sandbox.dir, relPath);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const fetchRes = await fetch(url, { signal: controller.signal });
    if (!fetchRes.ok) return res.status(502).json({ error: `Download failed: ${fetchRes.status} ${fetchRes.statusText}` });
    const buf = Buffer.from(await fetchRes.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD_BYTES) {
      return res.status(400).json({ error: `"${url}" is ${buf.length} bytes — too large to download (limit ${MAX_DOWNLOAD_BYTES}).` });
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    res.json({ bytesWritten: buf.length });
  } catch (e) {
    res.status(502).json({ error: e.message });
  } finally {
    clearTimeout(timer);
  }
});

router.post('/sandbox/:id/list-files', loadSandbox, (req, res) => {
  try {
    const { relDir, recursive } = req.body || {};
    const resolvedRoot = fs.realpathSync(req.sandbox.dir);
    const abs = resolveSafe(req.sandbox.dir, relDir || '.');
    const entries = [];
    function walk(dir, depth) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(resolvedRoot, full).split(path.sep).join('/');
        entries.push(entry.isDirectory() ? `${rel}/` : rel);
        if (recursive && entry.isDirectory() && depth < 6) walk(full, depth + 1);
      }
    }
    walk(abs, 0);
    res.json({ files: entries });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
