const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  openPullRequest, getCombinedStatus, mergePullRequest, closePullRequest,
  GitHubApiError,
} = require('../src/aida/codingAgent/github');

function mockFetch(handler) {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => handler(url, opts);
  return () => { global.fetch = originalFetch; };
}

test('openPullRequest posts the correct endpoint, method, auth header, and body', async () => {
  let captured = null;
  const restore = mockFetch(async (url, opts) => {
    captured = { url, opts };
    return { ok: true, json: async () => ({ number: 42, html_url: 'https://github.com/acme/widgets/pull/42' }) };
  });
  try {
    const result = await openPullRequest({
      owner: 'acme', repo: 'widgets', token: 'ghp_secret123',
      head: 'aida/fix-1', base: 'main', title: 'Fix: something', body: 'Details here',
    });
    assert.equal(captured.url, 'https://api.github.com/repos/acme/widgets/pulls');
    assert.equal(captured.opts.method, 'POST');
    assert.equal(captured.opts.headers.Authorization, 'Bearer ghp_secret123');
    const body = JSON.parse(captured.opts.body);
    assert.deepEqual(body, { title: 'Fix: something', head: 'aida/fix-1', base: 'main', body: 'Details here' });
    assert.equal(result.number, 42);
    assert.equal(result.html_url, 'https://github.com/acme/widgets/pull/42');
  } finally {
    restore();
  }
});

test('openPullRequest defaults base to "main" when omitted', async () => {
  let captured = null;
  const restore = mockFetch(async (url, opts) => { captured = opts; return { ok: true, json: async () => ({}) }; });
  try {
    await openPullRequest({ owner: 'a', repo: 'b', token: 't', head: 'aida/x', title: 'T', body: 'B' });
    assert.equal(JSON.parse(captured.body).base, 'main');
  } finally {
    restore();
  }
});

test('a non-ok GitHub response throws GitHubApiError with the API message included', async () => {
  const restore = mockFetch(async () => ({ ok: false, status: 422, json: async () => ({ message: 'Validation Failed' }) }));
  try {
    await assert.rejects(
      openPullRequest({ owner: 'a', repo: 'b', token: 't', head: 'x', title: 'T', body: 'B' }),
      (err) => {
        assert.ok(err instanceof GitHubApiError);
        assert.match(err.message, /422/);
        assert.match(err.message, /Validation Failed/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('getCombinedStatus calls the correct read-only status endpoint', async () => {
  let captured = null;
  const restore = mockFetch(async (url, opts) => { captured = { url, opts }; return { ok: true, json: async () => ({ state: 'success' }) }; });
  try {
    const result = await getCombinedStatus({ owner: 'acme', repo: 'widgets', token: 't', ref: 'aida/fix-1' });
    assert.equal(captured.url, 'https://api.github.com/repos/acme/widgets/commits/aida/fix-1/status');
    assert.equal(captured.opts.method, 'GET');
    assert.equal(result.state, 'success');
  } finally {
    restore();
  }
});

test('mergePullRequest uses PUT and squash merge method — never called except from an explicit approve action', async () => {
  let captured = null;
  const restore = mockFetch(async (url, opts) => { captured = { url, opts }; return { ok: true, json: async () => ({ merged: true }) }; });
  try {
    await mergePullRequest({ owner: 'acme', repo: 'widgets', token: 't', pullNumber: 42 });
    assert.equal(captured.url, 'https://api.github.com/repos/acme/widgets/pulls/42/merge');
    assert.equal(captured.opts.method, 'PUT');
    assert.equal(JSON.parse(captured.opts.body).merge_method, 'squash');
  } finally {
    restore();
  }
});

test('closePullRequest sets state to closed without merging', async () => {
  let captured = null;
  const restore = mockFetch(async (url, opts) => { captured = { url, opts }; return { ok: true, json: async () => ({ state: 'closed' }) }; });
  try {
    await closePullRequest({ owner: 'acme', repo: 'widgets', token: 't', pullNumber: 42 });
    assert.equal(captured.url, 'https://api.github.com/repos/acme/widgets/pulls/42');
    assert.equal(captured.opts.method, 'PATCH');
    assert.deepEqual(JSON.parse(captured.opts.body), { state: 'closed' });
  } finally {
    restore();
  }
});
