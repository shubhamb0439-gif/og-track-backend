const express = require('express');
const { loadSandbox } = require('../loadSandbox');
const { run, scrubToken } = require('../gitExec');

const router = express.Router();

/** Parses `git diff --name-status` output (e.g. "M\tsrc/file.js") into a plain array of changed relative paths. */
function parseChangedPaths(nameStatusOutput) {
  return nameStatusOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('\t').pop());
}

/**
 * Real `git commit` on this VPS, replacing ogtrack-backend's GitHub-Data-API
 * commitChanges — simpler and faster, no tree-size truncation limit. Short-
 * circuits via `git status --porcelain` for the "nothing to commit" case,
 * matching commitChanges' own { committed: false } shape.
 */
router.post('/sandbox/:id/commit', loadSandbox, async (req, res) => {
  const { dir, token } = req.sandbox;
  const { message } = req.body || {};
  try {
    const { stdout: status } = await run('git', ['status', '--porcelain'], { cwd: dir });
    if (!status.trim()) {
      return res.json({ committed: false, reason: 'Nothing to commit — the agent made no file changes.' });
    }
    await run('git', ['add', '-A'], { cwd: dir });
    await run('git', ['commit', '-m', message || 'AIDA: automated change'], { cwd: dir });
    const { stdout: sha } = await run('git', ['rev-parse', 'HEAD'], { cwd: dir });
    const { stdout: diff } = await run('git', ['diff', '--name-status', 'HEAD~1', 'HEAD'], { cwd: dir });
    res.json({ committed: true, commitSha: sha.trim(), changedPaths: parseChangedPaths(diff) });
  } catch (e) {
    res.status(502).json({ error: `git commit failed: ${scrubToken(e.message, token)}` });
  }
});

/** Real `git push` — the remote URL already carries the token embedded at clone time, so nothing new is needed here. */
router.post('/sandbox/:id/push', loadSandbox, async (req, res) => {
  const { dir, token } = req.sandbox;
  const { branch } = req.body || {};
  if (!branch) return res.status(400).json({ error: 'branch is required.' });
  try {
    await run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: dir });
    res.json({ pushed: true });
  } catch (e) {
    res.status(502).json({ error: `git push failed: ${scrubToken(e.message, token)}` });
  }
});

module.exports = router;
