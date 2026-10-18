// Guards for the merge gate in .github/workflows/visual.yml: a changed
// snapshot fails the `TestivAI / visual` check on a PR (so a branch rule can
// require it), `/testivai approve` commits the baselines, and the visual check
// then runs again on the approve commit. A push made with GITHUB_TOKEN starts
// no workflow, so without a TESTIVAI_APPROVE_TOKEN secret the approve job
// starts the visual workflow on the PR branch itself. The agent review is the
// released testivai/testivai-oss/review@v1 action; its logic is tested there.
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
const triage = agentReview.steps.find((s) => String(s.uses).startsWith('testivai/testivai-oss/review@'));
const download = agentReview.steps.find((s) => String(s.uses).startsWith('actions/download-artifact@'));

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

// ── agent review ────────────────────────────────────────────────────────────

test('the agent review is the released review@v1 action, after the visual job', () => {
  assert.ok(triage, 'no testivai/testivai-oss/review step in the agent-review job');
  assert.equal(triage.uses, 'testivai/testivai-oss/review@v1');
  assert.equal(agentReview.needs, 'visual');
  // Check out (Claude reads the code; the action reads .testivai/config.json),
  // download the report, triage. Nothing else: no install, no own script.
  assert.deepEqual(
    agentReview.steps.map((s) => String(s.uses).split('@')[0]),
    ['actions/checkout', 'actions/download-artifact', 'testivai/testivai-oss/review'],
  );
});

test('the Claude credentials come from repository secrets', () => {
  assert.equal(triage.with['anthropic-api-key'], '${{ secrets.ANTHROPIC_API_KEY }}');
  assert.equal(triage.with['claude-code-oauth-token'], '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}');
  // An unknown input is silently ignored by GitHub, so a typo would go unseen.
  const inputs = ['anthropic-api-key', 'claude-code-oauth-token', 'github-token', 'enabled', 'allowed-bots', 'model', 'max-turns'];
  for (const key of Object.keys(triage.with)) assert.ok(inputs.includes(key), `review@v1 has no input "${key}"`);
});

test('the agent review comments with the default token, not the approve token', () => {
  // review@v1 updates only its own comment by github-actions[bot]; a PAT
  // (like the approve step's TESTIVAI_APPROVE_TOKEN) would post a new one on every push.
  assert.ok(
    [undefined, '${{ github.token }}'].includes(triage.with['github-token']),
    `review@v1 github-token is ${triage.with['github-token']}: leave it at the default`,
  );
});

test('the agent review can read the code and comment, nothing more', () => {
  assert.deepEqual(agentReview.permissions, { contents: 'read', 'pull-requests': 'write' });
});

test('a newer push to the PR cancels the triage of an older one', () => {
  assert.match(agentReview.concurrency.group, /\$\{\{ github\.event\.pull_request\.number \}\}/);
  assert.notEqual(agentReview.concurrency.group, workflow.concurrency.group);
  assert.equal(agentReview.concurrency['cancel-in-progress'], true);
});

test('the report is downloaded where the action reads it, and a missing one does not fail the job', () => {
  // review@v1 reads .testivai/config.json reportDir, else visual-report.
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, '.testivai/config.json'), 'utf8'));
  assert.ok(download, 'no download-artifact step in the agent-review job');
  assert.equal(download.with.name, reporter.with['artifact-name'] ?? 'testivai-visual-report', 'not the artifact the reporter uploads');
  assert.equal(download.with.path, config.reportDir || 'visual-report');
  assert.equal(reporter.with['report-dir'] ?? 'visual-report', download.with.path, 'the reporter uploads a different report dir');
  assert.equal(download['continue-on-error'], true);
  // continue-on-error also hides a reporter that stopped uploading: the review
  // would then skip on every PR with the job green. Check it still uploads.
  assert.notEqual(String(reporter.with['upload-artifact'] ?? 'true'), 'false', 'the reporter must upload the report the review reads');
});

