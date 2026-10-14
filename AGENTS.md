# Agent instructions

## Visual verification

After changing anything under `site/`, run `npm test`, then check the visual
results: through the `testivai` MCP server (`get_visual_results`, then
`explain_snapshot` for each change) or by reading `visual-report/results.json`:

- `status: "changed"` + `dom.changed: false` + `dom.styleCheck: "mismatch"`: style-only change; real, not noise
- `status: "changed"` + `pageShift`: content was inserted or removed above `pageShift.belowY`
- `status: "changed"` + `dom.changed: true`: structural change; compare it against the task
- `status: "changed"` + `dom.noiseHint: true` + `dom.styleCheck: "match"`: likely render noise; mention it, don't block on it
- `status: "changed"` + `dom.noiseHint: true` + `dom.styleCheck` `"unavailable"` or missing: styles not compared; could be render noise or a stylesheet-only change, so look at the diff and don't call it noise
- `status: "new"`: no baseline yet; tell the human

Report what changed and whether it matches the task. Never approve baselines
yourself (`testivai approve`, `approve_snapshot`, `approve_all`): approval is a
human decision.

If you change `site/`, also run `npm run test:demo`. The demo edits in
`demo/changes.mjs` match the site's markup exactly and fail loudly when it
moves.
