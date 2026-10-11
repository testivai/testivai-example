// Adopt CI captures as baselines for snapshots that have NO baseline yet.
//
// Runs on pushes to main (see .github/workflows/visual.yml), so a merge can
// never leave a page uncompared. It approves new snapshots one by one, never
// with --all: a changed snapshot keeps its baseline and still needs a human
// `/testivai approve` on a PR. Before anything is committed, it checks that
// the working tree holds nothing but the new baseline folders.
//
//   node scripts/adopt-new-baselines.mjs [visual-report/results.json]
//
// Exit 0: done (possibly nothing to adopt). Exit 1: an approve failed, or the
// guard found a change outside the new folders; nothing should be committed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASELINES = '.testivai/baselines';
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** Names reported as `new` that are plain folder names and have no baseline folder. */
export function selectNew(results, baselineExists) {
  return (results.snapshots || [])
    .filter((s) => s.status === 'new' && typeof s.name === 'string' && SAFE_NAME.test(s.name) && !s.name.includes('..'))
    .map((s) => s.name)
    .filter((name) => !baselineExists(name));
}

/**
 * `git status --porcelain --untracked-files=all` lines may only be untracked
 * or added files inside `<baselinesDir>/<adopted name>/`, and not in a
 * `.previous/` backup (which would mean an existing baseline was replaced).
 */
export function checkChanges(porcelainLines, names, baselinesDir = BASELINES) {
  const offending = porcelainLines.filter((line) => {
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (code !== '??' && code !== 'A ') return true;
    if (file.split('/').includes('.previous')) return true;
    return !names.some((name) => file.startsWith(`${baselinesDir}/${name}/`));
  });
  return { ok: offending.length === 0, offending };
}

function main() {
  const cwd = process.cwd();
  const resultsPath = path.resolve(cwd, process.argv[2] || 'visual-report/results.json');
  if (!fs.existsSync(resultsPath)) {
    console.log(`No ${path.relative(cwd, resultsPath)}; nothing to adopt.`);
    return 0;
  }
  const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  const names = selectNew(results, (name) => fs.existsSync(path.join(cwd, BASELINES, name)));
  if (names.length === 0) {
    console.log('No new snapshots; nothing to adopt.');
    return 0;
  }

  const testivai = path.join(cwd, 'node_modules/@testivai/witness/dist/bin/testivai.js');
  for (const name of names) {
    const r = spawnSync(process.execPath, [testivai, 'approve', name], { cwd, encoding: 'utf8' });
    if (r.status !== 0) {
      console.error(`::error::testivai approve ${name} failed:\n${r.stdout}${r.stderr}`);
      return 1;
    }
  }

  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' });
  if (status.status !== 0) {
    console.error(`::error::git status failed: ${status.stderr}`);
    return 1;
  }
  const { ok, offending } = checkChanges(status.stdout.split('\n').filter(Boolean), names);
  if (!ok) {
    console.error(`::error::Refusing to adopt: the working tree has changes besides new baseline folders:\n${offending.join('\n')}`);
    return 1;
  }
  console.log(`adopted: ${names.join(', ')}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
