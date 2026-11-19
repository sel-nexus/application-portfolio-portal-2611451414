/** Verify live persisted application maintenance, navigation, exports and mobile access. */
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { captureErrors } from './helpers';
import type { ApplicationDetail, ApplicationPage, Session } from '../src/types';

test('maintains all fields, refreshes, enters from portfolio, and downloads matching CSV', async ({ page }) => {
  const errors = captureErrors(page);
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('admin@portfolio.local');
  await page.getByLabel('Password', { exact: true }).fill(process.env.E2E_ADMIN_PASSWORD ?? 'PortalDemo123!');
  const login = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/login'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const session = await (await login).json() as Session;
  if (session.user.mustChangePassword) {
    await page.getByLabel('Current password').fill('PortalDemo123!');
    await page.getByLabel('New password').fill('PortalChanged123!');
    await page.getByLabel('Confirm new password').fill('PortalChanged123!');
    await page.getByRole('button', { name: 'Save password' }).click();
    await expect(page.getByText('Password changed. Other sessions have been signed out.')).toBeVisible();
  }
  await page.getByRole('link', { name: 'Applications', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('link', { name: 'New application' }).click();
  await expect(page.getByLabel('Name', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Name is required')).toBeVisible();
  await expect(page.getByText('Portfolio is required')).toBeVisible();
  const name = `Journey ${Date.now()}`;
  for (const [label, value] of [['Name', name], ['Description', 'Persisted journey description'], ['Product area', 'Commerce'],
    ['Business owner', 'Business test'], ['Technology owner', 'Technology test'], ['Quality owner', 'Quality test'],
    ['Technology stack', 'Python React MongoDB'], ['Repository link', 'https://example.com/repo'], ['Pipeline link', 'https://example.com/build']]) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  await page.getByLabel('Portfolio', { exact: true }).selectOption({ label: 'Payments' });
  for (const [label, value] of [['Criticality', 'Critical'], ['Lifecycle', 'Deprecated'], ['Risk', 'High']]) {
    await page.getByLabel(label, { exact: true }).selectOption(value);
  }
  for (const [label, value] of [['Tier', '4'], ['Health score', '101'], ['Quality score', '100'], ['Automation coverage', '55'],
    ['Unit-test coverage', '75'], ['Open defects', '4'], ['Open critical defects', '2']]) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Enter an integer from 0 to 100')).toBeVisible();
  await page.getByLabel('Health score', { exact: true }).fill('0');
  const created = page.waitForResponse(response => response.url().endsWith('/api/v1/applications') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const createResponse = await created; expect(createResponse.status()).toBe(201);
  const row = await createResponse.json() as ApplicationDetail;
  expect(row.name).toBe(name); expect(row.healthScore).toBe(0); expect(row.qualityScore).toBe(100);
  expect(row.description).toBe('Persisted journey description'); expect(row.openCriticalDefects).toBe(2);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveCount(4);
  await page.reload(); await expect(page.getByText(row.description)).toBeVisible();
  await page.getByRole('link', { name: row.portfolio, exact: true }).click();
  await expect(page.getByRole('heading', { name: row.portfolio, exact: true })).toBeVisible();
  await page.getByRole('link', { name, exact: true }).click();
  await page.getByRole('link', { name: 'Edit application' }).click();
  await page.getByLabel('Description', { exact: true }).fill('Edited persisted description');
  await page.getByLabel('Portfolio', { exact: true }).selectOption({ label: 'Customer Platform' });
  const edited = page.waitForResponse(response => response.url().endsWith(`/applications/${row.id}`) && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await edited).status()).toBe(200); await expect(page.getByText('Edited persisted description')).toBeVisible();
  await page.getByRole('link', { name: 'Back to applications' }).click();
  await page.getByLabel('Search by name').fill(name);
  await page.getByLabel('Risk', { exact: true }).selectOption('High');
  const filtered = page.waitForResponse(response => response.url().includes('/api/v1/applications?')
    && response.url().includes('lifecycle=Deprecated'));
  await page.getByLabel('Lifecycle', { exact: true }).selectOption('Deprecated');
  const matching = await (await filtered).json() as ApplicationPage;
  expect(matching.total).toBe(1); expect(matching.items[0].id).toBe(row.id);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  const download = await downloaded; const path = await download.path(); expect(path).not.toBeNull();
  const text = await readFile(path!, 'utf-8');
  const expected = matching.items.map(item => [item.name, item.portfolio, item.criticality, item.tier, item.lifecycle,
    item.healthScore, item.automationCoverage, item.openCriticalDefects, item.risk].join(','));
  expect(text.trim().split(/\r?\n/)).toEqual([
    'Name,Portfolio,Criticality,Tier,Lifecycle,Health,Automation %,Open Critical Defects,Risk', ...expected,
  ]);
  await page.getByRole('link', { name, exact: true }).click();
  await page.getByRole('button', { name: 'Delete application' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await page.getByRole('button', { name: 'Delete application' }).click();
  const removed = page.waitForResponse(response => response.url().endsWith(`/applications/${row.id}`) && response.request().method() === 'DELETE');
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  expect((await removed).status()).toBe(204);
  await page.getByLabel('Search by name').fill(name);
  await expect(page.getByText('No records match these filters.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile engineer sees API-scoped inventory and can enter application from portfolio', async ({ page }, testInfo) => {
  const errors = captureErrors(page); await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/applications');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill('engineer@portfolio.local');
  await page.getByLabel('Password', { exact: true }).fill('PortalDemo123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const loaded = page.waitForResponse(response => response.url().includes('/api/v1/applications?'));
  await page.getByRole('link', { name: 'Applications', exact: true }).click();
  const result = await (await loaded).json() as ApplicationPage;
  expect(result.portfolios).toHaveLength(1);
  await expect(page.getByRole('option', { name: 'Data & Analytics' })).toHaveCount(0);
  const row = result.items[0]; await page.getByRole('link', { name: row.name, exact: true }).click();
  await expect(page.getByRole('heading', { name: row.name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete application' })).toHaveCount(0);
  await page.getByRole('link', { name: row.portfolio, exact: true }).click();
  await page.getByRole('link', { name: row.name, exact: true }).click();
  await expect(page.getByRole('progressbar', { name: 'Health', exact: true })).toHaveAttribute('aria-valuenow', String(row.healthScore));
  await page.screenshot({ path: testInfo.outputPath('applications-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});
