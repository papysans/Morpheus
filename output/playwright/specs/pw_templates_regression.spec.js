const { test, expect } = require('@playwright/test');

const WEB_BASE = 'http://localhost:3002';
const API_BASE = 'http://localhost:8000/api';

test('template flow regression', async ({ page, request }) => {
  const stamp = Date.now();
  const projectName = `模板回归-${stamp}`;
  let projectId = null;

  try {
    await page.goto(WEB_BASE);
    await expect(page.getByRole('heading', { name: '创作项目' })).toBeVisible();

    await page.getByRole('button', { name: '新建项目' }).click();
    const modal = page.locator('.modal-card').first();
    await expect(modal).toBeVisible();

    const templateSelect = modal.locator('select').first();
    await templateSelect.selectOption('serial-gintama');
    await expect(modal.getByText('单元剧日常 + 季度主线并行', { exact: false })).toBeVisible();
    await modal.getByRole('button', { name: '应用模板建议' }).click();

    const targetLengthInput = modal.locator('input[type="number"]').first();
    await expect(targetLengthInput).toHaveValue('320000');

    await modal.getByLabel('项目名称').fill(projectName);
    await modal.getByLabel('题材').fill('太空歌剧');
    await modal.getByLabel('文风契约').fill('冷峻现实主义');
    await modal.getByRole('button', { name: '创建项目' }).click();
    await expect(modal).toHaveCount(0);

    const projectCard = page.locator('.project-card', { hasText: projectName }).first();
    await expect(projectCard).toBeVisible({ timeout: 15000 });
    await projectCard.locator('h2').click();

    await expect(page).toHaveURL(/\/project\//);
    const match = page.url().match(/\/project\/([^/?#]+)/);
    if (!match) throw new Error(`Cannot parse project id from ${page.url()}`);
    projectId = match[1];

    await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
    await page.screenshot({
      path: `output/playwright/template_regression_01_detail_${stamp}.png`,
      fullPage: true,
    });

    const projectRes = await request.get(`${API_BASE}/projects/${projectId}`);
    expect(projectRes.ok()).toBeTruthy();
    const projectPayload = await projectRes.json();
    expect(projectPayload.template_id).toBe('serial-gintama');

    await page.locator('.sidebar').getByRole('link', { name: '创作控制台' }).click();
    await expect(page.getByRole('heading', { name: '创作控制台' })).toBeVisible();
    await expect(page.getByRole('button', { name: '套用项目模板' })).toBeVisible();
    await page.screenshot({
      path: `output/playwright/template_regression_02_console_${stamp}.png`,
      fullPage: true,
    });

    const sourceRes = await request.get(
      `${API_BASE}/projects/${projectId}/memory/source?source_path=memory/L1/IDENTITY.md`,
    );
    expect(sourceRes.ok()).toBeTruthy();
    const sourceContent = await sourceRes.text();
    expect(sourceContent).toContain('## Story Template');
    expect(sourceContent).toContain('## Template Rules');
  } finally {
    if (projectId) {
      await request.delete(`${API_BASE}/projects/${projectId}`);
    }
  }
});
