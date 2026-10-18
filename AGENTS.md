# Agent instructions

## Visual verification

After changing anything under `site/`, run `npm test`, then check the visual
results: through the `testivai` MCP server (`get_visual_results`, then
`explain_snapshot` for each change) or by reading `visual-report/results.json`:

- `status: "changed"` + `sizeMismatch`: the capture is a different size from the baseline, so no tolerance passes it. A width change is the viewport or device scale, not the page. A height change with `dom.changed: true` is content added or removed (with `pageShift`, above `pageShift.belowY`); with an identical DOM nothing was added or removed: the same content laid out taller or shorter (restyled, when `dom.styleCheck` is `"mismatch"`; otherwise often fonts or rendering that differ between machines), so look at the diff
- `status: "changed"` + `dom.changed: false` + `dom.styleCheck: "mismatch"`: style-only change; real, not noise
- `status: "changed"` + `pageShift`: content was inserted or removed above `pageShift.belowY`
- `status: "changed"` + `dom.changed: true`: structural change; compare it against the task
- `status: "changed"` + `dom.noiseHint: true` + `dom.styleCheck: "match"`: likely render noise only when the diff is also small and scattered (at most 1% of pixels, and no regions or regions spread over more than a third of the page); mention it, don't block on it. A diff in one area, or a larger one, is a bad capture or a change the style check doesn't cover (size, overflow, transform, images): look at the diff and don't call it noise. The MCP verdicts already apply this rule
- `status: "changed"` + `dom.noiseHint: true` + `dom.styleCheck` `"unavailable"` or missing: styles not compared; could be render noise or a stylesheet-only change, so look at the diff and don't call it noise
- `status: "new"`: no baseline yet; tell the human

Report what changed and whether it matches the task. Never approve baselines
yourself (`testivai approve`, `approve_snapshot`, `approve_all`): approval is a
human decision.

If you change `site/`, also run `npm run test:demo`. The demo edits in
`demo/changes.mjs` match the site's markup exactly and fail loudly when it
moves.
