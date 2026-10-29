const { execFile } = require('child_process');

/** Promisified execFile — never a shell (this container is always Linux, so unlike ogtrack-backend's own tools.js there's no Windows carve-out needed at all here). */
function run(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 10 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      if (error) {
        const e = new Error(stderr?.toString().trim() || error.message);
        e.exitCode = error.code ?? 1;
        return reject(e);
      }
      resolve({ stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
    });
  });
}

/** Strips a GitHub token out of any error message before it reaches a log line or an HTTP response — same discipline devFix.js's own catch block already applies on the Azure side. */
function scrubToken(message, token) {
  if (!token || !message) return message;
  return message.split(token).join('***');
}

module.exports = { run, scrubToken };
