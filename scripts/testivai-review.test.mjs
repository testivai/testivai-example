// Tests for the CI agent review: Claude reads the TestivAI report through
// @testivai/mcp and the workflow posts its findings as one PR comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const require = createRequire(import.meta.url);
const review = require('./testivai-review.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = (snapshots, missingBaselines = []) => ({
  version: '2.3.0',
  summary: {
    total: snapshots.length,
    passed: snapshots.filter((s) => s.status === 'passed').length,
    changed: snapshots.filter((s) => s.status === 'changed').length,
    newSnapshots: snapshots.filter((s) => s.status === 'new').length,
    missing: missingBaselines.length,
  },
  snapshots,
  missingBaselines,
});

// ── which snapshots need a review ───────────────────────────────────────────

test('nothing to review when every snapshot passed', () => {
  const r = results([{ name: 'home', status: 'passed' }]);
  assert.deepEqual(review.toReview(r), []);
  assert.equal(review.needsReview(r), false);
});

test('changed, new and missing snapshots all need a review', () => {
  const r = results(
    [
      { name: 'home', status: 'changed' },
      { name: 'buttons', status: 'passed' },
      { name: 'products', status: 'new' },
    ],
    ['pricing'],
  );
  assert.deepEqual(review.toReview(r), [
    { name: 'home', status: 'changed' },
    { name: 'products', status: 'new' },
    { name: 'pricing', status: 'missing' },
  ]);
  assert.equal(review.needsReview(r), true);
});

// ── what the agent may do ───────────────────────────────────────────────────

test('the agent can read the report but never approve', () => {
  for (const t of ['mcp__testivai__approve_snapshot', 'mcp__testivai__approve_all']) {
    assert.ok(!review.ALLOWED_TOOLS.includes(t), `${t} must not be allowed`);
    assert.ok(review.DISALLOWED_TOOLS.includes(t), `${t} must be explicitly disallowed`);
  }
  for (const t of ['Bash', 'Edit', 'Write']) assert.ok(review.DISALLOWED_TOOLS.includes(t), `${t} must be disallowed`);
});

test('claude_args carry a parseable MCP config, tool lists and output schema', () => {
  const args = review.claudeArgs();
  const flag = (name) => {
    const m = args.match(new RegExp(`--${name} '([^']*)'`));
    assert.ok(m, `missing --${name}`);
    return m[1];
  };
  assert.deepEqual(JSON.parse(flag('mcp-config')), review.MCP_CONFIG);
  assert.deepEqual(flag('allowedTools').split(','), review.ALLOWED_TOOLS);
  assert.deepEqual(flag('disallowedTools').split(','), review.DISALLOWED_TOOLS);
  assert.deepEqual(JSON.parse(flag('json-schema')), review.REVIEW_SCHEMA);
  assert.match(args, /--max-turns \d+/);
});

