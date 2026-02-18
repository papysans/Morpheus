import { expect, test } from '@playwright/test'

test('open home', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '创作项目' })).toBeVisible()
})
