const express = require('express');
const fs = require('fs');
const { execFile } = require('child_process');
const { loadSandbox } = require('../loadSandbox');

const router = express.Router();

const MAX_OUTPUT_CHARS = 20_000; // same as ogtrack-backend's tools.js

/** The env runCommand executes in — PATH/HOME only, never any real secret. The sandbox's own .env (written at clone time) is what satisfies config.js's required() checks when `npm test` loads the app's own .env from disk, same as the local-backend path. */
function sandboxEnv() {
  return { PATH: process.env.PATH, HOME: process.env.HOME };
}

router.post('/sandbox/:id/run-command', loadSandbox, (req, res) => {
  const { command, args, timeoutMs } = req.body || {};
  if (typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({ error: 'command is required.' });
  }
  if (!Array.isArray(args)) {
    return res.json({ exitCode: 1, timedOut: false, stdout: '', stderr: `Invalid args: expected an array of strings, got ${typeof args}.` });
  }
  // Never shell:true — this container is always Linux, so unlike
  // ogtrack-backend's tools.js (which needs it for npm.cmd on Windows dev
  // machines), this is strictly execFile with a discrete args array, no
  // shell-metacharacter injection surface at all.
  execFile(command, args, {
    cwd: fs.realpathSync(req.sandbox.dir),
    timeout: timeoutMs || 120_000,
    maxBuffer: 10 * 1024 * 1024,
    env: sandboxEnv(),
  }, (error, stdout, stderr) => {
    res.json({
      exitCode: error ? (error.code ?? 1) : 0,
      timedOut: !!error?.killed && error?.signal === 'SIGTERM',
      stdout: String(stdout || '').slice(0, MAX_OUTPUT_CHARS),
      stderr: String(stderr || '').slice(0, MAX_OUTPUT_CHARS),
    });
  });
});

module.exports = router;
