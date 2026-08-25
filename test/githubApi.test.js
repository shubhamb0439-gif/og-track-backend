const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { materializeSandbox, commitChanges, updateBranchRef } = require('../src/aida/codingAgent/githubApi');

function mockFetch(handler) {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => handler(url, opts);
  return () => { global.fetch = originalFetch; };
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'githubapi-test-'));
}

// Minimal fake repo: one file at the root, one nested one level deep.
const FAKE_REF_SHA = 'commit123';
const FAKE_TREE_SHA = 'tree123';
const FAKE_FILES = {
  'index.js': { sha: 'blobA', content: Buffer.from("console.log('hi');\n").toString('base64') },
  'src/util.js': { sha: 'blobB', content: Buffer.from('module.exports = {};\n').toString('base64') },
};

function fakeRepoHandler(url, opts) {
  if (url.endsWith('/git/refs/heads/main')) {
    return { ok: true, json: async () => ({ object: { sha: FAKE_REF_SHA } }) };
  }
  if (url.endsWith(`/git/commits/${FAKE_REF_SHA}`)) {
    return { ok: true, json: async () => ({ tree: { sha: FAKE_TREE_SHA } }) };
  }
  if (url.includes(`/git/trees/${FAKE_TREE_SHA}`)) {
    return {
      ok: true,
      json: async () => ({
        truncated: false,
        tree: [
          { path: 'index.js', type: 'blob', sha: FAKE_FILES['index.js'].sha },
          { path: 'src', type: 'tree', sha: 'treeSrc' },
          { path: 'src/util.js', type: 'blob', sha: FAKE_FILES['src/util.js'].sha },
          { path: 'node_modules', type: 'tree', sha: 'treeNM' },
          { path: 'node_modules/pkg/index.js', type: 'blob', sha: 'blobShouldSkip' },
        ],
      }),
    };
  }
  const blobMatch = /\/git\/blobs\/(\w+)$/.exec(url);
  if (blobMatch && opts.method !== 'POST') {
    const entry = Object.values(FAKE_FILES).find((f) => f.sha === blobMatch[1]);
    if (entry) return { ok: true, json: async () => ({ content: entry.content, encoding: 'base64' }) };
  }
  throw new Error('unexpected request in fakeRepoHandler: ' + url);
}

