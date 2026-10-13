// End-to-end check of the demo: capture the real site, approve it as the
// baseline, capture the changed site, and assert that each snapshot gets a
// DIFFERENT verdict, in the HTML report's results.json and over MCP, the
// way an AI agent reads them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runDemo } from './run.mjs';

let demo;
let mcp;

/** Same priority as the HTML report's verdict headline. */
function headline(s) {
  if (s.dom?.styleCheck === 'mismatch') return 'style-only';
  if (s.pageShift) return 'layout-shift';
  if (s.dom?.changed) return 'structural';
  if (s.dom?.noiseHint) return 'noise';
  return s.status;
}

const text = (result) => result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

before(async () => {
  demo = await runDemo({ quiet: true });
  mcp = new Client({ name: 'testivai-example-test', version: '1.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [demo.mcpServer, '--root', demo.workspace],
      stderr: 'ignore',
    }),
  );
});

after(async () => {
  await mcp?.close();
});

const snap = (name) => {
  const s = demo.results.snapshots.find((x) => x.name === name);
  assert.ok(s, `no result for snapshot "${name}"`);
  return s;
};

test('all three snapshots changed; nothing new or missing', () => {
  assert.deepEqual(demo.results.summary, { total: 3, passed: 0, changed: 3, newSnapshots: 0, missing: 0 });
});

test('buttons: style-only change; identical DOM, restyled buttons only', () => {
  const s = snap('buttons');
  assert.equal(s.status, 'changed');
  assert.equal(s.dom.changed, false);
  assert.equal(s.dom.styleCheck, 'mismatch');
  assert.ok(s.dom.styleChanges.count > 0);
  for (const el of s.dom.styleChanges.elements) assert.match(el, /button\.btn/, `unexpected restyle: ${el}`);
  assert.equal(s.pageShift ?? null, null);
});

test('home: layout shift; inserted banner moves the content below it, unchanged', () => {
  const s = snap('home');
  assert.equal(s.status, 'changed');
  assert.equal(s.dom.styleCheck, 'match', 'nothing that existed before was restyled');
  assert.ok(s.pageShift, 'expected a page shift');
  assert.ok(s.pageShift.dy > 0, 'content moves down');
  assert.ok(s.pageShift.count >= 3, 'several elements moved together');
  assert.ok(
    s.regions.some((r) => r.classification === 'shift'),
    'at least one region is attributed as a pure shift',
  );
});

test('products: structural change; a card is gone and nothing else moved', () => {
  const s = snap('products');
  assert.equal(s.status, 'changed');
  assert.equal(s.dom.changed, true);
  assert.ok(s.dom.summary.removed > 0, 'DOM nodes were removed');
  assert.equal(s.dom.summary.added, 0);
  assert.equal(s.dom.styleCheck, 'match');
  assert.equal(s.pageShift ?? null, null);
});

test('the three snapshots read as three different verdicts in the report', () => {
  const kinds = ['home', 'buttons', 'products'].map((n) => headline(snap(n)));
  assert.deepEqual(kinds, ['layout-shift', 'style-only', 'structural']);
});

test('MCP get_visual_results gives each snapshot its verdict line', async () => {
  const out = text(await mcp.callTool({ name: 'get_visual_results', arguments: {} }));
  const line = (name) => out.split('\n').find((l) => l.includes(name) && l.includes('changed ('));
  assert.match(line('buttons') ?? '', /style-only change/);
  assert.match(line('products') ?? '', /real structural change/);
  // The one-line verdict calls an inserted banner "structural" (the DOM did
  // change); explain_snapshot is where the page shift is spelled out.
  assert.match(line('home') ?? '', /real structural change/);
  assert.match(out, /Baseline approval is a human decision|human/i);
  // After the verdicts it lists the paths to open: the report, and each
  // changed snapshot's diff image (absolute, with this OS's separators).
  assert.ok(out.includes('Open on this machine:'), 'no paths to open');
  const open = out.slice(out.indexOf('Open on this machine:'));
  const reportDir = path.join(demo.workspace, 'visual-report');
  assert.ok(open.includes(`- report: ${path.join(reportDir, 'index.html')}\n`), open);
  for (const name of ['buttons', 'home', 'products']) {
    assert.ok(open.includes(`- ${name} (diff): ${path.join(reportDir, 'images', name, 'diff.png')}\n`), open);
  }
});

test('MCP explain_snapshot names the page shift on home', async () => {
  const out = text(await mcp.callTool({ name: 'explain_snapshot', arguments: { name: 'home' } }));
  assert.match(out, /moved down by \d+px/);
  assert.match(out, /content inserted or removed above that line/);
});

test('MCP explain_snapshot names the restyled buttons', async () => {
  const out = text(await mcp.callTool({ name: 'explain_snapshot', arguments: { name: 'buttons' } }));
  assert.match(out, /stylesheet-only change/);
  assert.match(out, /button\.btn/);
});

test('MCP get_diff returns the baseline, current and diff images', async () => {
  const res = await mcp.callTool({ name: 'get_diff', arguments: { name: 'products' } });
  const images = res.content.filter((c) => c.type === 'image');
  assert.equal(images.length, 3);
  for (const img of images) assert.equal(img.mimeType, 'image/png');
});
