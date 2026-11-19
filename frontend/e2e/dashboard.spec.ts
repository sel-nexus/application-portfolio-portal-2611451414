/** Specify live API-grounded dashboard metrics, filter persistence, links and mobile layout. */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { DashboardMetrics, DashboardResponse } from '../src/types';
import { captureErrors, signIn } from './helpers';

const labels: Record<keyof DashboardMetrics, string> = {
  enterpriseQualityScore: 'Enterprise Quality Score', applicationHealth: 'Application Health',
  automationMaturity: 'Automation Maturity', openCriticalDefects: 'Open Critical Defects',
  applicationsAtRisk: 'Applications at Risk', totalApplications: 'Total Applications', totalPortfolios: 'Total Portfolios',
};

/** Compare every tile and breakdown to the actual response received by the browser. */
async function assertDashboard(page: Page, data: DashboardResponse): Promise<void> {
  for (const key of Object.keys(labels) as (keyof DashboardMetrics)[]) {
    await expect(page.getByRole('article', { name: labels[key], exact: true }).locator('.metric-value')).toHaveText(String(data.metrics[key]));
  }
  await expect(page.getByRole('progressbar')).toHaveCount(data.portfolioQuality.length);
  for (const row of data.portfolioQuality) {
    await expect(page.getByRole('progressbar', { name: `${row.name} quality` })).toHaveAttribute('aria-valuenow', String(row.qualityScore));
    await expect(page.getByRole('region', { name: 'Portfolio Quality' }).getByRole('link', { name: row.name, exact: true })).toHaveAttribute('href', `/portfolios/${row.id}`);
  }
  const riskRegion = page.getByRole('region', { name: 'Applications at Risk', exact: true });
  await expect(riskRegion.getByRole('link')).toHaveCount(data.metrics.applicationsAtRisk);
  for (const group of data.applicationsAtRisk) {
    await expect(riskRegion.getByRole('heading', { name: group.name, exact: true })).toBeVisible();
    for (const app of group.applications) {
      await expect(riskRegion.getByRole('link', { name: app.name, exact: true })).toHaveAttribute('href', `/applications/${app.id}`);
    }
  }
}

test('dashboard shows loading during a delayed real backend request and then real metrics', async ({ page }) => {
  const errors = captureErrors(page);
  await page.goto('/');
  await signIn(page, 'leader@portfolio.local');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 2500, downloadThroughput: -1, uploadThroughput: -1,
  });
  let dashboardResponded = false;
  const isDashboard = (url: string): boolean => new URL(url).pathname === '/api/v1/dashboard';
  page.on('response', response => {
    if (isDashboard(response.url())) dashboardResponded = true;
  });
  try {
    const requested = page.waitForRequest(request => isDashboard(request.url()));
    const received = page.waitForResponse(response => isDashboard(response.url()));
    await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
    await requested;
    const loading = page.getByRole('status', { name: 'Loading dashboard', exact: true });
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('aria-busy', 'true');
    expect(dashboardResponded).toBe(false);
    const response = await received;
    expect(response.status()).toBe(200);
    const data = await response.json() as DashboardResponse;
    await expect(loading).toHaveCount(0);
    await assertDashboard(page, data);
  } finally {
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
    await cdp.detach();
  }
  expect(errors).toEqual([]);
});

test('executive filters every metric and breakdown, persists URL and opens both detail links', async ({ page }, info) => {
  const errors = captureErrors(page);
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  const initialResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/dashboard');
  const session = await signIn(page, 'executive@portfolio.local');
  expect(session.user.defaultLanding).toBe('Dashboard');
  const response = await initialResponse;
  expect(response.status()).toBe(200);
  const data = await response.json() as DashboardResponse;
  await assertDashboard(page, data);
  const portfolio = data.portfolioQuality.find(row => data.applicationsAtRisk.some(group => group.id === row.id))!;
  const portfolioResponse = page.waitForResponse(response => response.url().includes(`/api/v1/dashboard?portfolioId=${portfolio.id}`));
  await page.getByLabel('Portfolio', { exact: true }).selectOption(portfolio.id);
  expect((await portfolioResponse).status()).toBe(200);
  const appResponse = await page.request.get(`/api/v1/applications?portfolioId=${portfolio.id}`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  expect(appResponse.status()).toBe(200);
  const applications = await appResponse.json();
  const area: string = applications.items.find((app: { risk: string }) => app.risk === 'High').productArea;
  const areaResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/dashboard' && response.url().includes('productArea='));
  await page.getByLabel('Product Area').selectOption({ label: area });
  expect((await areaResponse).status()).toBe(200);
  const combinedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/dashboard' && response.url().includes('risk=High'));
  await page.getByLabel('Risk', { exact: true }).selectOption('High');
  const combined = await combinedResponse;
  expect(combined.status()).toBe(200);
  const filtered = await combined.json() as DashboardResponse;
  await assertDashboard(page, filtered);
  expect(filtered.metrics.totalPortfolios).toBe(1);
  const hydrated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/dashboard' && response.url().includes('risk=High'));
  await page.reload();
  expect((await hydrated).status()).toBe(200);
  await expect(page.getByLabel('Portfolio', { exact: true })).toHaveValue(portfolio.id);
  await expect(page.getByLabel('Product Area')).toHaveValue(area);
  await expect(page.getByLabel('Risk', { exact: true })).toHaveValue('High');
  await assertDashboard(page, filtered);
  await page.getByRole('region', { name: 'Portfolio Quality' }).getByRole('link', { name: portfolio.name, exact: true }).click();
  await expect(page.getByRole('heading', { name: portfolio.name, exact: true })).toBeVisible();
  const returning = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/dashboard');
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  const returned = await (await returning).json() as DashboardResponse;
  await assertDashboard(page, returned);
  const riskApp = returned.applicationsAtRisk[0].applications[0];
  await page.getByRole('link', { name: riskApp.name, exact: true }).click();
  await expect(page.getByRole('heading', { name: riskApp.name, exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Total Applications' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('dashboard-mobile.png'), fullPage: true });
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('leader sees only scoped choices and an empty combined filter with zero tiles', async ({ page }) => {
  const errors = captureErrors(page);
  await page.goto('/');
  await signIn(page, 'leader@portfolio.local');
  const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/dashboard');
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  const data = await (await received).json() as DashboardResponse;
  expect(data.portfolios.map(row => row.name)).toEqual(['Customer Platform', 'Payments']);
  await assertDashboard(page, data);
  await expect(page.getByRole('option', { name: 'Data & Analytics' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /save|export|delete|create/i })).toHaveCount(0);
  await page.getByLabel('Portfolio', { exact: true }).selectOption({ label: 'Customer Platform' });
  await expect(page.getByRole('article', { name: 'Total Applications' }).locator('.metric-value')).toHaveText('3');
  const emptyResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/dashboard' && response.url().includes('risk=High'));
  await page.getByLabel('Risk', { exact: true }).selectOption('High');
  const empty = await (await emptyResponse).json() as DashboardResponse;
  expect(empty.metrics.totalApplications).toBe(0);
  await assertDashboard(page, empty);
  await expect(page.getByText('No records match these filters.')).toBeVisible();
  await expect(page.getByText('No matching High-risk applications.')).toBeVisible();
  const cleared = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/dashboard' && new URL(response.url()).search === '');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  expect((await cleared).status()).toBe(200);
  await assertDashboard(page, data);
  expect(errors).toEqual([]);
});
