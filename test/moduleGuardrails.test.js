const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeFile } = require('../src/aida/codingAgent/tools');
const { snapshotExistingFiles, assertModuleWriteAllowed, assertInsertOnlyEdit } = require('../src/aida/codingAgent/moduleGuardrails');

function makeSandboxWithExistingFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aida-module-guardrail-test-'));
  writeFile(dir, 'src/server.js', "const a = require('a');\napp.use('/a', a);\n");
  writeFile(dir, 'src/routes/existing.js', 'module.exports = {};\n');
  return dir;
}

test('write to a brand-new file is allowed', () => {
  const dir = makeSandboxWithExistingFiles();
  const existingFiles = snapshotExistingFiles(dir);
  assert.doesNotThrow(() => assertModuleWriteAllowed({
    relPath: 'src/routes/attendance.js', content: 'module.exports = {};\n', existingFiles, insertOnlyFiles: [],
  }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('write to a pre-existing file NOT on the insert-only list is refused', () => {
  const dir = makeSandboxWithExistingFiles();
  const existingFiles = snapshotExistingFiles(dir);
  assert.throws(() => assertModuleWriteAllowed({
    relPath: 'src/routes/existing.js', content: 'module.exports = { changed: true };\n', existingFiles, insertOnlyFiles: [],
  }), /already existed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('insert-only file: adding a line is allowed', () => {
  const dir = makeSandboxWithExistingFiles();
  const existingFiles = snapshotExistingFiles(dir);
  const original = "const a = require('a');\napp.use('/a', a);\n";
  assert.doesNotThrow(() => assertModuleWriteAllowed({
    relPath: 'src/server.js',
    content: original + "const attendance = require('./routes/attendance');\napp.use('/attendance', attendance);\n",
    existingFiles, insertOnlyFiles: ['src/server.js'], previousContent: original,
  }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('insert-only file: removing or changing an existing line is refused', () => {
  const dir = makeSandboxWithExistingFiles();
  const existingFiles = snapshotExistingFiles(dir);
  const original = "const a = require('a');\napp.use('/a', a);\n";
  assert.throws(() => assertModuleWriteAllowed({
    relPath: 'src/server.js',
    content: "const a = require('a');\n", // dropped the app.use line
    existingFiles, insertOnlyFiles: ['src/server.js'], previousContent: original,
  }), /would remove or change/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('insert-only file: reordering lines still counts as preserved (line-set check, not line-order)', () => {
  const original = 'line1\nline2\n';
  assert.doesNotThrow(() => assertInsertOnlyEdit(original, 'line2\nline1\nline3\n', 'src/server.js'));
});

test('destructive SQL in a new .sql file is refused', () => {
  const dir = makeSandboxWithExistingFiles();
  const existingFiles = snapshotExistingFiles(dir);
  assert.throws(() => assertModuleWriteAllowed({
    relPath: 'ogtrack-sql-schema/tenant/13_module_attendance.sql',
    content: 'DROP TABLE dbo.users;\n',
    existingFiles, insertOnlyFiles: [],
  }), /destructive/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('additive SQL in a new .sql file is allowed', () => {
  const dir = makeSandboxWithExistingFiles();
  const existingFiles = snapshotExistingFiles(dir);
  assert.doesNotThrow(() => assertModuleWriteAllowed({
    relPath: 'ogtrack-sql-schema/tenant/13_module_attendance.sql',
    content: 'CREATE TABLE dbo.attendance_v2 (id INT PRIMARY KEY);\n',
    existingFiles, insertOnlyFiles: [],
  }));
  fs.rmSync(dir, { recursive: true, force: true });
});
