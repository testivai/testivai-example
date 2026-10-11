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
import { selectNew, checkChanges, parsePorcelainZ } from './adopt-new-baselines.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/adopt-new-baselines.mjs');

const sh = (cmd, args, cwd, env = {}) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};

// ── selection ───────────────────────────────────────────────────────────────

const results = (...snaps) => ({ snapshots: snaps.map(([name, status]) => ({ name, status })) });

test('only snapshots reported as new are selected', () => {
  const r = results(['home', 'passed'], ['buttons', 'changed'], ['products', 'new'], ['pricing', 'new']);
  assert.deepEqual(selectNew(r, () => false), { adopt: ['products', 'pricing'], skipped: [] });
});

test('a new snapshot whose baseline folder already exists is skipped', () => {
  const r = results(['products', 'new']);
  assert.deepEqual(selectNew(r, (n) => n === 'products').adopt, []);
});

test('any single folder name is accepted, including spaces, brackets and accents', () => {
  const r = results(['Pricing page', 'new'], ['checkout(guest)', 'new'], ['home@2x', 'new'], ['café', 'new']);
  assert.deepEqual(selectNew(r, () => false), { adopt: ['Pricing page', 'checkout(guest)', 'home@2x', 'café'], skipped: [] });
});

test('names that are not a single safe folder are refused and reported, not dropped silently', () => {
  const r = results(['../evil', 'new'], ['a/b', 'new'], ['a\\b', 'new'], ['.previous', 'new'], ['..', 'new'], ['', 'new'], ['bad\nname', 'new'], ['ok', 'new']);
  const { adopt, skipped } = selectNew(r, () => false);
  assert.deepEqual(adopt, ['ok']);
  assert.equal(skipped.length, 7);
});

// ── guard over git status ───────────────────────────────────────────────────

const B = '.testivai/baselines';
const z = (...entries) => Buffer.from(entries.map((e) => `${e}\0`).join(''));

test('parses NUL-separated porcelain, including renames and unquoted unusual paths', () => {
  const entries = parsePorcelainZ(z('?? .testivai/baselines/Pricing page/a.png', 'R  new.txt', 'old.txt', ' M x'));
  assert.deepEqual(entries, [
    { code: '??', path: '.testivai/baselines/Pricing page/a.png' },
    { code: 'R ', path: 'new.txt' },
    { code: ' M', path: 'x' },
  ]);
});

test('only new files inside the adopted folders pass the guard', () => {
  const e = parsePorcelainZ(z('?? .testivai/baselines/products/screenshot.png', '?? .testivai/baselines/Pricing page/dom.html'));
  assert.deepEqual(checkChanges(e, ['products', 'Pricing page'], B), { ok: true, offending: [] });
});

test('a modified or deleted existing baseline fails the guard', () => {
  const e = parsePorcelainZ(z(' M .testivai/baselines/buttons/screenshot.png', ' D .testivai/baselines/home/dom.html'));
  const res = checkChanges(e, ['products'], B);
  assert.equal(res.ok, false);
  assert.equal(res.offending.length, 2);
});

test('new files outside the adopted folders fail the guard', () => {
  const e = parsePorcelainZ(z('?? .testivai/baselines/buttons/.previous/screenshot.png', '?? site/index.html', '?? .testivai/baselines/productsX/a.png'));
  const res = checkChanges(e, ['products'], B);
  assert.equal(res.ok, false);
  assert.equal(res.offending.length, 3);
});

test('a rename or a pre-existing modification fails the guard', () => {
  assert.equal(checkChanges(parsePorcelainZ(z('M  playwright.config.ts')), [], B).ok, false);
  assert.equal(checkChanges(parsePorcelainZ(z('R  .testivai/baselines/products/a.png', 'site/a.png')), ['products'], B).ok, false);
});

test('real git: a folder name with a space passes the guard (porcelain -z is unquoted)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-z-'));
  sh('git', ['init', '-q'], dir);
  fs.mkdirSync(path.join(dir, B, 'Pricing page'), { recursive: true });
  fs.writeFileSync(path.join(dir, B, 'Pricing page', 'screenshot.png'), 'x');
  const out = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: dir }).stdout;
  assert.deepEqual(checkChanges(parsePorcelainZ(out), ['Pricing page'], B), { ok: true, offending: [] });
});

// ── end to end: real captures, real approve, real git ───────────────────────


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
