// Tests for adopting CI captures as baselines for NEW snapshots on main.
// The rule: a snapshot with no baseline gets one; a changed snapshot is never
// touched (that still needs a human `/testivai approve`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectNew, checkChanges } from './adopt-new-baselines.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/adopt-new-baselines.mjs');

// ── selection ───────────────────────────────────────────────────────────────

const results = (...snaps) => ({ snapshots: snaps.map(([name, status]) => ({ name, status })) });

test('only snapshots reported as new are selected', () => {
  const r = results(['home', 'passed'], ['buttons', 'changed'], ['products', 'new'], ['pricing', 'new']);
  assert.deepEqual(selectNew(r, () => false), ['products', 'pricing']);
});

test('a new snapshot whose baseline folder already exists is skipped', () => {
  const r = results(['products', 'new']);
  assert.deepEqual(selectNew(r, (n) => n === 'products'), []);
});

test('names that are not a plain folder name are refused', () => {
  const r = results(['../evil', 'new'], ['a/b', 'new'], ['.previous', 'new'], ['', 'new'], ['ok-name_1.2', 'new']);
  assert.deepEqual(selectNew(r, () => false), ['ok-name_1.2']);
});

// ── guard over git status ───────────────────────────────────────────────────

const B = '.testivai/baselines';

test('only new files inside the adopted folders pass the guard', () => {
  const lines = ['?? .testivai/baselines/products/screenshot.png', '?? .testivai/baselines/products/dom.html'];
  assert.deepEqual(checkChanges(lines, ['products'], B), { ok: true, offending: [] });
});

test('a modified or deleted existing baseline fails the guard', () => {
  const lines = [' M .testivai/baselines/buttons/screenshot.png', ' D .testivai/baselines/home/dom.html'];
  const res = checkChanges(lines, ['products'], B);
  assert.equal(res.ok, false);
  assert.equal(res.offending.length, 2);
});

test('new files outside the adopted folders fail the guard', () => {
  const lines = ['?? .testivai/baselines/buttons/.previous/screenshot.png', '?? site/index.html', '?? .testivai/baselines/productsX/a.png'];
  const res = checkChanges(lines, ['products'], B);
  assert.equal(res.ok, false);
  assert.equal(res.offending.length, 3);
});

test('a modification that is already present before adopting also fails the guard', () => {
  // Anything the working tree shows besides the new folders blocks the commit.
  const res = checkChanges(['M  playwright.config.ts'], [], B);
  assert.equal(res.ok, false);
});

// ── end to end: real captures, real approve, real git ───────────────────────

const sh = (cmd, args, cwd, env = {}) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-baselines-'));
  for (const f of ['site', 'tests', 'scripts', 'playwright.config.ts', '.testivai/config.json', 'package.json', '.gitignore']) {
    fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  }
  const local = process.env.PLAYWRIGHT_CONFIG;
  if (local) fs.cpSync(path.resolve(ROOT, local), path.join(dir, path.basename(local)));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  sh('git', ['init', '-q'], dir);
  sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], dir);
  sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], dir);
  return dir;
}

const capture = (dir) =>
  sh(process.execPath, [path.join(ROOT, 'node_modules/@playwright/test/cli.js'), 'test', '--config', path.join(dir, process.env.PLAYWRIGHT_CONFIG ? path.basename(process.env.PLAYWRIGHT_CONFIG) : 'playwright.config.ts')], dir, {
    SITE_DIR: path.join(dir, 'site'),
    SITE_PORT: '4175',
  });

const approve = (dir, name) => sh(process.execPath, [path.join(ROOT, 'node_modules/@testivai/witness/dist/bin/testivai.js'), 'approve', name], dir);
const commitAll = (dir, msg) => {
  sh('git', ['add', '-A'], dir);
  sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg], dir);
};
const gitStatus = (dir) => sh('git', ['status', '--porcelain', '--untracked-files=all'], dir).split('\n').filter(Boolean);

test('end to end: adopts only the new snapshot; unchanged and changed baselines are untouched', { timeout: 240_000 }, () => {
  const dir = makeWorkspace();
  // Baselines for home and buttons only.
  capture(dir);
  approve(dir, 'home');
  approve(dir, 'buttons');
  commitAll(dir, 'baselines for home and buttons');
  const buttonsBefore = fs.readFileSync(path.join(dir, '.testivai/baselines/buttons/screenshot.png'));

  // Change the buttons, capture again: home passed, buttons changed, products new.
  const css = path.join(dir, 'site/styles.css');
  fs.writeFileSync(css, fs.readFileSync(css, 'utf8').replace('border-radius:8px;', 'border-radius:999px;'));
  commitAll(dir, 'restyle buttons');
  capture(dir);
  const r = JSON.parse(fs.readFileSync(path.join(dir, 'visual-report/results.json'), 'utf8'));
  const status = Object.fromEntries(r.snapshots.map((s) => [s.name, s.status]));
  assert.deepEqual(status, { home: 'passed', buttons: 'changed', products: 'new' });

  const out = sh(process.execPath, [SCRIPT, 'visual-report/results.json'], dir);
  assert.match(out, /adopted: products/);

  const changes = gitStatus(dir);
  assert.ok(changes.length > 0);
  for (const line of changes) assert.match(line, /^\?\? \.testivai\/baselines\/products\//, line);
  assert.deepEqual(fs.readFileSync(path.join(dir, '.testivai/baselines/buttons/screenshot.png')), buttonsBefore);
  assert.ok(fs.existsSync(path.join(dir, '.testivai/baselines/products/screenshot.png')));
});

test('end to end: refuses to finish when an existing baseline was modified', { timeout: 240_000 }, () => {
  const dir = makeWorkspace();
  capture(dir);
  approve(dir, 'home');
  commitAll(dir, 'baseline for home');
  capture(dir);
  // Something (not the script) tampers with an existing baseline.
  fs.appendFileSync(path.join(dir, '.testivai/baselines/home/dom.html'), '<!-- tampered -->');
  const res = spawnSync(process.execPath, [SCRIPT, 'visual-report/results.json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout + res.stderr, /home\/dom\.html/);
});