test('materializeSandbox writes every non-skipped file to disk and returns a matching snapshot', async () => {
  const dir = makeTmpDir();
  const restore = mockFetch(fakeRepoHandler);
  try {
    const { baseCommitSha, baseTreeSha, originalFiles } = await materializeSandbox({
      owner: 'acme', repo: 'widgets', token: 't', ref: 'main', destDir: dir,
    });
    assert.equal(baseCommitSha, FAKE_REF_SHA);
    assert.equal(baseTreeSha, FAKE_TREE_SHA);
    assert.equal(fs.readFileSync(path.join(dir, 'index.js'), 'utf8'), "console.log('hi');\n");
    assert.equal(fs.readFileSync(path.join(dir, 'src', 'util.js'), 'utf8'), 'module.exports = {};\n');
    assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false, 'node_modules must never be materialized');
    assert.equal(originalFiles.size, 2);
    assert.ok(originalFiles.has('index.js'));
    assert.ok(originalFiles.has('src/util.js'));
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('commitChanges reports nothing to commit when the sandbox is untouched', async () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'index.js'), "console.log('hi');\n");
  const originalFiles = new Map([['index.js', Buffer.from("console.log('hi');\n")]]);
  const restore = mockFetch(() => { throw new Error('should not call the API when nothing changed'); });
  try {
    const result = await commitChanges({
      owner: 'acme', repo: 'widgets', token: 't', dir, originalFiles,
      baseCommitSha: FAKE_REF_SHA, baseTreeSha: FAKE_TREE_SHA, message: 'no-op',
    });
    assert.equal(result.committed, false);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('commitChanges creates a blob only for the changed/new file, builds a tree on base_tree, and commits with the right parent', async () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'index.js'), "console.log('hi');\n"); // unchanged
  fs.writeFileSync(path.join(dir, 'new-file.js'), "module.exports = 'new';\n"); // new
  const originalFiles = new Map([['index.js', Buffer.from("console.log('hi');\n")]]);

  const calls = [];
  const restore = mockFetch(async (url, opts) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
    if (url.endsWith('/git/blobs')) return { ok: true, json: async () => ({ sha: 'newBlobSha' }) };
    if (url.endsWith('/git/trees')) return { ok: true, json: async () => ({ sha: 'newTreeSha' }) };
    if (url.endsWith('/git/commits')) return { ok: true, json: async () => ({ sha: 'newCommitSha' }) };
    throw new Error('unexpected call: ' + url);
  });
  try {
    const result = await commitChanges({
      owner: 'acme', repo: 'widgets', token: 't', dir, originalFiles,
      baseCommitSha: FAKE_REF_SHA, baseTreeSha: FAKE_TREE_SHA, message: 'add new-file.js',
    });
    assert.equal(result.committed, true);
    assert.equal(result.commitSha, 'newCommitSha');

    const blobCalls = calls.filter((c) => c.url.endsWith('/git/blobs'));
    assert.equal(blobCalls.length, 1, 'only the changed/new file should get a blob — the unchanged file must be skipped');
    assert.equal(Buffer.from(blobCalls[0].body.content, 'base64').toString('utf8'), "module.exports = 'new';\n");

    const treeCall = calls.find((c) => c.url.endsWith('/git/trees'));
    assert.equal(treeCall.body.base_tree, FAKE_TREE_SHA);
    assert.deepEqual(treeCall.body.tree, [{ path: 'new-file.js', mode: '100644', type: 'blob', sha: 'newBlobSha' }]);

    const commitCall = calls.find((c) => c.url.endsWith('/git/commits'));
    assert.deepEqual(commitCall.body.parents, [FAKE_REF_SHA]);
    assert.equal(commitCall.body.tree, 'newTreeSha');
    assert.equal(commitCall.body.message, 'add new-file.js');
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('commitChanges represents a deleted file as a tree entry with sha:null', async () => {
  const dir = makeTmpDir();
  // originalFiles has a file that no longer exists on disk — simulates a deletion.
  const originalFiles = new Map([['gone.js', Buffer.from('was here')]]);
  const calls = [];
  const restore = mockFetch(async (url, opts) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
    if (url.endsWith('/git/trees')) return { ok: true, json: async () => ({ sha: 'newTreeSha' }) };
    if (url.endsWith('/git/commits')) return { ok: true, json: async () => ({ sha: 'newCommitSha' }) };
    throw new Error('unexpected call: ' + url);
  });
  try {
    const result = await commitChanges({
      owner: 'acme', repo: 'widgets', token: 't', dir, originalFiles,
      baseCommitSha: FAKE_REF_SHA, baseTreeSha: FAKE_TREE_SHA, message: 'delete gone.js',
    });
    assert.equal(result.committed, true);
    const treeCall = calls.find((c) => c.url.endsWith('/git/trees'));
    assert.deepEqual(treeCall.body.tree, [{ path: 'gone.js', mode: '100644', type: 'blob', sha: null }]);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updateBranchRef creates a new ref when it does not exist yet', async () => {
  let captured = null;
  const restore = mockFetch(async (url, opts) => {
    captured = { url, method: opts.method, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({}) };
  });
  try {
    await updateBranchRef({ owner: 'acme', repo: 'widgets', token: 't', branch: 'aida/fix-1', commitSha: 'abc123' });
    assert.equal(captured.url, 'https://api.github.com/repos/acme/widgets/git/refs');
    assert.equal(captured.method, 'POST');
    assert.deepEqual(captured.body, { ref: 'refs/heads/aida/fix-1', sha: 'abc123' });
  } finally {
    restore();
  }
});

test('updateBranchRef falls back to a force-update PATCH when the ref already exists', async () => {
  const calls = [];
  const restore = mockFetch(async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    if (opts.method === 'POST') return { ok: false, status: 422, json: async () => ({ message: 'Reference already exists' }) };
    return { ok: true, json: async () => ({}) };
  });
  try {
    await updateBranchRef({ owner: 'acme', repo: 'widgets', token: 't', branch: 'aida/fix-1', commitSha: 'def456' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, 'https://api.github.com/repos/acme/widgets/git/refs/heads/aida/fix-1');
    assert.equal(calls[1].method, 'PATCH');
    assert.deepEqual(calls[1].body, { sha: 'def456', force: true });
  } finally {
    restore();
  }
});
