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
- [`.github/workflows/visual.yml`](./.github/workflows/visual.yml): PR diff comments, `/testivai approve`, and the demo check
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

- `get_visual_results`: a one-line verdict per snapshot
- `explain_snapshot`: regions, the selectors they belong to, the page shift, and the DOM/style signal
- `get_diff`: the baseline, current and diff images, for the agent to look at

To try it on the demo, point the server at its workspace:
`npx -y @testivai/mcp --root .demo` after `npm run demo`.

Approving is a human decision. The `approve_snapshot` / `approve_all` tools
ask you to confirm every call in Claude Code; commit `.testivai/baselines/`
afterwards.

## On a pull request

CI posts the diff as a comment. Approve the new baselines with:

```
/testivai approve --all
```

Baselines are rendered by CI (Linux), not on your machine, so fonts and
anti-aliasing match the runner that checks them.

MIT · no account · nothing leaves your machine.
