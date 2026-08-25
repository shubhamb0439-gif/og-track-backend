const path = require('path');
const { listFiles } = require('./tools');

/**
 * Write-path restrictions for the phase-2 "create a whole module" agent —
 * separate from moduleBuilder.js (the agent loop) so the enforcement logic
 * can be unit-tested on its own without spinning up a real sandbox/LLM call.
 *
 * Phase 1's agent (devFix.js) only ever fixed bugs in an existing,
 * already-human-reviewed codebase — worst case, a bad PR. This agent creates
 * whole new surface area across TWO repos from a single chat instruction, so
 * the blast radius needs a hard boundary enforced in code, not just a prompt
 * instruction an LLM could ignore under pressure. The rule, in one sentence:
 * the agent may only CREATE new files; it may never modify a file that
 * existed before the task started, with one narrow, explicitly-named
 * exception per repo (an "insert-only" registration file, checked below) —
 * everything else stays exactly as strict as "new files only."
 */

/** Snapshot of every file that already existed right after clone, before the agent runs — anything not in here is a new file the agent is free to create. */
function snapshotExistingFiles(sandboxDir) {
  return new Set(listFiles(sandboxDir, '.', { recursive: true }).filter((p) => !p.endsWith('/')));
}

function normalizeRelPath(relPath) {
  return String(relPath || '').split(path.sep).join('/').replace(/^\.\//, '');
}

// A destructive-migration guard for the one kind of new file that isn't just
// "new code" — a SQL schema file. Additive-only (CREATE TABLE / ADD COLUMN)
// is the whole point of ogtrack-sql-schema's re-run-safe design (see
// src/utils/provisioning.js's isAlreadyExistsError) — a module's own script
// should never need to drop or alter something another module already owns.
const DESTRUCTIVE_SQL_PATTERN = /\b(DROP\s+(TABLE|COLUMN|DATABASE|INDEX)|TRUNCATE\s+TABLE|ALTER\s+TABLE\s+\S+\s+DROP)\b/i;

/**
 * Throws if `relPath`/`content` isn't an allowed write for the module-builder
 * agent. Called from moduleBuilder.js's executeTool on every write_file call,
 * for both the backend and frontend sandboxes.
 *
 * - insertOnlyFiles: repo-specific list of existing files the agent MAY edit,
 *   but only by adding lines — never changing or removing one (e.g.
 *   src/server.js's route-mounting block, src/utils/provisioning.js's
 *   MODULE_TO_SCRIPT map). Passed in per-repo from config, since the backend
 *   has known registration points and the frontend's are unconfirmed.
 */
function assertModuleWriteAllowed({ relPath, content, existingFiles, insertOnlyFiles = [], previousContent }) {
  const normalized = normalizeRelPath(relPath);

  if (existingFiles.has(normalized)) {
    if (!insertOnlyFiles.includes(normalized)) {
      throw new Error(
        `Refused: "${normalized}" already existed before this task started. The module-builder ` +
        `agent may only CREATE new files, never modify existing ones (the one exception is the ` +
        `small set of registration files listed as insert-only, and even those may only be added ` +
        `to, never changed). If this module genuinely needs some other existing file changed, say ` +
        `so in your finish summary so a human can make that specific change.`
      );
    }
    assertInsertOnlyEdit(previousContent ?? '', content ?? '', normalized);
  }

  if (/\.sql$/i.test(normalized) && content && DESTRUCTIVE_SQL_PATTERN.test(content)) {
    throw new Error(
      `Refused: "${normalized}" contains a destructive statement (DROP/TRUNCATE/ALTER...DROP). ` +
      `Module schema files must be additive-only (CREATE TABLE, ADD COLUMN, CREATE INDEX) — see ` +
      `ogtrack-sql-schema/tenant/ for the existing style to follow.`
    );
  }
}

/** Every non-empty line that existed before must still be present verbatim somewhere in the new content — the write may only ADD lines. */
function assertInsertOnlyEdit(oldContent, newContent, relPath) {
  const oldLines = oldContent.split('\n').map((l) => l.trim()).filter(Boolean);
  const newLineSet = new Set(newContent.split('\n').map((l) => l.trim()));
  const missing = oldLines.filter((l) => !newLineSet.has(l));
  if (missing.length) {
    throw new Error(
      `Refused: this edit to "${relPath}" would remove or change ${missing.length} existing line(s) ` +
      `— this file may only be edited by ADDING new lines (e.g. one new map entry, one new require, ` +
      `one new app.use(...) line), never modifying or removing what's already there. First affected ` +
      `line: "${missing[0]}"`
    );
  }
}

module.exports = { snapshotExistingFiles, assertModuleWriteAllowed, assertInsertOnlyEdit, normalizeRelPath };
