/** Exercise reports against live API data, scoped exports and refreshed URL state. */
import { test, expect } from '@playwright/test';
import { captureErrors, signIn, signOut } from './helpers';
import type { ApplicationPage, PortfolioPage, ApplicationDetail, PortfolioSummary } from '../src/types';

const applicationHeaders = ['Name', 'Portfolio', 'Criticality', 'Tier', 'Lifecycle', 'Health', 'Automation %', 'Open Critical Defects', 'Risk'];
const portfolioHeaders = ['Name', 'Owner', 'Product Area', 'Applications', 'Quality Score', 'Status'];

/** Quote individual fields using CSV rules for response-grounded download assertions. */
function cell(value: string | number): string {
  const raw = String(value);
  const safe = raw.trimStart().match(/^[=+@-]/) || /^[\t\r\n]/.test(raw) ? "'" + raw : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

for (const kind of ['applications', 'portfolios'] as const) {
  test(`${kind} report matches the real response, CSV and refresh on desktop`, async ({ page }) => {
    const errors = captureErrors(page);
    await page.goto('/');
    const session = await signIn(page, 'executive@portfolio.local');
    await page.getByRole('link', { name: 'Reports', exact: true }).click();
    const received = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/reports/${kind}`);
    await page.getByRole('link', { name: kind === 'applications' ? 'Application Report' : 'Portfolio Report', exact: true }).click();
    const response = await received; expect(response.status()).toBe(200);
    const body = await response.json() as Omit<ApplicationPage, 'items'> & Omit<PortfolioPage, 'items'> & { items: (ApplicationDetail & PortfolioSummary)[] };
    expect(body.total).toBeGreaterThan(0);
    await expect(page.getByRole('columnheader')).toHaveText(kind === 'applications' ? applicationHeaders : portfolioHeaders);
    for (const row of body.items) {
      const values = kind === 'applications'
        ? [row.name, row.portfolio, row.criticality, row.tier, row.lifecycle, row.healthScore, row.automationCoverage, row.openCriticalDefects, row.risk]
        : [row.name, row.owner, row.productArea, row.applicationCount, row.qualityScore, row.status];
      await expect(page.getByRole('row').filter({ has: page.getByRole('link', { name: row.name, exact: true }) }).getByRole('cell')).toHaveText(values.map(String));
    }
    // Filter to one known row so the on-screen and all-match export sets coincide.
    const filteredResponse = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/reports/${kind}` && new URL(r.url()).searchParams.get('search') === body.items[0].name);
    await page.getByLabel('Search by name').fill(body.items[0].name);
    const filtered = await filteredResponse; expect(filtered.status()).toBe(200);
    const matching = await filtered.json() as Omit<ApplicationPage, 'items'> & Omit<PortfolioPage, 'items'> & { items: (ApplicationDetail & PortfolioSummary)[] };
    await expect(page.getByRole('link', { name: matching.items[0].name, exact: true })).toBeVisible();
    const csvReceived = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/reports/${kind}/csv`);
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download CSV', exact: true }).click();
    const csv = await csvReceived; expect(csv.status()).toBe(200);
    expect(csv.headers()['content-type']).toBe('text/csv; charset=utf-8');
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(kind === 'applications' ? 'application-report.csv' : 'portfolio-report.csv');
    const columns = kind === 'applications' ? applicationHeaders : portfolioHeaders;
    const rows = matching.items.map(row => kind === 'applications'
      ? [row.name, row.portfolio, row.criticality, row.tier, row.lifecycle, row.healthScore, row.automationCoverage, row.openCriticalDefects, row.risk]
      : [row.name, row.owner, row.productArea, row.applicationCount, row.qualityScore, row.status]);
    const expectedCSV = [columns, ...rows].map(row => row.map(cell).join(',') + '\r\n').join('');
    expect(await csv.text()).toBe(expectedCSV);
    const stream = await download.createReadStream(); expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString('utf8')).toBe(expectedCSV);
    const url = page.url();
    const refreshedResponse = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/reports/${kind}`);
    await page.reload();
    const refreshed = await refreshedResponse; expect(refreshed.status()).toBe(200);
    expect((await refreshed.json()).items).toEqual(matching.items);
    expect(page.url()).toBe(url);
    await expect(page.getByLabel('Search by name')).toHaveValue(body.items[0].name);
    // Click through a report name into inventory detail rather than teleporting.
    await page.getByRole('link', { name: matching.items[0].name, exact: true }).click();
    await expect(page.getByRole('heading', { name: matching.items[0].name, exact: true })).toBeVisible();
    expect(session.user.permissions).toContain('export');
    expect(errors).toEqual([]);
  });
}

test('mobile Read Only can inspect both reports but direct CSV is denied', async ({ page }) => {
  const errors = captureErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const session = await signIn(page, 'readonly@portfolio.local');
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  for (const [kind, title] of [['applications', 'Application Report'], ['portfolios', 'Portfolio Report']]) {
    const received = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/reports/${kind}`);
    await page.getByRole('link', { name: title, exact: true }).click();
    const response = await received; expect(response.status()).toBe(200);
    const result = await response.json();
    await expect(page.getByRole('link', { name: result.items[0].name, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download CSV' })).toHaveCount(0);
    const denied = await page.request.get(`/api/v1/reports/${kind}/csv`, { headers: { Authorization: `Bearer ${session.token}` } });
    expect(denied.status()).toBe(403);
    expect(await denied.json()).toEqual({ detail: 'You do not have permission for this action.' });
    const emptyResponse = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/reports/${kind}` && new URL(r.url()).searchParams.get('search') === 'no-report-match-987');
    await page.getByLabel('Search by name').fill('no-report-match-987');
    const empty = await emptyResponse; expect(empty.status()).toBe(200); expect((await empty.json()).total).toBe(0);
    await expect(page.getByText('No records match these filters.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByRole('link', { name: result.items[0].name, exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`${kind}-mobile.png`), fullPage: true });
    await page.getByRole('link', { name: 'Back to reports' }).click();
  }
  await signOut(page);
  const denied = await page.request.get('/api/v1/reports/applications');
  expect(denied.status()).toBe(401);
  expect(errors).toEqual([]);
});


test('a real offline export shows an error and can be retried after connectivity returns', async ({ page, context }) => {
  const errors = captureErrors(page);
  await page.goto('/');
  await signIn(page, 'executive@portfolio.local');
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  const received = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/reports/portfolios');
  await page.getByRole('link', { name: 'Portfolio Report', exact: true }).click();
  const response = await received; expect(response.status()).toBe(200);
  const result = await response.json();
  await expect(page.getByRole('link', { name: result.items[0].name, exact: true })).toBeVisible();
  await context.setOffline(true);
  try {
    await page.getByRole('button', { name: 'Download CSV' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download CSV' })).toBeEnabled();
  } finally {
    await context.setOffline(false);
  }
  const csvReceived = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/reports/portfolios/csv');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  expect((await csvReceived).status()).toBe(200);
  expect((await download).suggestedFilename()).toBe('portfolio-report.csv');
  await expect(page.getByRole('alert')).toHaveCount(0);
  // This one exact browser network error is expected from deliberately going offline.
  expect(errors.filter(error => !/Failed to load resource: net::ERR_INTERNET_DISCONNECTED/.test(error))).toEqual([]);
});
