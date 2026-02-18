const { test, expect } = require('@playwright/test');

const WEB_BASE = 'http://localhost:3002';
const API_BASE = 'http://localhost:8000/api';

async function createProjectFromModal(page, name) {
  await page.goto(WEB_BASE);
  await page.getByRole('button', { name: '新建项目' }).click();

  const modal = page.locator('.modal-card');
  await expect(modal).toBeVisible();

  await modal.locator('input').first().fill(name);

  const genreInput = modal.locator('input[list="project-genre-options"]');
  await genreInput.fill('太空歌剧');
  await expect(genreInput).toBeFocused();

  const styleInput = modal.locator('label:has-text("文风契约") input');
  await styleInput.fill('冷峻现实主义');
  await expect(styleInput).toBeFocused();

  await modal.getByRole('button', { name: '创建项目' }).click();
  await expect(page.locator('.modal-card')).toHaveCount(0);

  const heading = page.locator('.project-card h2', { hasText: name }).first();
  await expect(heading).toBeVisible({ timeout: 15000 });
  await heading.click();

  await expect(page).toHaveURL(/\/project\//);
  const match = page.url().match(/\/project\/([^/?#]+)/);
  if (!match) throw new Error(`Cannot parse project id from url: ${page.url()}`);
  return match[1];
}

test('system bugfix regression', async ({ page, request }) => {
  const ts = Date.now();
  const nameA = `PW系统除虫-${ts}-A`;
  const nameB = `PW系统除虫-${ts}-B`;
  const created = [];

  // A 项目：验证路由切换后的项目上下文
  const projectA = await createProjectFromModal(page, nameA);
  created.push(projectA);

  await expect(page.getByRole('heading', { name: nameA })).toBeVisible();
  await page.locator('.sidebar').getByRole('link', { name: '创作控制台' }).click();
  await expect(page.getByRole('heading', { name: '创作控制台' })).toBeVisible();
  await expect(page.locator('.writing-header__sub')).toContainText(nameA);
  await page.screenshot({ path: 'output/playwright/system_bugfix_01_write_project_a.png', fullPage: true });

  // B 项目：再进入，防止复用 A 的 currentProject
  const projectB = await createProjectFromModal(page, nameB);
  created.push(projectB);

  await expect(page.getByRole('heading', { name: nameB })).toBeVisible();
  await page.locator('.sidebar').getByRole('link', { name: '创作控制台' }).click();
  await expect(page.getByRole('heading', { name: '创作控制台' })).toBeVisible();
  await expect(page.locator('.writing-header__sub')).toContainText(nameB);
  await expect(page.locator('.writing-header__sub')).not.toContainText(nameA);
  await page.screenshot({ path: 'output/playwright/system_bugfix_02_write_project_b.png', fullPage: true });

  // 回到项目详情，验证章节编号输入可清空重输
  await page.goto(`${WEB_BASE}/project/${projectB}`);
  await page.getByRole('button', { name: '新建章节' }).click();
  const chapterModal = page.locator('.modal-card');
  const chapterNumberInput = chapterModal.locator('input[type="number"]');

  await chapterNumberInput.fill('');
  await expect(chapterNumberInput).toHaveValue('');
  await chapterNumberInput.fill('8');
  await expect(chapterNumberInput).toHaveValue('8');

  await chapterModal.locator('input.input').nth(1).fill('第一章');
  await chapterModal.locator('textarea').fill('用于回归测试的一章');
  await chapterModal.getByRole('button', { name: '创建并进入' }).click();

  await page.getByRole('link', { name: '进入工作台' }).first().click();
  await expect(page.getByRole('heading', { name: /第\s*\d+\s*章/ })).toBeVisible();

  const oneShotCard = page.locator('.card-strong').filter({ hasText: '一句话整篇' });
  const oneShotWordsInput = oneShotCard.locator('input[type="number"]');
  await expect(oneShotWordsInput).toBeVisible();
  await oneShotWordsInput.fill('');
  await expect(oneShotWordsInput).toHaveValue('');
  await oneShotWordsInput.fill('2200');
  await expect(oneShotWordsInput).toHaveValue('2200');
  await page.screenshot({ path: 'output/playwright/system_bugfix_03_number_inputs.png', fullPage: true });

  // 删除后访问详情：不应继续显示项目子导航
  const delResp = await request.delete(`${API_BASE}/projects/${projectB}`);
  expect(delResp.ok()).toBeTruthy();

  await page.goto(`${WEB_BASE}/project/${projectB}`);
  await expect(page.getByText(/项目不存在或加载失败|Project not found/)).toBeVisible();
  await expect(page.locator('.sidebar').getByText('项目概览')).toHaveCount(0);
  await page.screenshot({ path: 'output/playwright/system_bugfix_04_not_found_sidebar.png', fullPage: true });

  // 清理
  for (const projectId of created) {
    await request.delete(`${API_BASE}/projects/${projectId}`);
  }
});
