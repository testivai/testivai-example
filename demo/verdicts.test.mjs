// End-to-end check of the demo: capture the real site, approve it as the
// baseline, capture the changed site, and assert that each snapshot gets a
// DIFFERENT verdict, in the HTML report's results.json and over MCP, the
// way an AI agent reads them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runDemo } from './run.mjs';

let demo;
let mcp;

/**
 * Same priority as the HTML report's verdict headline. An identical DOM is
 * worded by the style check and the shape of the diff (likely render noise
 * only when styles match and the diff is small and scattered; see
 * noise-verdicts.test.mjs), which none of the demo's changes reach.
 */
function headline(s) {
  if (s.dom?.styleCheck === 'mismatch') return 'style-only';
  if (s.pageShift) return 'layout-shift';
  if (s.dom?.changed) return 'structural';
  if (s.dom?.noiseHint) return 'identical-dom';
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
  // The banner makes the page taller by exactly what it pushes down.
  assert.ok(s.sizeMismatch, 'the taller capture is reported as a size change');
  assert.equal(s.sizeMismatch.candidate.width, s.sizeMismatch.baseline.width);
  assert.equal(s.sizeMismatch.candidate.height - s.sizeMismatch.baseline.height, s.pageShift.dy);
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

test('capture provenance: each capture records its environment, and approving keeps it with the baseline', () => {
  const env = demo.results.environment;
  assert.ok(env, 'results.json has no run-level environment');
  assert.equal(env.browser?.name, 'chromium');
  assert.match(env.adapter?.captureMethod ?? '', /^full-page:/);
  for (const name of ['home', 'buttons', 'products']) {
    const meta = JSON.parse(fs.readFileSync(path.join(demo.workspace, '.testivai', 'baselines', name, 'metadata.json'), 'utf8'));
    assert.ok(meta.environment?.browser, `${name}: the approved baseline did not keep its capture environment`);
  }
});

test("the demo's diffs come from the page, not the machine: no rendering change between its captures", () => {
  for (const name of ['home', 'buttons', 'products']) {
    const e = snap(name).environment;
    assert.ok(e, `${name}: baseline and capture were not compared by environment`);
    assert.deepEqual(e.renderingDelta, [], `${name}: ${JSON.stringify(e.renderingDelta)}`);
  }
});

test('the report gives each snapshot a link target (#snap-<name>), as the published demo links use', () => {
  const html = fs.readFileSync(path.join(demo.reportDir, 'index.html'), 'utf8');
  for (const name of ['home', 'buttons', 'products']) assert.match(html, new RegExp(`id="snap-${name}"`));
});

test('MCP get_visual_results gives each snapshot its verdict line', async () => {
  const out = text(await mcp.callTool({ name: 'get_visual_results', arguments: {} }));
  const line = (name) => out.split('\n').find((l) => l.includes(name) && l.includes('changed ('));
  assert.match(line('buttons') ?? '', /style-only change/);
  assert.match(line('products') ?? '', /real structural change/);
  // The banner makes the page taller, and the size change leads the line,
  // with the DOM change after it. The added band at the bottom is only the
  // new height: the line places the banner with the page shift, above it.
  const home = line('home') ?? '';
  const { pageShift } = snap('home');
  assert.match(home, /page grew \d+ px \(baseline \d+×\d+ → current \d+×\d+\) and the DOM changed \(1 added/);
  assert.ok(
    home.includes(`everything below y=${pageShift.belowY} moved down ${pageShift.dy} px, so look above that line`),
    `home's verdict does not place the banner above the page shift: ${home}`,
  );
  assert.doesNotMatch(home, /below the baseline's height/);
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
  // Its guidance does not also send the reader to the bottom of the page.
  assert.doesNotMatch(out, /below the baseline's height/);
});

test('MCP explain_snapshot names the restyled buttons', async () => {
  const out = text(await mcp.callTool({ name: 'explain_snapshot', arguments: { name: 'buttons' } }));
  assert.match(out, /stylesheet-only change/);
  assert.match(out, /button\.btn/);
});

test('MCP get_diff returns the baseline, current and diff images, then the changed area at native scale', async () => {
  const res = await mcp.callTool({ name: 'get_diff', arguments: { name: 'products' } });
  // Each image follows the text that labels it.
  const labelled = res.content.flatMap((c, i) => (c.type === 'image' ? [{ img: c, label: res.content[i - 1]?.text ?? '' }] : []));
  for (const { img } of labelled) assert.equal(img.mimeType, 'image/png');
  assert.deepEqual(
    labelled.slice(0, 3).map(({ label }) => label.split(' ')[0]),
    ['baseline', 'current', 'diff'],
  );
  // The page is wider than the 1024 px the whole images are sent at, so the
  // regions follow as crops, one image pixel per page pixel: the removed card.
  const crops = res.content.filter((c) => c.type === 'text' && /^Crop \d+ of \d+:/.test(c.text));
  assert.ok(crops.length >= 1, 'a downscaled diff comes with crops of its regions');
  assert.match(crops[0].text, /div\.cards/);
  assert.equal(labelled.length, 3 + 3 * crops.length);
  assert.deepEqual(
    labelled.slice(3, 6).map(({ label }) => label.replace(/ \(.*$/, '').replace(/:$/, '')),
    ['baseline, crop 1', 'current, crop 1', 'diff, crop 1'],
  );
});
