const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const router = express.Router();

const SANDBOX_ROOT = process.env.SANDBOX_ROOT || '/sandboxes';
const TIMEOUT_MS = Number(process.env.CODING_AGENT_TIMEOUT_MS) || 1_200_000;
// Pinned deliberately — live-tested manually without this flag and the CLI
// defaulted to Opus 5.5 (the most expensive/slowest model), not the Sonnet
// every other AIDA coding-agent call already uses. Never left to the CLI's
// own default.
const MODEL = process.env.CODING_AGENT_MODEL || 'claude-sonnet-5-5';
const MAX_OUTPUT_CHARS = 20_000; // same cap ogtrack-backend's tools.js uses for tool-result text

/**
 * The env the `claude` CLI process runs in. PATH/HOME are required for the
 * binary and its own config dir (~/.claude) to resolve at all; ANTHROPIC_API_KEY
 * is passed through ONLY when actually set on this container — when it's
 * absent, the CLI falls back to whatever login session is present under
 * HOME/.claude (the subscription-auth path, set up via `docker run -it`
 * once, persisted through the same mounted volume this container uses).
 */
function claudeEnv() {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  return env;
}

/**
 * Claude Code's own startup/config warnings (e.g. a missing/backed-up
 * .claude.json) print to stdout ahead of the real result, so the actual
 * `--output-format json` object isn't necessarily the only thing on stdout.
 * Scans from the LAST line backwards for the first one that's valid JSON —
 * robust against that noise without needing to know its exact wording.
 */
function parseClaudeOutput(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep scanning backwards — a warning line can itself start with "{"
      // in rare cases (e.g. echoing part of a stack trace); not a match.
    }
  }
  return null;
}

router.post('/run', (req, res) => {
  const { sandboxId, task } = req.body || {};
  if (!sandboxId || typeof sandboxId !== 'string') {
    return res.status(400).json({ error: 'sandboxId is required.' });
  }
  if (!task || typeof task !== 'string' || !task.trim()) {
    return res.status(400).json({ error: 'task is required.' });
  }

  const dir = path.join(SANDBOX_ROOT, sandboxId);
  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: `No sandbox directory for id "${sandboxId}" under ${SANDBOX_ROOT}.` });
  }

  // Never shell:true — same discipline vps-bridge's own exec route follows.
  // `task` is passed as a single discrete argv element, so its own content
  // (quotes, newlines, anything) needs no escaping and carries no
  // shell-injection surface.
  execFile('claude', [
    '-p', task,
    '--output-format', 'json',
    '--model', MODEL,
  ], {
    cwd: fs.realpathSync(dir),
    timeout: TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024,
    env: claudeEnv(),
  }, (error, stdout, stderr) => {
    const timedOut = !!error?.killed && error?.signal === 'SIGTERM';
    const parsed = parseClaudeOutput(String(stdout || ''));

    if (!parsed) {
      // The CLI crashed, hung past TIMEOUT_MS, or produced output this
      // parser couldn't recognize — a real outcome, not a bug to crash on.
      // Reported as a normal task failure (200, success:false), matching
      // tools.js's own "never reject, always return a tool-shaped error"
      // precedent, so devFix.js marks the job 'failed' with a clear message
      // instead of the whole request erroring opaquely.
      return res.json({
        success: false,
        summary: timedOut
          ? `The VPS coding agent did not finish within ${Math.round(TIMEOUT_MS / 1000)}s and was stopped.`
          : `The VPS coding agent produced no parseable result.\n\nstderr:\n${String(stderr || '').slice(0, MAX_OUTPUT_CHARS)}`,
        toolLog: [{ type: 'vps_claude_code_cli', error: true, timedOut, model: MODEL }],
      });
    }

    const isError = !!parsed.is_error;
    const success = !isError && parsed.subtype === 'success';
    res.json({
      success,
      summary: parsed.result || (isError ? 'Claude Code CLI reported an error with no further detail.' : '(no summary text returned)'),
      toolLog: [{
        type: 'vps_claude_code_cli',
        model: MODEL,
        numTurns: parsed.num_turns,
        costUsd: parsed.total_cost_usd,
        durationMs: parsed.duration_ms,
        subtype: parsed.subtype,
      }],
    });
  });
});

module.exports = router;
