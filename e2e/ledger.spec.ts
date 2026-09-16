import { test, expect } from '@playwright/test';
test('the ledger can author, edit, switch and import real persisted state', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?view=rules');
  await expect(page.getByRole('heading', { name: 'Your rules, reflected.' })).toBeVisible();
  await expect(page.getByText('Demo workspace', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/ledger-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Add a rule', exact: true }).click();
  await page
    .getByLabel('Rule instruction')
    .fill('When the same lookup tool fails twice, verify its source.');
  await page.getByRole('button', { name: 'Draft rule', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Draft rule added');
  const select = page.getByLabel(
    'Status for When the same lookup tool fails twice, verify its source.',
  );
  await expect(select).toHaveValue('shadow');
  await select.selectOption('active');
  await expect(page.getByRole('status')).toContainText('Rule status saved');
  await page.reload();
  await expect(select).toHaveValue('active');
  await page
    .getByRole('button', { name: 'Open When the same lookup tool fails twice, verify its source.' })
    .click();
  const editor = page.getByLabel('Rule JSON');
  const value = JSON.parse(await editor.inputValue());
  value.rollout = 25;
  value.notes = 'Reviewed in browser test';
  await editor.fill(JSON.stringify(value, null, 2));
  await page.getByRole('button', { name: 'Save to mirrors.yaml' }).click();
  await expect(page.getByRole('status')).toContainText('Rule changes saved');
  await page.getByRole('button', { name: 'Close rule' }).click();
  await page.getByRole('button', { name: 'mirrors.yaml', exact: true }).click();
  await expect(page.locator('pre')).toContainText('Reviewed in browser test');
  await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await page.getByRole('button', { name: 'Import prompt', exact: true }).click();
  await page
    .getByLabel('System prompt')
    .fill('When a PDF has no text, wait for extraction before searching again.');
  await page.getByRole('button', { name: 'Import candidates' }).click();
  await expect(page.getByRole('status')).toContainText('Prompt imported');
  await page.getByRole('button', { name: 'Weekly digest', exact: true }).click();
  await expect(page.locator('.digest pre')).toBeVisible();
  expect(errors).toEqual([]);
});
test('small-screen ledger remains usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?view=rules');
  await expect(page.getByRole('button', { name: 'Add a rule', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/ledger-mobile.png', fullPage: true });
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.viewport);
});

test('human review records a decision in the local queue', async ({ page, request }) => {
  const instruction = 'Before publishing the browser-test artifact, request human review.';
  const added = await (await request.post('/api/rules', { data: { text: instruction } })).json();
  const state = await (await request.get('/api/state')).json();
  await request.patch('/api/rules/' + added.id, {
    data: {
      revision: state.revision,
      patch: {
        status: 'active',
        rollout: 100,
        condition: { type: 'code', when: { field: 'proposed.tool', op: 'eq', value: 'publish' } },
        actions: [{ type: 'human', reason: 'Review artifact' }],
      },
    },
  });
  const decision = await (
    await request.post('/api/evaluate', {
      data: {
        session_id: 'review-browser-run',
        model: 'test',
        step: 0,
        phase: 'tool',
        proposed: { tool: 'publish', args: {}, status: 'unknown' },
      },
    })
  ).json();
  expect(decision.blocked).toBe(true);
  await page.goto('/?view=rules');
  await page.getByRole('button', { name: 'Human review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Human review queue' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.locator('.full-event').filter({ hasText: 'review-browser-run' })).toContainText(
    'approved',
  );
});
