const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * File/command tools for the coding agent — deliberately separate from
 * src/aida/toolRegistry.js (AIDA's normal chat tools, which only ever read
 * OG Track's own API data). These tools touch a real filesystem and can run
 * real commands, so every one of them is hard-scoped to one sandbox root
 * directory (a disposable clone, never the live working tree) and rejects
 * any path that tries to escape it — the agent calling these tools is
 * trusted to WANT to edit code, not to be trusted with anything outside the
 * one directory it was handed.
 */

class SandboxPathError extends Error {}

/** Resolves `relPath` against `sandboxRoot` and throws if it would escape it (via ../, an absolute path, or a symlink pointing outside it). */
function resolveSafe(sandboxRoot, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new SandboxPathError('A path is required.');
  }
  const resolvedRoot = fs.realpathSync(sandboxRoot);
  const candidate = path.resolve(resolvedRoot, relPath); // lexically collapses any ../ segments
  const withinRoot = candidate === resolvedRoot || candidate.startsWith(resolvedRoot + path.sep);
  if (!withinRoot) {
    throw new SandboxPathError(`Path "${relPath}" resolves outside the sandbox — refused.`);
  }
  // Lexical containment isn't enough on its own if a symlink INSIDE the
  // sandbox points back out of it — resolve symlinks on the nearest
  // existing ancestor (the file itself if it exists, otherwise its parent
  // directory, since a not-yet-created file has nothing to resolve) and
  // re-check containment on that real path too.
  let ancestor = candidate;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return candidate; // reached filesystem root without finding anything real — nothing to resolve
    ancestor = parent;
  }
  const realAncestor = fs.realpathSync(ancestor);
  if (realAncestor !== resolvedRoot && !realAncestor.startsWith(resolvedRoot + path.sep)) {
    throw new SandboxPathError(`Path "${relPath}" resolves outside the sandbox via a symlink — refused.`);
  }
  return candidate;
}

const MAX_READ_BYTES = 200_000; // guards against accidentally reading a huge/binary file into the LLM's context
const MAX_OUTPUT_CHARS = 20_000; // command output truncation, same spirit as toolRegistry.js's MAX_RESULT_CHARS

function readFile(sandboxRoot, relPath) {
  const abs = resolveSafe(sandboxRoot, relPath);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) throw new Error(`"${relPath}" is a directory, not a file.`);
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`"${relPath}" is ${stat.size} bytes — too large to read in full (limit ${MAX_READ_BYTES}). Use listFiles to inspect it in pieces or reconsider whether this file needs editing.`);
  }
  return fs.readFileSync(abs, 'utf8');
}

function writeFile(sandboxRoot, relPath, content) {
  const abs = resolveSafe(sandboxRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return { bytesWritten: Buffer.byteLength(content, 'utf8') };
}

function listFiles(sandboxRoot, relDir, { recursive = false } = {}) {
  // Resolve the root ONCE and use that consistently for every relative-path
  // computation below — mixing the raw sandboxRoot with a realpath-resolved
  // path (as resolveSafe returns) broke this on Windows, where a temp dir's
  // raw path can use an 8.3 short form (e.g. "SHUBHA~1") while realpathSync
  // expands it to the long form; path.relative() between the two produced
  // nonsense since they don't share a literal prefix despite being the same
  // real location.
  const resolvedRoot = fs.realpathSync(sandboxRoot);
  const abs = resolveSafe(sandboxRoot, relDir || '.');
  const entries = [];
  function walk(dir, depth) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue; // never worth the agent's attention, and node_modules can be enormous
      const full = path.join(dir, entry.name);
      // Normalized to forward slashes regardless of host OS — these paths
      // go straight into an LLM prompt and get echoed back as arguments to
      // readFile/writeFile, so they need to be platform-independent, not
      // whatever path.relative's separator happens to be on this machine.
      const rel = path.relative(resolvedRoot, full).split(path.sep).join('/');
      entries.push(entry.isDirectory() ? `${rel}/` : rel);
      if (recursive && entry.isDirectory() && depth < 6) walk(full, depth + 1);
    }
  }
  walk(abs, 0);
  return entries;
}

/**
 * Runs one command with its CWD locked to the sandbox root — used for
 * `npm install`/`npm test`, nothing else needs a shell here. On Linux (the
 * real deployment target — Azure App Service, GitHub Actions' ubuntu-latest)
 * this never uses a shell (execFile, not exec — args passed as a discrete
 * array, no shell-metacharacter injection risk). Windows needs `shell: true`
 * ONLY because `npm` there is a .cmd wrapper execFile can't resolve without
 * one — args are still passed as a separate array that Node quotes for
 * cmd.exe itself, not a raw interpolated string, though Windows cmd.exe
 * quoting has known historical rough edges for a few special characters;
 * acceptable here since this only ever runs inside a disposable sandbox with
 * no real credentials in its environment (see sandboxEnv() below) and args
 * come from a small, expected set (npm install/test/run), not arbitrary
 * user input.
 */
function runCommand(sandboxRoot, command, args = [], { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd: fs.realpathSync(sandboxRoot),
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: sandboxEnv(),
      shell: process.platform === 'win32',
    }, (error, stdout, stderr) => {
      resolve({
        exitCode: error ? (error.code ?? 1) : 0,
        timedOut: !!error?.killed && error?.signal === 'SIGTERM',
        stdout: String(stdout || '').slice(0, MAX_OUTPUT_CHARS),
        stderr: String(stderr || '').slice(0, MAX_OUTPUT_CHARS),
      });
    });
  });
}

/**
 * The environment `runCommand` executes in — deliberately NOT process.env.
 * The sandbox clone gets its own throwaway .env (see createSandbox in
 * index.js) with dummy values for whatever config.js requires to load, so
 * `npm test`/`npm install` can run without ever touching real Azure SQL
 * credentials, the real JWT secret, or any other production secret. PATH is
 * kept (needed to find node/npm) but nothing else from the real process
 * leaks in.
 */
function sandboxEnv() {
  const base = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  if (process.platform === 'win32') {
    // cmd.exe itself (invoked because of runCommand's shell:true on Windows)
    // needs these to start at all — none of them are secrets.
    base.SystemRoot = process.env.SystemRoot;
    base.ComSpec = process.env.ComSpec;
    base.PATHEXT = process.env.PATHEXT;
    base.APPDATA = process.env.APPDATA;
    base.TEMP = process.env.TEMP;
    base.TMP = process.env.TMP;
  }
  return base;
}

module.exports = { readFile, writeFile, listFiles, runCommand, resolveSafe, SandboxPathError, MAX_READ_BYTES };
