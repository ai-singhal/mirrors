import { test, expect } from '@playwright/test';
test('top patterns, release diff, fix tracking and conversation labels work end to end', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Know what broke. Prove what changed.' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Top failure patterns' })).toBeVisible();
  await page.screenshot({ path: 'test-results/overview-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Release health', exact: true }).click();
  await expect(page.getByLabel('Current version')).toHaveValue('release-2');
  await expect(page.getByText('regression', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Worst run', exact: true }).first().click();
  await expect(page.getByText('CONVERSATION EVIDENCE', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Agree', exact: true }).first().click();
  await expect(page.getByRole('status')).toContainText('Sample label saved');
  await page.getByLabel('Close conversation').click();
  await page.getByRole('button', { name: 'Track a fix', exact: true }).click();
  await page.getByLabel('Fix description').fill('Browser-tested source correction');
  await page.getByLabel('Fix source').fill('example-commit');
  await page.getByLabel('Fix version', { exact: true }).selectOption('release-2');
  await page.getByRole('button', { name: 'Track fix', exact: true }).click();
  await expect(page.getByText('Browser-tested source correction', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Fixes', exact: true }).click();
  await expect(page.getByLabel('Fix status for Browser-tested source correction')).toHaveValue(
    'shipped',
  );
  await page.getByRole('button', { name: 'Cheap replay', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Diverged is a result.' })).toBeVisible();
  expect(errors).toEqual([]);
});
test('measurement UI has no horizontal page overflow on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Top failure patterns' })).toBeVisible();
  await page.screenshot({ path: 'test-results/overview-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