test('nothing runs the old in-repo review script, and it is gone', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'scripts/testivai-review.cjs')), 'scripts/testivai-review.cjs still exists');
  // Not from any job in any workflow, nor from a package.json script.
  for (const file of fs.readdirSync(path.join(ROOT, '.github/workflows'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8'), /testivai-review\.cjs/, file);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /testivai-review\.cjs/, 'package.json scripts');
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

test('the README describes the agent review as review@v1, not the removed script', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const section = readme.match(/## Agent review in CI[\s\S]*?(?=\n## |$)/)?.[0] ?? '';
  assert.ok(section, 'README has no "Agent review in CI" section');
  assert.match(section, /testivai\/testivai-oss\/review@v1/);
  assert.match(section, /docs\/github-action\.md#ai-triage-of-every-diff/);
  for (const secret of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'enabled: false']) assert.ok(section.includes(secret), secret);
  assert.doesNotMatch(readme, /testivai-review\.cjs/);
});

// review@v1 triages missing baselines since action v1.2.0 (testivai-oss#193):
// a committed baseline that got no capture this run starts a triage too.

// Prose wraps anywhere: compare it with line breaks collapsed.
const prose = (text) => text.replace(/\s+/g, ' ');
// The sentence holding `pattern`, up to a period that ends a sentence (not
// the one in `visual.yml`).
const sentenceWith = (text, pattern) =>
  text.split(/(?<=\.)\s+/).find((sentence) => pattern.test(sentence)) ?? '';

test('the README says the review triages missing baselines, and how to accept a removal', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const section = prose(readme.match(/## Agent review in CI[\s\S]*?(?=\n## |$)/)?.[0] ?? '');
  assert.ok(section, 'README has no "Agent review in CI" section');
  assert.doesNotMatch(section, /missing baselines?[^.]*not triaged/i);
  assert.match(sentenceWith(section, /On every pull request/), /changed or new snapshot or a missing baseline/i);
  assert.match(sentenceWith(section, /one of four verdicts/), /each missing baseline/i);
  // tests/visual.spec.ts names every page, so deleting a page but keeping its
  // test captures a blank page: a changed snapshot, not a missing baseline.
  const what = sentenceWith(section, /A missing baseline is/);
  assert.ok(what.includes('tests/visual.spec.ts'), 'say which test a missing baseline lost');
  assert.match(what, /renamed/i);
  assert.doesNotMatch(what, /page was removed/i, 'deleting a page alone gives a changed snapshot here');
  assert.match(sentenceWith(section, /keeping its test/i), /changed snapshot/i);
  // The report cannot tell a skipped test from a failed one: the rubric points to the log.
  assert.match(section, /possible bug[^.]*test run's log/i);
  // A rule of the triage rubric, not something the action enforces.
  assert.match(section, /never to call one a glitch/i);
  const skip = sentenceWith(section, /\bskips\b/);
  assert.ok(skip, 'README does not say when the review skips');
  assert.match(skip, /when nothing is changed, new or missing/i);
  assert.doesNotMatch(skip, /no snapshot is changed or new/i, 'a missing baseline alone starts a triage');
  // `/testivai approve` only promotes a new capture; a missing baseline has none.
  const removal = sentenceWith(section, /approving does nothing/i);
  assert.ok(removal, 'README does not say that approving does nothing for a missing baseline');
  assert.ok(removal.includes('git rm -r .testivai/baselines/<name>'), 'README does not say how to accept an intended removal');
  // Without taking the test out, the blank capture is new and main adopts it as the baseline.
  assert.ok(removal.includes('tests/visual.spec.ts'), 'accepting a removal takes the test out too');
});

test('missing baselines are triaged here, in the default baselines directory', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, '.testivai', 'config.json'), 'utf8'));
  // With failOnMissing: false, review@v1 leaves missing baselines out.
  assert.notEqual(config.failOnMissing, false, 'failOnMissing: false turns off the missing-baseline triage: update the README and the agent-review comment in visual.yml');
  // The README's removal command names .testivai/baselines, where an unset or
  // empty baselinesDir resolves (witness resolveBaselinesDir).
  const dir = config.baselinesDir ? path.posix.normalize(config.baselinesDir) : '.testivai/baselines';
  assert.equal(dir, '.testivai/baselines', 'another baselinesDir changes the README\'s git rm -r .testivai/baselines/<name>');
});

test('the agent-review job comment says missing baselines are triaged', () => {
  const text = fs.readFileSync(path.join(ROOT, '.github/workflows/visual.yml'), 'utf8');
  const job = text.match(/^ {2}agent-review:\n[\s\S]*?(?=^ {2}[\w-]+:\s*$)/m)?.[0] ?? '';
  assert.ok(job, 'no agent-review job in visual.yml');
  // The comment block under the job's name, read as prose.
  const header = prose((job.match(/^ {4}name:.*\n((?: {4}#.*\n)+)/m)?.[1] ?? '').replace(/^ *# ?/gm, ''));
  assert.ok(header, 'the agent-review job has no comment under its name');
  assert.doesNotMatch(header, /missing baselines?[^.]*not triaged/i);
  assert.match(header, /each missing baseline/i);
  const skip = sentenceWith(header, /\bskips\b/);
  assert.match(skip, /when nothing is changed, new or missing/i);
  assert.doesNotMatch(skip, /no snapshot is changed or new/i, 'a missing baseline alone starts a triage');
});
