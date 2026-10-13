// Guards for the merge gate in .github/workflows/visual.yml: a changed
// snapshot fails the `TestivAI / visual` check on a PR (so a branch rule can
// require it), `/testivai approve` commits the baselines, and the visual check
// then runs again on the approve commit. A push made with GITHUB_TOKEN starts
// no workflow, so without a TESTIVAI_APPROVE_TOKEN secret the approve job
// starts the visual workflow on the PR branch itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = parse(fs.readFileSync(path.join(ROOT, '.github/workflows/visual.yml'), 'utf8'));
const { visual, approve } = workflow.jobs;
const agentReview = workflow.jobs['agent-review'];
const reporter = visual.steps.find((s) => s.uses === 'testivai/testivai-oss@v1');
const approveStep = approve.steps.find((s) => String(s.uses).startsWith('testivai/testivai-oss/approve@'));
const rerun = approve.steps.find((s) => s.name === 'Re-run the visual check on the approve commit');

// ── the gate ────────────────────────────────────────────────────────────────

test('a changed snapshot fails the check everywhere but on main', () => {
  // PR runs (refs/pull/N/merge) and the approve re-run (refs/heads/<branch>)
  // are gated; main stays informational so new baselines are still adopted.
  assert.equal(reporter.with['fail-on-diff'], "${{ github.ref != 'refs/heads/main' }}");
});

test('the visual job can post the check run and the commit status', () => {
  assert.equal(visual.permissions.checks, 'write');
  assert.equal(visual.permissions.statuses, 'write');
});

test('the agent review still runs when the gate fails the visual job', () => {
  // Wrapped in ${{ }}: a plain YAML value cannot start with `!`.
  assert.match(agentReview.if, /^\$\{\{ !cancelled\(\) && /);
  assert.match(agentReview.if, /github\.event_name == 'pull_request'/);
  assert.match(agentReview.if, /head\.repo\.full_name == github\.repository/);
});

test('the visual workflow can be started on a branch (the approve re-run)', () => {
  assert.ok('workflow_dispatch' in workflow.on, 'visual.yml has no workflow_dispatch trigger');
});

// ── approve ─────────────────────────────────────────────────────────────────

test('the approve job reads runs and artifacts, starts workflows, commits and replies', () => {
  // A job-level block replaces the workflow-level one; actions: write covers read.
  assert.deepEqual(approve.permissions, { contents: 'write', 'pull-requests': 'write', actions: 'write' });
});

test('approve pushes with TESTIVAI_APPROVE_TOKEN when set, and falls back to GITHUB_TOKEN', () => {
  assert.equal(approveStep.with['github-token'], '${{ secrets.TESTIVAI_APPROVE_TOKEN || secrets.GITHUB_TOKEN }}');
  assert.equal(approve.env.HAS_APPROVE_TOKEN, "${{ secrets.TESTIVAI_APPROVE_TOKEN != '' }}");
});

test('the re-run happens only without the token, and only for an approve command', () => {
  assert.ok(rerun, 'no re-run step after the approve step');
  assert.ok(approve.steps.indexOf(rerun) > approve.steps.indexOf(approveStep));
  assert.match(rerun.if, /env\.HAS_APPROVE_TOKEN != 'true'/);
  assert.match(rerun.if, /startsWith\(github\.event\.comment\.body, '\/testivai approve'\)/);
});

test('the re-run takes no input from the comment or the PR checkout', () => {
  // Expressions in `run:` are pasted into the script before it runs, and the
  // approve action leaves the PR branch checked out in the workspace.
  assert.doesNotMatch(rerun.run, /\$\{\{/);
  assert.doesNotMatch(rerun.run, /\bnode\b|\.\/|scripts\/|\bsource\b/);
  assert.deepEqual(rerun.env, {
    GH_TOKEN: '${{ github.token }}',
    PR: '${{ github.event.issue.number }}',
    ACTOR: '${{ github.event.comment.user.login }}',
  });
});

// ── the re-run script, run for real against a fake `gh` ─────────────────────

function runRerun({ perm = 'write', fork = 'false', branch = 'feature/x', dispatchFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rerun-'));
  const log = path.join(dir, 'gh.log');
  fs.writeFileSync(
    path.join(dir, 'gh'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1" in
  api) [ "$FAKE_PERM" = error ] && exit 1; printf '%s\\n' "$FAKE_PERM" ;;
  pr) case "$*" in *isCrossRepository*) printf '%s\\n' "$FAKE_FORK" ;; *headRefName*) printf '%s\\n' "$FAKE_BRANCH" ;; esac ;;
  workflow) [ -n "$FAKE_DISPATCH_FAILS" ] && exit 1; exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  const r = spawnSync('bash', ['-e', '-c', rerun.run], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'acme/site',
      PR: '42',
      ACTOR: 'alice',
      GH_TOKEN: 'x',
      FAKE_LOG: log,
      FAKE_PERM: perm,
      FAKE_FORK: fork,
      FAKE_BRANCH: branch,
      FAKE_DISPATCH_FAILS: dispatchFails ? '1' : '',
    },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  return { status: r.status, out: r.stdout + r.stderr, calls, dir };
}

const dispatches = (calls) => calls.filter((c) => c.startsWith('workflow run'));

test('a writer on a same-repo PR: the visual workflow starts on the PR branch', () => {
  const r = runRerun();
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(dispatches(r.calls), ['workflow run visual.yml --repo acme/site --ref feature/x']);
  assert.ok(r.calls.includes('api repos/acme/site/collaborators/alice/permission --jq .permission'), r.calls.join('\n'));
});

test('maintainers and admins can re-run too', () => {
  for (const perm of ['maintain', 'admin']) assert.equal(dispatches(runRerun({ perm }).calls).length, 1, perm);
});

test('a commenter without write access starts nothing', () => {
  for (const perm of ['read', 'triage', 'none', 'error']) {
    const r = runRerun({ perm });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(dispatches(r.calls), [], perm);
  }
});

test('a fork PR starts nothing and says why', () => {
  const r = runRerun({ fork: 'true' });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(dispatches(r.calls), []);
  assert.match(r.out, /::warning::.*fork/);
});

test('when the PR lookup gives no answer, nothing starts (treated like a fork)', () => {
  const r = runRerun({ fork: '' });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(dispatches(r.calls), []);
});

test('a failed dispatch fails the step, so the job shows it', () => {
  assert.notEqual(runRerun({ dispatchFails: true }).status, 0);
});

test('a branch name is passed as one literal argument, never run', () => {
  const branch = 'x$(touch pwned)`touch pwned2`;touch pwned3';
  const r = runRerun({ branch });
  assert.deepEqual(dispatches(r.calls), [`workflow run visual.yml --repo acme/site --ref ${branch}`]);
  for (const f of ['pwned', 'pwned2', 'pwned3']) assert.ok(!fs.existsSync(path.join(r.dir, f)), f);
});

// ── docs ────────────────────────────────────────────────────────────────────

test('the README says how to require the check and how to create TESTIVAI_APPROVE_TOKEN', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /`TestivAI \/ visual`/);
  const section = readme.match(/TESTIVAI_APPROVE_TOKEN[\s\S]*?(?=\n## |$)/)?.[0] ?? '';
  assert.ok(section, 'README does not mention TESTIVAI_APPROVE_TOKEN');
  for (const permission of [/Contents.*read and write/i, /Pull requests.*read and write/i, /Actions.*read/i]) {
    assert.match(section, permission);
  }
});
