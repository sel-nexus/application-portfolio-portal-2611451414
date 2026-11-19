/** Verify persisted portfolio journeys against the live API; execute in the final test phase. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { PortfolioDetail, PortfolioPage } from '../src/types';

/** Capture JS errors and distinguish expected, asserted HTTP conflict responses. */
function errorsFor(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !/Failed to load resource: the server responded with a status of (401|403|404|409|422)/.test(message.text())) errors.push(message.text());
  });
  return errors;
}

/** Sign in visibly and complete the first-admin requirement when the test database is fresh. */
async function login(page: Page, local: string): Promise<void> {
  await page.getByLabel('Email', { exact: true }).fill(`${local}@portfolio.local`);
  await page.getByLabel('Password', { exact: true }).fill(process.env.PORTFOLIO_E2E_PASSWORD ?? 'PortalDemo123!');
  const received = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/login'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const result = await received;
  expect(result.status()).toBe(200);
  const session = await result.json();
  if (session.user.mustChangePassword) {
    await page.getByLabel('Current password').fill('PortalDemo123!');
    await page.getByLabel('New password', { exact: true }).fill('PortalDemo123!');
    await page.getByLabel('Confirm new password').fill('PortalDemo123!');
    const saved = page.waitForResponse(response => response.url().endsWith('/profile/password'));
    await page.getByRole('button', { name: 'Save password' }).click();
    expect((await saved).status()).toBe(200);
  }
  await expect(page.getByRole('link', { name: 'Portfolios', exact: true })).toBeVisible();
}

test('administrator creates, refreshes, edits, handles duplicate and occupied deletion, then removes empty record', async ({ page }, info) => {
  const errors = errorsFor(page);
  await page.goto('/');
  await login(page, 'admin');
  const listing = page.waitForResponse(response => response.url().includes('/api/v1/portfolios?'));
  await page.getByRole('link', { name: 'Portfolios', exact: true }).click();
  const listResponse = await listing;
  expect(listResponse.status()).toBe(200);
  const inventory = await listResponse.json() as PortfolioPage;
  for (const row of inventory.items) await expect(page.getByRole('link', { name: row.name, exact: true })).toBeVisible();
  const occupied = inventory.items.find(row => row.applicationCount > 0)!;
  const detailResponse = page.waitForResponse(response => response.url().endsWith(`/portfolios/${occupied.id}`));
  await page.getByRole('link', { name: occupied.name, exact: true }).click();
  const detail = await (await detailResponse).json() as PortfolioDetail;
  for (const app of detail.applications) await expect(page.getByText(app.name, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete portfolio' }).click();
  const refused = page.waitForResponse(response => response.request().method() === 'DELETE');
  await page.getByRole('button', { name: 'Confirm' }).click();
  expect((await refused).status()).toBe(409);
  await expect(page.getByRole('alert')).toContainText('Move or delete them');
  await page.getByRole('link', { name: 'Back to portfolios' }).click();
  await page.getByRole('link', { name: 'New portfolio' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Name is required')).toBeVisible();
  const name = `Journey ${Date.now()}-${info.workerIndex}`;
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Owner', { exact: true }).fill('Journey Owner');
  await page.getByLabel('Description', { exact: true }).fill('Persisted browser journey');
  await page.getByLabel('Product area', { exact: true }).fill('Journey Area');
  await page.getByLabel('Status', { exact: true }).selectOption('Archived');
  const creation = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/portfolios'));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const createdResponse = await creation;
  expect(createdResponse.status()).toBe(201);
  const created = await createdResponse.json() as PortfolioDetail;
  expect(created.name).toBe(name); expect(created.applicationCount).toBe(0); expect(created.qualityScore).toBe(0);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const refresh = page.waitForResponse(response => response.url().endsWith(`/portfolios/${created.id}`));
  await page.reload();
  expect((await refresh).status()).toBe(200);
  await expect(page.getByText(created.description, { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Edit portfolio' }).click();
  await page.getByLabel('Name', { exact: true }).fill(occupied.name.toUpperCase());
  const duplicate = page.waitForResponse(response => response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await duplicate).status()).toBe(409);
  await expect(page.getByText('A portfolio with this name already exists.', { exact: true })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill(`${name} edited`);
  await page.getByLabel('Owner', { exact: true }).fill('Updated Journey Owner');
  const update = page.waitForResponse(response => response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const updated = await (await update).json() as PortfolioDetail;
  expect(updated.owner).toBe('Updated Journey Owner');
  await expect(page.getByText(updated.owner, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete portfolio' }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: 'Delete portfolio' }).click();
  const deletion = page.waitForResponse(response => response.request().method() === 'DELETE');
  await page.getByRole('button', { name: 'Confirm' }).click();
  expect((await deletion).status()).toBe(204);
  await expect(page.getByText('Portfolio deleted.')).toBeVisible();
  await page.getByLabel('Search by name').fill(name);
  await expect(page.getByText('No records match these filters.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile engineer browses scoped options, preserves filters on refresh and has no portfolio mutation controls', async ({ page }, info) => {
  const errors = errorsFor(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await login(page, 'engineer');
  const received = page.waitForResponse(response => response.url().includes('/api/v1/portfolios?'));
  await page.getByRole('link', { name: 'Portfolios', exact: true }).click();
  const result = await received;
  expect(result.status()).toBe(200);
  const inventory = await result.json() as PortfolioPage;
  expect(inventory.total).toBe(1);
  await expect(page.getByRole('link', { name: 'New portfolio' })).toHaveCount(0);
  for (const area of inventory.productAreas) await expect(page.getByRole('option', { name: area, exact: true })).toHaveCount(1);
  const row = inventory.items[0];
  await page.getByLabel('Search by name').fill(row.name);
  await page.getByLabel('Status', { exact: true }).selectOption(row.status);
  await page.getByLabel('Product area', { exact: true }).selectOption(row.productArea);
  await expect(page.getByRole('link', { name: row.name, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Search by name')).toHaveValue(row.name);
  await page.getByRole('link', { name: row.name, exact: true }).click();
  await expect(page.getByRole('heading', { name: row.name, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit portfolio' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete portfolio' })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('portfolios-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});
