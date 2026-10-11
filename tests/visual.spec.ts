import { test } from '@playwright/test';
import { witness } from '@testivai/witness-playwright';

// One page per snapshot: witness() captures the full page, so three
// snapshots of one page would be three copies of the same capture.
test.describe('Acme Storefront visuals', () => {
  test('home', async ({ page }, testInfo) => {
    await page.goto('/');
    await witness(page, testInfo, 'home');
  });

  test('buttons', async ({ page }, testInfo) => {
    await page.goto('/buttons.html');
    await witness(page, testInfo, 'buttons');
  });

  test('products', async ({ page }, testInfo) => {
    await page.goto('/products.html');
    await witness(page, testInfo, 'products');
  });
});
