// Guards for .github/workflows/deploy-report.yml: after every Visual
// Regression run, testivai/testivai-oss/publish rebuilds the Pages site (main,
// each open pull request's last runs, and the demo under /demo/) and adds the
// report links to the pull request comments. The publish action is tested in
// testivai-oss; this checks the wiring around it, above all that the job
// never checks out or runs pull request code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const text = read('.github/workflows/deploy-report.yml');
const workflow = parse(text);
const visual = parse(read('.github/workflows/visual.yml'));
const { publish } = workflow.jobs;
const step = publish.steps.find((s) => String(s.uses).startsWith('testivai/testivai-oss/publish@'));

test('publishes with the released publish@v1 action, not a branch', () => {
  assert.equal(step.uses, 'testivai/testivai-oss/publish@v1');
  assert.doesNotMatch(text, /compassionate|trial/i);
});

test('publishes after every Visual Regression run, when a pull request closes, and by hand', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request_target', 'workflow_dispatch', 'workflow_run']);
  assert.deepEqual(workflow.on.workflow_run.workflows, [visual.name]);
  assert.deepEqual(workflow.on.workflow_run.types, ['completed']);
  assert.deepEqual(workflow.on.pull_request_target.types, ['closed']);
});

test('skips the runs a /testivai comment starts: they have no report', () => {
  assert.match(publish.if, /github\.event\.workflow_run\.event != 'issue_comment'/);
});

test('one publish at a time, a newer one replacing a running one', () => {
  assert.equal(workflow.concurrency['cancel-in-progress'], true);
});

test('never checks out or runs pull request code', () => {
  const checkouts = publish.steps.filter((s) => String(s.uses).startsWith('actions/checkout@'));
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].with?.ref, undefined, 'checkout without ref: main, or the base branch on pull_request_target');
  assert.equal(checkouts[0].with?.repository, undefined);
  assert.doesNotMatch(text, /github\.event\.(pull_request|workflow_run)\.head|head_sha|head_ref|github\.head_ref/);
});

test('has exactly the permissions the publish needs, and deploys through github-pages', () => {
  assert.deepEqual(publish.permissions, { contents: 'read', actions: 'read', pages: 'write', 'id-token': 'write', 'pull-requests': 'write' });
  assert.equal(publish.environment.name, 'github-pages');
  assert.equal(publish.environment.url, '${{ steps.publish.outputs.page-url }}');
});

test('builds the demo, checking its verdicts, then publishes it as /demo/ with the reports', () => {
  const runs = publish.steps.map((s) => s.run).filter(Boolean);
  assert.ok(runs.includes('npm run test:demo'), 'the demo is not built');
  assert.equal(publish.steps.at(-1), step, 'the publish is the last step');
  assert.equal(step.id, 'publish');
  // demo/run.mjs writes demo-report/ by default.
  assert.equal(step.with['include-dir'], 'demo-report');
  assert.equal(step.with['include-name'], 'demo');
  // An unknown input is silently ignored by GitHub, so a typo would go unseen.
  const inputs = ['github-token', 'artifact-name', 'runs-per-pr', 'public-reports', 'status-context', 'include-dir', 'include-name', 'comment'];
  for (const key of Object.keys(step.with)) assert.ok(inputs.includes(key), `publish has no input "${key}"`);
});

test('adopting baselines on main re-runs the visual check there, which publishes /main/ again', () => {
  const adopt = visual.jobs.visual.steps.find((s) => s.name === 'Adopt baselines for new snapshots');
  assert.match(adopt.run, /gh workflow run visual\.yml --ref main/);
  assert.doesNotMatch(adopt.run, /gh workflow run deploy-report\.yml/);
});

test('the README links the demo and main where they are published', () => {
  const readme = read('README.md');
  assert.match(readme, /https:\/\/testivai\.github\.io\/testivai-example\/demo\//);
  assert.match(readme, /https:\/\/testivai\.github\.io\/testivai-example\/main\//);
});
