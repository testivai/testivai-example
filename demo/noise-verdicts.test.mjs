// AGENTS.md tells agents that an identical DOM with matching computed styles
// is likely render noise only when the diff is also small and scattered, and
// rendering drift, never noise, when the rendering environment changed since
// the baseline. This checks that the installed @testivai/mcp says the same,
// without a browser: it reads a results.json holding such diffs that differ
// only in shape, and one whose browser was updated.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP_SERVER = path.join(ROOT, 'node_modules', '@testivai/mcp', 'dist/server.js');

const PAGE = { width: 1280, height: 800 };
const sameDom = { changed: false, noiseHint: true, summary: null, styleCheck: 'match' };
const box = (x, y, width, height) => ({ x, y, width, height, classification: 'change', elements: [] });
const snapshot = (name, diffPercent, regions) => ({
  name,
  status: 'changed',
  diffPercent,
  diffCount: Math.round((diffPercent / 100) * PAGE.width * PAGE.height),
  totalPixels: PAGE.width * PAGE.height,
  dom: sameDom,
  regions,
});

const BROWSER_UPDATE = {
  delta: ['browser.version'],
  renderingDelta: ['browser.version'],
  baseline: { browser: { name: 'chromium', version: '130.0.6723.58' } },
  candidate: { browser: { name: 'chromium', version: '141.0.7390.37' } },
};

const RESULTS = {
  version: '2.5.0',
  timestamp: new Date().toISOString(),
  summary: { total: 4, passed: 0, changed: 4, newSnapshots: 0, missing: 0 },
  missingBaselines: [],
  snapshots: [
    // Edge pixels from corner to corner: what font hinting looks like.
    snapshot('scattered', 0.3, [box(0, 0, 12, 12), box(1268, 788, 12, 12)]),
    // One 100x40 box: a bad capture, or a change the style check does not cover.
    snapshot('concentrated', 0.3, [box(40, 40, 100, 40)]),
    // Spread out, but 5% of the page.
    snapshot('large', 5, [box(0, 0, 12, 12), box(1268, 788, 12, 12)]),
    // The scattered diff again, after the browser was updated: the machine changed, not the page.
    { ...snapshot('drift', 0.3, [box(0, 0, 12, 12), box(1268, 788, 12, 12)]), environment: BROWSER_UPDATE },
  ],
};

let workspace;
let mcp;

before(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-noise-'));
  fs.mkdirSync(path.join(workspace, 'visual-report'));
  fs.writeFileSync(path.join(workspace, 'visual-report', 'results.json'), JSON.stringify(RESULTS, null, 2));
  mcp = new Client({ name: 'testivai-example-test', version: '1.0.0' });
  await mcp.connect(
    new StdioClientTransport({ command: process.execPath, args: [MCP_SERVER, '--root', workspace], stderr: 'ignore' }),
  );
});

after(async () => {
  await mcp?.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

const text = (result) => result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

async function verdictLine(name) {
  const out = text(await mcp.callTool({ name: 'get_visual_results', arguments: {} }));
  const line = out.split('\n').find((l) => l.includes(name) && l.includes('changed ('));
  assert.ok(line, `no verdict line for ${name}:\n${out}`);
  return line;
}

test('a small, scattered diff with identical DOM and styles is likely render noise', async () => {
  assert.match(await verdictLine('scattered'), /likely render noise/);
});

test('the same diff in one area is not called render noise', async () => {
  const line = await verdictLine('concentrated');
  assert.doesNotMatch(line, /likely render noise/);
  assert.match(line, /concentrated in one area/);
});

test('a large spread-out diff is not called render noise', async () => {
  const line = await verdictLine('large');
  assert.doesNotMatch(line, /likely render noise/);
  assert.match(line, /large/);
});

test('explain_snapshot gives the concentrated diff the same reading', async () => {
  const out = text(await mcp.callTool({ name: 'explain_snapshot', arguments: { name: 'concentrated' } }));
  assert.match(out, /concentrated in one area/i);
  assert.doesNotMatch(out, /likely render noise \(anti-aliasing, font hinting\)\. Mention it; do not block on it/);
});

test('the same scattered diff after a browser update is rendering drift, not render noise', async () => {
  const line = await verdictLine('drift');
  assert.doesNotMatch(line, /likely render noise/);
  assert.match(line, /rendering drift/i);
  assert.match(line, /130\.0\.6723\.58 → 141\.0\.7390\.37/);
});
