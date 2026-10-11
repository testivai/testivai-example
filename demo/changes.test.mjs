// Unit tests for the demo's change set: each change must land exactly where
// it is meant to, and a site edit that moves the target must fail loudly
// instead of silently producing a demo with fewer than three verdicts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANGES, applyChanges } from './changes.mjs';

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');

function copySite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-demo-'));
  fs.cpSync(SITE, dir, { recursive: true });
  return dir;
}

test('there is one change per snapshot, each a different kind of diff', () => {
  assert.deepEqual(CHANGES.map((c) => c.snapshot).sort(), ['buttons', 'home', 'products']);
  assert.equal(new Set(CHANGES.map((c) => c.kind)).size, 3);
});

test('every edit matches the real site exactly once', () => {
  for (const change of CHANGES) {
    for (const edit of change.edits) {
      const source = fs.readFileSync(path.join(SITE, edit.file), 'utf8');
      assert.equal(source.split(edit.find).length - 1, 1, `${change.snapshot}: "${edit.find.slice(0, 40)}…" in ${edit.file}`);
    }
  }
});

test('applyChanges rewrites a copy of the site and leaves the original alone', () => {
  const before = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  const dir = copySite();
  applyChanges(dir);
  for (const change of CHANGES) {
    for (const edit of change.edits) {
      const out = fs.readFileSync(path.join(dir, edit.file), 'utf8');
      assert.ok(!out.includes(edit.find) || edit.replace.includes(edit.find), `${edit.file} still has the original text`);
      if (edit.replace) assert.ok(out.includes(edit.replace), `${edit.file} is missing the replacement`);
    }
  }
  assert.equal(fs.readFileSync(path.join(SITE, 'index.html'), 'utf8'), before);
});

test('applyChanges refuses an edit whose target is missing', () => {
  const dir = copySite();
  const drifted = [{ snapshot: 'home', kind: 'x', edits: [{ file: 'index.html', find: 'no such text', replace: '' }] }];
  assert.throws(() => applyChanges(dir, drifted), /home: expected exactly 1 match .*index\.html.*found 0/);
});

test('applyChanges refuses an edit whose target is ambiguous', () => {
  const dir = copySite();
  const ambiguous = [{ snapshot: 'home', kind: 'x', edits: [{ file: 'index.html', find: '<', replace: '' }] }];
  assert.throws(() => applyChanges(dir, ambiguous), /home: expected exactly 1 match .*index\.html.*found \d+/);
});
