const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

/**
 * Sandbox lifecycle for the coding agent — a disposable git clone the agent
 * is allowed to read/write/run commands in, torn down when done. Critically,
 * this NEVER carries real secrets: the sandbox gets its own throwaway .env
 * with dummy values, just enough for `require('../../config')` to not throw
 * at load time, so `npm test` can run without ever touching a real Azure SQL
 * server, the real JWT secret, or anything else production-shaped. This is
 * what "no access to production credentials" actually means in code, not
 * just a stated intention.
 */

function execFileP(command, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(command, args, opts, (error, stdout, stderr) => {
      if (error) {
        const err = new Error(`${command} ${args.join(' ')} failed: ${error.message}\n${stderr || ''}`.trim());
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

// Dummy values — deliberately obviously-fake, never derived from any real
// secret, just enough to satisfy config.js's required() checks so the
// module graph loads. A job running in the sandbox has no legitimate reason
// to ever reach a real database anyway (it's editing/testing source code,
// not exercising live data paths).
const DUMMY_ENV = [
  'AZURE_SQL_SERVER=sandbox-not-real.database.windows.net',
  'AZURE_SQL_USER=sandbox',
  'AZURE_SQL_PASSWORD=sandbox-dummy-password-not-real',
  'JWT_SECRET=sandbox-dummy-jwt-secret-not-real',
  'PORT=39999',
].join('\n') + '\n';

/**
 * Clones `sourceRepoPath` (a local path OR a git URL) into a fresh temp
 * directory and writes the dummy .env. Returns { dir, cleanup() }.
 */
async function createSandbox(sourceRepoPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aida-coding-agent-'));
  await execFileP('git', ['clone', '--depth', '1', sourceRepoPath, dir], { timeout: 120_000 });
  fs.writeFileSync(path.join(dir, '.env'), DUMMY_ENV, 'utf8');
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

module.exports = { createSandbox, DUMMY_ENV };
