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

/** A snapshot name that is exactly one folder: no separators, no dot-prefix, no control characters. */
const isSafeName = (name) =>
  typeof name === 'string' && name.length > 0 && !/[/\\\x00-\x1f\x7f]/.test(name) && !name.startsWith('.');

/**
 * Snapshots reported as `new` that have no baseline folder. `skipped` lists
 * the new names that are not a single safe folder name, so the caller can
 * say so instead of dropping them silently.
 */
export function selectNew(results, baselineExists) {
  const fresh = (results.snapshots || []).filter((s) => s.status === 'new');
  const adopt = fresh.filter((s) => isSafeName(s.name) && !baselineExists(s.name)).map((s) => s.name);
  const skipped = fresh.filter((s) => !isSafeName(s.name)).map((s) => String(s.name));
  return { adopt, skipped };
}

/**
 * Parse `git status --porcelain -z --untracked-files=all`. Paths are never
 * quoted in this form; a rename or copy entry is followed by its source path.
 */
export function parsePorcelainZ(buf) {
  const tokens = buf.toString('utf8').split('\0').filter((t) => t.length > 0);
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i].slice(0, 2);
    entries.push({ code, path: tokens[i].slice(3) });
    if (code[0] === 'R' || code[0] === 'C') i++;
  }
  return entries;
}

/**
 * The working tree may only hold untracked or added files inside
 * `<baselinesDir>/<adopted name>/`, never in a `.previous/` backup (which
 * would mean an existing baseline was replaced).
 */
export function checkChanges(entries, names, baselinesDir = BASELINES) {
  const offending = entries
    .filter(({ code, path: file }) => {
      if (code !== '??' && code !== 'A ') return true;
      if (file.split('/').includes('.previous')) return true;
      return !names.some((name) => file.startsWith(`${baselinesDir}/${name}/`));
    })
    .map(({ code, path: file }) => `${code} ${file}`);
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
  const { adopt: names, skipped } = selectNew(results, (name) => fs.existsSync(path.join(cwd, BASELINES, name)));
  for (const name of skipped) {
    console.log(`::warning::New snapshot ${JSON.stringify(name)} was not adopted: its name is not a single folder name. Approve it on a PR with /testivai approve.`);
  }
  if (names.length === 0) {
    console.log(skipped.length ? 'No new snapshot could be adopted.' : 'No new snapshots; nothing to adopt.');
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

  const status = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd });
  if (status.status !== 0) {
    console.error(`::error::git status failed: ${status.stderr}`);
    return 1;
  }
  const { ok, offending } = checkChanges(parsePorcelainZ(status.stdout), names);
  if (!ok) {
    console.error(`::error::Refusing to adopt: the working tree has changes besides new baseline folders:\n${offending.join('\n')}`);
    return 1;
  }
  console.log(`adopted: ${names.join(', ')}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
