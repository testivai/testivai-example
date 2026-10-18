// Trial only (testivai/testivai-oss#213): checks the live GitHub Pages site for
// this pull request, from a GitHub runner. Waits until the TestivAI comment
// links this commit's published report, then checks on the real host:
//   - every site link in the comment answers 200, and each #snap- target
//     exists on its page;
//   - the report, the pull request's page and the front page load in Chromium
//     with every image, no CSP violation and no script error;
//   - a folder without its slash redirects to it; a missing page is the 404.
// Prints what it finds; exits 1 on any problem. Screenshots go to shots/.
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const SITE = 'https://testivai.github.io/testivai-example/';
const { GITHUB_REPOSITORY: REPO, PR, SHA, GH_TOKEN } = process.env;
const api = (p) =>
  fetch(`https://api.github.com/repos/${REPO}/${p}`, { headers: { authorization: `Bearer ${GH_TOKEN}`, accept: 'application/vnd.github+json' } }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const say = (line) => console.log(line);

// 1. The comment, once it links the report of a run on this commit.
let body;
let reportUrl;
const deadline = Date.now() + 20 * 60_000;
while (Date.now() < deadline) {
  const comments = await api(`issues/${PR}/comments?per_page=100`);
  const c = Array.isArray(comments) ? comments.find((x) => x.body?.includes('<!-- testivai-visual-report -->')) : undefined;
  const link = c && /\*\*\[Open the visual report\]\((https:[^)\s]+)\)\*\*/.exec(c.body);
  const runId = c && /<!-- testivai-run:(\d+)-\d+ -->/.exec(c.body)?.[1];
  if (link && runId && (await api(`actions/runs/${runId}`)).head_sha === SHA) {
    body = c.body;
    reportUrl = link[1];
    break;
  }
  say(`waiting for the comment to link this commit's report (${new Date().toISOString()})`);
  await sleep(30_000);
}
if (!body) {
  console.error('The TestivAI comment never linked a report of this commit.');
  process.exit(1);
}
say(`\nComment links the report: ${reportUrl}`);
if (!reportUrl.startsWith(`${SITE}pr/${PR}/`)) problems.push(`report link is not under ${SITE}pr/${PR}/: ${reportUrl}`);

// 2. Every site link in the comment.
const links = [...new Set([...body.matchAll(/\]\((https:[^)\s]+)\)/g), ...body.matchAll(/href="(https:[^"]+)"/g)].map((m) => m[1]))];
const browser = await chromium.launch();
fs.mkdirSync('shots', { recursive: true });
for (const link of links) {
  if (!link.startsWith(SITE)) {
    say(`  (not the site) ${link}`);
    continue;
  }
  const [page, hash] = link.split('#');
  const r = await fetch(page);
  say(`  ${r.status} ${link}`);
  if (r.status !== 200) problems.push(`${link} answers ${r.status}`);
  if (hash) {
    const tab = await browser.newPage();
    await tab.goto(link, { waitUntil: 'load' });
    const found = await tab.$(`[id="${hash}"]`);
    say(`      #${hash}: ${found ? 'found on the page' : 'MISSING'}`);
    if (!found) problems.push(`${link}: no element #${hash}`);
    else await tab.screenshot({ path: `shots/anchor-${hash}.png` });
    await tab.close();
  }
}

// 3. The pages themselves, in a browser.
async function check(url, name, viewport = { width: 1280, height: 900 }) {
  const tab = await browser.newPage({ viewport });
  const errors = [];
  tab.on('pageerror', (e) => errors.push(`script error: ${e.message}`));
  tab.on('console', (m) => /Content Security Policy|Refused to/.test(m.text()) && errors.push(m.text()));
  const resp = await tab.goto(url, { waitUntil: 'load' });
  const imgs = await tab.$$eval('img[src]:not([src=""])', (els) => els.map((e) => ({ src: e.getAttribute('src'), ok: e.complete && e.naturalWidth > 0 })));
  const bad = imgs.filter((i) => !i.ok).map((i) => i.src);
  const sideways = await tab.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  say(`  ${resp.status()} ${url} (${viewport.width}px) — "${await tab.title()}", ${imgs.length} images${bad.length ? `, NOT LOADED: ${bad.join(', ')}` : ' loaded'}${errors.length ? `, ${errors.length} errors` : ''}`);
  if (resp.status() !== 200) problems.push(`${url}: ${resp.status()}`);
  if (bad.length) problems.push(`${url}: images not loaded: ${bad.join(', ')}`);
  for (const e of errors) problems.push(`${url}: ${e}`);
  if (sideways) problems.push(`${url} (${viewport.width}px): scrolls sideways`);
  await tab.screenshot({ path: `shots/${name}-${viewport.width}.png`, fullPage: true });
  const text = await tab.textContent('body');
  await tab.close();
  return text;
}
say('\nPages:');
const report = await check(reportUrl, 'report');
await check(reportUrl, 'report', { width: 390, height: 844 });
if (!report.includes(`commit ${SHA.slice(0, 7)}`)) problems.push(`the report page does not name commit ${SHA.slice(0, 7)}`);
const prPage = await check(`${SITE}pr/${PR}/`, 'pr-page');
if (!prPage.includes(`Pull request #${PR}`)) problems.push('the pull request page does not name it');
const front = await check(SITE, 'front');
if (!front.includes(`#${PR}`)) problems.push(`the front page does not list #${PR}`);
await check(`${SITE}main/`, 'main');
await check(`${SITE}demo/`, 'demo');

// 4. Paths: a folder without its slash, and a missing page.
say('\nPaths:');
const noSlash = await fetch(`${SITE}pr/${PR}`, { redirect: 'manual' });
say(`  ${noSlash.status} ${SITE}pr/${PR} → ${noSlash.headers.get('location')}`);
if (![301, 302].includes(noSlash.status) || !noSlash.headers.get('location')?.endsWith(`/pr/${PR}/`)) problems.push(`${SITE}pr/${PR} does not redirect to its slash`);
const missing = await fetch(`${SITE}pr/${PR}/1-1/`);
const missingText = await missing.text();
say(`  ${missing.status} ${SITE}pr/${PR}/1-1/ (never published): ${missingText.includes('no longer published') ? "the action's 404 page" : 'another page'}`);
if (missing.status !== 404 || !missingText.includes('no longer published')) problems.push("a missing report is not the action's 404 page");

await browser.close();
say(problems.length ? `\nPROBLEMS (${problems.length}):\n  ${problems.join('\n  ')}` : '\nNo problems.');
process.exit(problems.length ? 1 : 0);
