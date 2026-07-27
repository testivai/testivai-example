import { test } from '@playwright/test';
import { witness } from '@testivai/witness-playwright';

test.describe('Acme Storefront visuals', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('full page', async ({ page }, testInfo) => {
    await witness(page, testInfo, 'home');
  });

  test('buttons', async ({ page }, testInfo) => {
    await page.locator('#buttons').scrollIntoViewIfNeeded();
    await witness(page, testInfo, 'buttons');
  });

  test('products', async ({ page }, testInfo) => {
    await page.locator('#products').scrollIntoViewIfNeeded();
    await witness(page, testInfo, 'products');
  });
});
