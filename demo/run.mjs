// `npm run demo`: show what TestivAI reports for three different kinds of
// change, without touching the committed baselines.
//
//   1. capture the untouched site/ in a scratch workspace (.demo/)
//   2. approve those captures as the workspace's baselines
//   3. apply demo/changes.mjs to a copy of the site and capture it again
//   4. copy the resulting report to demo-report/
//
// Baseline and changed captures come from the same machine and browser, so
// the only differences in the report are the three deliberate changes.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHANGES, applyChanges } from './changes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = (name) => path.join(ROOT, 'node_modules', name);

const PLAYWRIGHT = path.join(pkgDir('@playwright/test'), 'cli.js');
const TESTIVAI = path.join(pkgDir('@testivai/witness'), 'dist/bin/testivai.js');
const MCP_SERVER = path.join(pkgDir('@testivai/mcp'), 'dist/server.js');
const DEMO_PORT = '4174';

function run(label, args, { cwd, env, quiet }) {
  const res = spawnSync(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: quiet ? 'pipe' : 'inherit',
  });
  if (res.status !== 0) {
    throw new Error(`demo: ${label} failed (exit ${res.status})\n${res.stdout ?? ''}${res.stderr ?? ''}`);
  }
}

export async function runDemo({ quiet = false, outDir = path.join(ROOT, 'demo-report') } = {}) {
  const workspace = path.join(ROOT, '.demo');
  const changedSite = path.join(workspace, 'site-changed');
  const config = path.resolve(ROOT, process.env.PLAYWRIGHT_CONFIG ?? 'playwright.config.ts');

  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(path.join(workspace, '.testivai'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, '.testivai/config.json'), path.join(workspace, '.testivai/config.json'));
  fs.cpSync(path.join(ROOT, 'site'), changedSite, { recursive: true });
  applyChanges(changedSite);

  const capture = (label, siteDir) =>
    run(label, [PLAYWRIGHT, 'test', '--config', config], {
      cwd: workspace,
      env: { SITE_DIR: siteDir, SITE_PORT: DEMO_PORT },
      quiet,
    });

  capture('baseline capture', path.join(ROOT, 'site'));
  run('approve baselines', [TESTIVAI, 'approve', '--all'], { cwd: workspace, quiet });
  capture('changed capture', changedSite);

  const reportDir = path.join(workspace, 'visual-report');
  const results = JSON.parse(fs.readFileSync(path.join(reportDir, 'results.json'), 'utf8'));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(reportDir, outDir, { recursive: true });

  return { workspace, reportDir: outDir, results, mcpServer: MCP_SERVER };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { results, reportDir } = await runDemo();
  console.log('\nDemo changes:');
  for (const change of CHANGES) {
    const s = results.snapshots.find((x) => x.name === change.snapshot);
    console.log(`  ${change.snapshot.padEnd(9)} ${change.kind.padEnd(13)} ${s?.status ?? 'missing'}: ${change.summary}`);
  }
  console.log(`\nOpen ${path.relative(process.cwd(), path.join(reportDir, 'index.html'))}`);
  console.log('Or ask your agent: claude mcp add testivai -- npx -y @testivai/mcp --root .demo');
}
