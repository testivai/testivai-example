import { test } from '@playwright/test';
import { witness } from '@testivai/witness-playwright';

// One snapshot per file so Playwright's file-level sharding actually
// distributes work. Distinct viewports make each screenshot genuinely
// different rather than a duplicate blob.
test('buttons looks correct', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await witness(page, testInfo, 'shard-buttons');
});
