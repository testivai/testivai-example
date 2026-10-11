// The demo's three deliberate changes: one per snapshot, each a different
// kind of diff. `npm run demo` applies them to a copy of site/ and diffs it
// against a baseline of the untouched site, so the report shows what
// TestivAI makes of each kind.
import fs from 'node:fs';
import path from 'node:path';

export const CHANGES = [
  {
    snapshot: 'home',
    kind: 'layout-shift',
    summary: 'A promo banner is inserted above the content. Everything below it moves down, unchanged.',
    edits: [
      {
        file: 'index.html',
        find: '  <main>\n    <section id="featured">',
        replace:
          '  <main>\n' +
          '    <div class="promo" style="background:#fff7d6;border:1px solid #f2d675;color:#7a5b00;border-radius:10px;padding:14px 16px;margin-bottom:26px;font-size:14px;font-weight:600">' +
          'Free shipping on every order this week</div>\n' +
          '    <section id="featured">',
      },
    ],
  },
  {
    snapshot: 'buttons',
    kind: 'style-only',
    summary: 'The button styles change (pill shape, violet primary). No markup changes.',
    edits: [
      { file: 'styles.css', find: '.btn { padding:10px 20px; border-radius:8px;', replace: '.btn { padding:10px 20px; border-radius:999px;' },
      { file: 'styles.css', find: '.btn-primary { background:var(--brand);', replace: '.btn-primary { background:#7c3aed;' },
    ],
  },
  {
    snapshot: 'products',
    kind: 'structural',
    summary: 'A product card disappears from the grid, as if the product feed dropped it.',
    edits: [
      {
        file: 'products.html',
        find: '        <div class="card"><div class="thumb t6"></div><div class="body"><h3>Citrus Plant Pot</h3><p>Something green next to the monitor.</p><div class="price">$22</div></div></div>\n',
        replace: '',
      },
    ],
  },
];

/**
 * Apply `changes` in place to the site copy at `siteDir`. Every edit must
 * match exactly once: a site edit that moves a target throws here rather
 * than producing a demo that quietly shows fewer than three verdicts.
 */
export function applyChanges(siteDir, changes = CHANGES) {
  for (const change of changes) {
    for (const edit of change.edits) {
      const file = path.join(siteDir, edit.file);
      const source = fs.readFileSync(file, 'utf8');
      const found = source.split(edit.find).length - 1;
      if (found !== 1) {
        throw new Error(`${change.snapshot}: expected exactly 1 match in ${edit.file}, found ${found}: ${JSON.stringify(edit.find.slice(0, 60))}`);
      }
      fs.writeFileSync(file, source.replace(edit.find, () => edit.replace));
    }
  }
}
