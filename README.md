# TestivAI Example

A small, complete example of [TestivAI](https://github.com/testivai/testivai-oss):
open-source, local-first visual regression testing, guarding a three-page
static site. It includes an MCP server, so AI coding agents can read the
results too.

> 👀 **[See the live report →](https://testivai.github.io/testivai-example/)**: CI
> applies three deliberate changes to the site on every push to `main` and
> publishes what TestivAI makes of them. No install, no signup.
> ([This branch's own run against the committed baselines →](https://testivai.github.io/testivai-example/main/))

## Three changes, three verdicts

A pixel diff tells you *that* something changed. TestivAI pairs each
screenshot with a DOM snapshot and a computed-style digest per element, so it
can tell you *what kind* of change it was. `npm run demo` applies one change to
each page ([`demo/changes.mjs`](./demo/changes.mjs)) and diffs it against the
untouched site:

| Snapshot | The change | TestivAI's verdict |
|---|---|---|
| `home` | a promo banner inserted above the content | **Layout shift**: everything below y=N moved down together, the moved elements themselves are unchanged. Look above that line. |
| `buttons` | pill-shaped, violet buttons via CSS only | **Style-only change**: N elements restyled with identical DOM (`button.btn…`). Real, not noise. |
| `products` | one product card missing from the grid | **Structural change**: the DOM differs (nodes removed); nothing else moved. |

Every verdict comes from deterministic comparison: the same input gives the
same output, with no model and no network involved. `npm run test:demo`
asserts all three, in `results.json` and over MCP, so the example can't
quietly drift into showing fewer.

The page clock (`#clock`) changes on every load. `ignoreSelectors` in
[`.testivai/config.json`](./.testivai/config.json) keeps it out of every diff.

## What's here

- [`site/`](./site): Acme Storefront, three pages sharing one stylesheet
- [`tests/visual.spec.ts`](./tests/visual.spec.ts): one `witness()` call per page
- [`.testivai/baselines/`](./.testivai/baselines): committed reference screenshots, DOM and element maps
- [`demo/`](./demo): the three demo changes, the runner, and their tests
- [`.mcp.json`](./.mcp.json): the [`@testivai/mcp`](https://www.npmjs.com/package/@testivai/mcp) server, for Claude Code and other MCP clients
- [`AGENTS.md`](./AGENTS.md): visual-verification rules for agents
- [`.github/workflows/visual.yml`](./.github/workflows/visual.yml): PR diff comments, the Claude agent review, `/testivai approve`, and the demo check
- [`.github/workflows/deploy-report.yml`](./.github/workflows/deploy-report.yml): publishes both reports to Pages

## Run it

```bash
npm ci
npx playwright install chromium
npm test           # capture + compare against .testivai/baselines → visual-report/
npm run demo       # three changes, three verdicts → demo-report/
npm run test:demo  # assert the demo's verdicts (report + MCP)
```

Open `visual-report/index.html` or `demo-report/index.html`. The demo works in
a scratch `.demo/` workspace and never touches the committed baselines.

## Review with an AI agent (MCP)

[`.mcp.json`](./.mcp.json) registers `@testivai/mcp` for this project, so
Claude Code offers it when you open the repo. Elsewhere:
`claude mcp add testivai -- npx -y @testivai/mcp`, or the same command in
your client's MCP config.

Run the tests, then ask *"what changed visually?"*, or type
`/testivai:review-visual-changes`. The agent gets the same evidence as the
report:

- `get_visual_results`: a one-line verdict per snapshot (after a group summary when several share an identical signal), then the paths to open: the report, each changed snapshot's diff image and each new snapshot's capture
- `explain_snapshot`: regions, the selectors they belong to, the page shift, and the DOM/style signal
- `get_diff`: the baseline, current and diff images, for the agent to look at

To try it on the demo, point the server at its workspace:
`npx -y @testivai/mcp --root .demo` after `npm run demo`.

Approving is a human decision. The `approve_snapshot` / `approve_all` tools
ask you to confirm every call in Claude Code (v2.1.214 or later; other
clients apply their own approval settings); commit `.testivai/baselines/`
afterwards.

## Agent review in CI

On every pull request with a changed or new snapshot, the `Agent review` job
in [`visual.yml`](./.github/workflows/visual.yml) runs
[`testivai/testivai-oss/review@v1`](https://github.com/testivai/testivai-oss/blob/main/docs/github-action.md#ai-triage-of-every-diff).
Claude ([`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action))
reads the report through the TestivAI MCP server, looks at the baseline,
current and diff images, reads the PR's diff, and sorts each changed or new
snapshot into one of four verdicts: **glitch** (the page did not really
change), **intended change**, **bug** or **possible bug**. The action posts
the result as one PR comment, updated in place on each push:

| Snapshot | Verdict | Confidence | Evidence | Next step |
|---|---|---|---|---|
| `home` | 🟢 intended change | high | New `div.promo` banner at the top of `main` in `site/index.html`; everything below y=203 moved down 73px, unchanged. | `/testivai approve home` |

It is advisory: it never changes the `TestivAI / visual` check or a
baseline. Claude only gets read-only tools; `approve_snapshot` and
`approve_all` are disallowed, and so are commands, edits and the network.
Approving stays a human `/testivai approve` comment.

To turn it on, add **one** repository secret: `ANTHROPIC_API_KEY`, or
`CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, for a Claude
subscription). It skips in seconds, using no tokens, when neither secret is
set (with a notice), when no snapshot is changed or new, and on PRs from
forks, since forks get no secrets. Missing baselines (a removed or renamed
snapshot) are not triaged: TestivAI's diff comment lists them. To turn it
off, set `enabled: false` on the step.

## On a pull request

CI posts the diff as a comment and reports a `TestivAI / visual` check. When
a page **changed**, the check fails until someone approves the new look with
a comment on the PR:

```
/testivai approve --all
```

or approve one page: `/testivai approve home`. The approve job commits the
baselines to the PR branch, and the visual check runs again on that commit.

A **new** page (no baseline yet) doesn't fail the check and needs nothing:
after the merge, the run on `main` adopts its CI capture as the baseline and
commits it ([`scripts/adopt-new-baselines.mjs`](./scripts/adopt-new-baselines.mjs)).
It only ever adds folders for snapshots that had none, and refuses to commit
if anything else changed, so a changed page always needs the approve comment.

### Block the merge until changes are approved

The failing check only blocks a merge once a branch rule requires it. In
**Settings → Rules → Rulesets** (or **Branches**), add a rule for `main` that
requires the status check `TestivAI / visual`.

GitHub starts no workflow for a push made with the default `GITHUB_TOKEN`, so
after an approve the job starts the visual workflow on the PR branch itself.
That updates the check and the commit status; the diff comment updates on the
next push. To have the approve commit re-run the whole PR workflow instead,
add a `TESTIVAI_APPROVE_TOKEN` repository secret: a fine-grained personal
access token for this repository only, with **Contents: read and write**,
**Pull requests: read and write** and **Actions: read**. The baseline commit
is still authored as `github-actions[bot]`, but it is pushed, and the reply
posted, as the token's owner.

Baselines are rendered by CI (Linux), not on your machine, so fonts and
anti-aliasing match the runner that checks them.

MIT · no account · nothing leaves your machine.
