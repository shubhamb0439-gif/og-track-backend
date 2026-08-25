const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readFile, writeFile, listFiles, resolveSafe, SandboxPathError } = require('../src/aida/codingAgent/tools');

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aida-sandbox-test-'));
  return dir;
}

test('readFile/writeFile round-trip inside the sandbox', () => {
  const sandbox = makeSandbox();
  writeFile(sandbox, 'src/foo.js', 'module.exports = 1;\n');
  assert.equal(readFile(sandbox, 'src/foo.js'), 'module.exports = 1;\n');
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('writeFile creates intermediate directories', () => {
  const sandbox = makeSandbox();
  writeFile(sandbox, 'a/b/c/deep.js', 'x');
  assert.equal(fs.existsSync(path.join(sandbox, 'a/b/c/deep.js')), true);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('listFiles skips node_modules and .git, supports recursion', () => {
  const sandbox = makeSandbox();
  writeFile(sandbox, 'index.js', 'x');
  writeFile(sandbox, 'lib/util.js', 'x');
  writeFile(sandbox, 'node_modules/pkg/index.js', 'x');
  fs.mkdirSync(path.join(sandbox, '.git'));
  const flat = listFiles(sandbox, '.');
  assert.ok(flat.includes('index.js'));
  assert.ok(!flat.some((f) => f.includes('node_modules')));
  assert.ok(!flat.some((f) => f.includes('.git')));
  const deep = listFiles(sandbox, '.', { recursive: true });
  assert.ok(deep.includes('lib/util.js'));
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// The critical safety property: nothing this agent does can ever touch a
// file outside its one sandbox directory, no matter what path a model
// (possibly manipulated, possibly just buggy) tries to hand it.
test('resolveSafe blocks ../ path traversal out of the sandbox', () => {
  const sandbox = makeSandbox();
  assert.throws(() => resolveSafe(sandbox, '../../../etc/passwd'), SandboxPathError);
  assert.throws(() => resolveSafe(sandbox, '../outside.txt'), SandboxPathError);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('resolveSafe blocks an absolute path escaping the sandbox', () => {
  const sandbox = makeSandbox();
  const outsideAbs = os.platform() === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/passwd';
  assert.throws(() => resolveSafe(sandbox, outsideAbs), SandboxPathError);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('resolveSafe blocks a symlink planted inside the sandbox that points outside it', (t) => {
  const sandbox = makeSandbox();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aida-outside-'));
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'do not read me');
  const linkPath = path.join(sandbox, 'escape-link');
  try {
    fs.symlinkSync(outsideDir, linkPath, 'dir');
  } catch (e) {
    // Symlink creation can require elevated privileges on Windows in some
    // configurations — skip rather than fail the suite over an environment
    // limitation unrelated to the code under test.
    t.skip(`symlink creation not permitted in this environment: ${e.message}`);
    fs.rmSync(sandbox, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
    return;
  }
  assert.throws(() => resolveSafe(sandbox, 'escape-link/secret.txt'), SandboxPathError);
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

test('reading a directory as a file throws a clear error', () => {
  const sandbox = makeSandbox();
  fs.mkdirSync(path.join(sandbox, 'somedir'));
  assert.throws(() => readFile(sandbox, 'somedir'), /directory/i);
  fs.rmSync(sandbox, { recursive: true, force: true });
});