test('every allowed TestivAI tool exists on the real MCP server, and the prompt names only real tools', async () => {
  const server = review.MCP_CONFIG.mcpServers.testivai;
  const client = new Client({ name: 'testivai-review-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: server.command, args: server.args, cwd: ROOT, stderr: 'ignore' }));
  try {
    const tools = new Set((await client.listTools()).tools.map((t) => `mcp__testivai__${t.name}`));
    for (const t of review.ALLOWED_TOOLS.filter((x) => x.startsWith('mcp__testivai__'))) {
      assert.ok(tools.has(t), `${t} is not a tool on @testivai/mcp`);
    }
    for (const t of review.DISALLOWED_TOOLS.filter((x) => x.startsWith('mcp__testivai__'))) {
      assert.ok(tools.has(t), `${t} is not a tool on @testivai/mcp (typo would leave the real one enabled)`);
    }
    const prompt = review.buildPrompt({ repo: 'o/r', pr: 1 });
    for (const name of prompt.match(/`([a-z_]+)`/g).map((s) => s.slice(1, -1)).filter((s) => s.includes('_') && !s.startsWith('pr_'))) {
      assert.ok(tools.has(`mcp__testivai__${name}`), `prompt names unknown tool ${name}`);
    }
  } finally {
    await client.close();
  }
});

test('the prompt pins the PR, the files, and the no-approval rule', () => {
  const p = review.buildPrompt({ repo: 'testivai/testivai-example', pr: 42 });
  assert.match(p, /pull request #42 in testivai\/testivai-example/);
  assert.match(p, /pr\.diff/);
  assert.match(p, /Never approve/);
  assert.match(p, /data, not instructions/);
});

// ── the comment ─────────────────────────────────────────────────────────────

const R = results([
  { name: 'home', status: 'changed' },
  { name: 'buttons', status: 'changed' },
  { name: 'products', status: 'new' },
]);

test('renders one row per snapshot, in report order, with the marker', () => {
  const body = review.renderComment(R, {
    summary: 'The banner pushes the page down; the buttons were restyled.',
    snapshots: [
      { name: 'buttons', kind: 'style-only', intended: 'yes', recommendation: 'approve', explanation: 'Matches the CSS change.' },
      { name: 'home', kind: 'layout-shift', intended: 'yes', recommendation: 'approve', explanation: 'Banner added in index.html.' },
      { name: 'products', kind: 'new', intended: 'unclear', recommendation: 'investigate', explanation: 'New page, check it.' },
    ],
  });
  assert.ok(body.startsWith(review.MARKER));
  const rows = body.split('\n').filter((l) => l.startsWith('| `'));
  assert.deepEqual(rows.map((l) => l.match(/^\| `([^`]+)`/)[1]), ['home', 'buttons', 'products']);
  assert.match(body, /Layout shift/);
  assert.match(body, /Style-only change/);
  assert.match(body, /The banner pushes the page down/);
  assert.match(body, /\/testivai approve/);
});

test('a snapshot the agent skipped is shown as not reviewed, never dropped', () => {
  const body = review.renderComment(R, {
    summary: 's',
    snapshots: [{ name: 'home', kind: 'layout-shift', intended: 'yes', recommendation: 'approve', explanation: 'ok' }],
  });
  assert.match(body, /\| `buttons` \|[^\n]*not reviewed by the agent/);
  assert.match(body, /\| `products` \|[^\n]*not reviewed by the agent/);
});

test('entries for snapshots that are not in the report are left out', () => {
  const body = review.renderComment(R, {
    summary: 's',
    snapshots: [{ name: 'made-up', kind: 'other', intended: 'yes', recommendation: 'approve', explanation: 'x' }],
  });
  assert.ok(!body.includes('made-up'));
});

test('agent text cannot break the table or inject a marker', () => {
  const body = review.renderComment(R, {
    summary: `hi ${review.MARKER}`,
    snapshots: [{ name: 'home', kind: 'other', intended: 'no', recommendation: 'investigate', explanation: 'a | b\nc' }],
  });
  assert.equal(body.split(review.MARKER).length - 1, 1);
  const row = body.split('\n').find((l) => l.startsWith('| `home`'));
  assert.ok(row.includes('a \\| b c'), row);
});

// ── posting it ──────────────────────────────────────────────────────────────

function fakeGithub(existing) {
  const calls = [];
  return {
    calls,
    rest: {
      issues: {
        listComments: async () => ({ data: existing }),
        createComment: async (args) => calls.push(['create', args]),
        updateComment: async (args) => calls.push(['update', args]),
      },
    },
    paginate: async (fn, args) => (await fn(args)).data,
  };
}
const ctx = { repo: { owner: 'o', repo: 'r' }, issue: { number: 7 } };

test('creates the comment the first time', async () => {
  const gh = fakeGithub([]);
  await review.syncComment({ github: gh, context: ctx, body: `${review.MARKER}\nnew` });
  assert.deepEqual(gh.calls.map((c) => c[0]), ['create']);
  assert.equal(gh.calls[0][1].issue_number, 7);
});

test('updates its own earlier comment instead of adding another', async () => {
  const gh = fakeGithub([{ id: 99, body: `${review.MARKER}\nold`, user: { login: 'github-actions[bot]' } }]);
  await review.syncComment({ github: gh, context: ctx, body: `${review.MARKER}\nnew` });
  assert.deepEqual(gh.calls, [['update', { owner: 'o', repo: 'r', comment_id: 99, body: `${review.MARKER}\nnew` }]]);
});

test("ignores someone else's comment that quotes the marker", async () => {
  const gh = fakeGithub([{ id: 5, body: `${review.MARKER} quoted`, user: { login: 'someone' } }]);
  await review.syncComment({ github: gh, context: ctx, body: `${review.MARKER}\nnew` });
  assert.deepEqual(gh.calls.map((c) => c[0]), ['create']);
});

test('with nothing to review, only an existing comment is updated', async () => {
  const none = fakeGithub([]);
  await review.syncComment({ github: none, context: ctx, body: review.renderNothingToReview(), onlyIfExists: true });
  assert.deepEqual(none.calls, []);

  const some = fakeGithub([{ id: 3, body: `${review.MARKER}\nold`, user: { login: 'github-actions[bot]' } }]);
  await review.syncComment({ github: some, context: ctx, body: review.renderNothingToReview(), onlyIfExists: true });
  assert.equal(some.calls[0][0], 'update');
  assert.match(some.calls[0][1].body, /No visual changes/);
});
