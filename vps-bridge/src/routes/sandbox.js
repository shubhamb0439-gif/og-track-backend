const express = require('express');
const fs = require('fs');
const path = require('path');
const sandboxStore = require('../sandboxStore');
const { loadSandbox } = require('../loadSandbox');
const { run, scrubToken } = require('../gitExec');

const router = express.Router();

/**
 * POST /sandbox — real `git clone` on this VPS, replacing ogtrack-backend's
 * GitHub-Data-API materialization (which exists only because Azure App
 * Service has no `git` binary; this VPS does). `--depth 1` keeps the clone
 * small/fast; a single new commit on top still resolves HEAD~1 correctly
 * against the shallow base commit, so /commit's diff below still works.
 */
router.post('/sandbox', async (req, res) => {
  const { owner, repo, token, ref, envFileContents } = req.body || {};
  if (!owner || !repo || !token) {
    return res.status(400).json({ error: 'owner, repo, and token are required.' });
  }
  const { sandboxId, dir } = sandboxStore.create({ owner, repo, token });
  const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

  try {
    await fs.promises.mkdir(path.dirname(dir), { recursive: true });
    await run('git', ['clone', '--branch', ref || 'main', '--single-branch', '--depth', '1', cloneUrl, dir]);
    await run('git', ['config', 'user.name', 'AIDA'], { cwd: dir });
    await run('git', ['config', 'user.email', 'aida@noreply'], { cwd: dir });
    if (envFileContents) {
      await fs.promises.writeFile(path.join(dir, '.env'), envFileContents, 'utf8');
    }
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: dir });
    res.json({ sandboxId, baseCommitSha: stdout.trim() });
  } catch (e) {
    await sandboxStore.remove(sandboxId);
    res.status(502).json({ error: `git clone failed: ${scrubToken(e.message, token)}` });
  }
});

router.delete('/sandbox/:id', loadSandbox, async (req, res) => {
  await sandboxStore.remove(req.params.id);
  res.json({ deleted: true });
});

module.exports = router;
