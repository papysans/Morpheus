const { test, expect } = require('@playwright/test');

test('open home', async ({ page }) => {
  await page.goto('http://localhost:3002');
  await expect(page.getByRole('heading', { name: '创作项目' })).toBeVisible();
});
