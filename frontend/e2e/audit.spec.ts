/** Author real audit journeys; navigate by clicks and compare actual API/download content. */
import { test, expect } from '@playwright/test';
import type { Page, Response as BrowserResponse } from '@playwright/test';
import { captureErrors, signIn, signOut } from './helpers';
import type { AuditEvent, AuditPageResult, Session } from '../src/types';

/** Select only actual history responses, not the CSV endpoint. */
function history(page: Page): Promise<BrowserResponse> {
  return page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/audit');
}
/** Complete the seeded forced-password flow through visible controls when necessary. */
async function administrator(page: Page): Promise<Session> {
  const session = await signIn(page, 'admin@portfolio.local');
  if (!session.user.mustChangePassword) return session;
  await page.getByLabel('Current password', { exact: true }).fill('PortalDemo123!');
  await page.getByLabel('New password', { exact: true }).fill('PortalDemo123!');
  await page.getByLabel('Confirm new password', { exact: true }).fill('PortalDemo123!');
  const received = page.waitForResponse(response => response.url().endsWith('/api/v1/profile/password'));
  await page.getByRole('button', { name: 'Save password', exact: true }).click();
  const response = await received; expect(response.status()).toBe(200);
  const replacement = await response.json() as Session;
  await expect(page.getByText('Change your initial password before continuing.', { exact: true })).toHaveCount(0);
  return replacement;
}
/** Assert rendered event cells match backend facts, including machine-readable timestamps. */
async function assertRows(page: Page, body: AuditPageResult): Promise<void> {
  await expect(page.getByRole('table')).toBeVisible();
  const rows = page.getByRole('row');
  for (let index = 0; index < body.items.length; index++) {
    const event = body.items[index];
    const row = rows.nth(index + 1);
    await expect(row.getByRole('cell').nth(1)).toHaveText(event.person);
    await expect(row.getByRole('cell').nth(2)).toHaveText(event.action);
    await expect(row.getByRole('cell').nth(3)).toHaveText(event.entityType);
    await expect(row.getByRole('cell').nth(4)).toHaveText(event.summary);
    await expect(row.locator('time')).toHaveAttribute('datetime', event.time);
  }
}
/** Encode expected safe CSV from the response facts independently of browser rendering. */
function csvCell(value: string): string {
  const safe = value.trimStart().match(/^[=+@-]/) || /^[\t\r\n]/.test(value) ? "'" + value : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

for (const mobile of [false, true]) {
  test(`report export appears in persisted audit, filters and audit CSV ${mobile ? 'mobile' : 'desktop'}`, async ({ page }) => {
    const errors = captureErrors(page);
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const session = await administrator(page);
    await page.getByRole('link', { name: 'Reports', exact: true }).click();
    const reportReceived = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/reports/applications');
    await page.getByRole('link', { name: 'Application Report', exact: true }).click();
    const report = await reportReceived; expect(report.status()).toBe(200);
    const reportBody = await report.json();
    await expect(page.getByRole('link', { name: reportBody.items[0].name, exact: true })).toBeVisible();
    const reportCsvReceived = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/reports/applications/csv');
    const reportDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download CSV' }).click();
    expect((await reportCsvReceived).status()).toBe(200);
    expect((await reportDownload).suggestedFilename()).toBe('application-report.csv');
    await page.getByRole('link', { name: 'Administration', exact: true }).click();
    const initialReceived = history(page);
    await page.getByRole('link', { name: 'Audit log', exact: true }).click();
    const initialResponse = await initialReceived; expect(initialResponse.status()).toBe(200);
    const initial = await initialResponse.json() as AuditPageResult;
    await assertRows(page, initial);
    expect(initial.items.some(row => row.person === session.user.name && row.action === 'export' && row.entityType === 'report')).toBe(true);
    const personReceived = history(page);
    await page.getByLabel('Person', { exact: true }).selectOption(session.user.name);
    expect((await personReceived).status()).toBe(200);
    const actionReceived = history(page);
    await page.getByLabel('Action', { exact: true }).selectOption('export');
    const actionResponse = await actionReceived; expect(actionResponse.status()).toBe(200);
    const actionBody = await actionResponse.json() as AuditPageResult;
    const day = actionBody.items[0].time.slice(0, 10);
    const fromReceived = history(page);
    await page.getByLabel('From date (UTC)').fill(day);
    expect((await fromReceived).status()).toBe(200);
    const toReceived = history(page);
    await page.getByLabel('To date (UTC)').fill(day);
    const matchingResponse = await toReceived; expect(matchingResponse.status()).toBe(200);
    const matching = await matchingResponse.json() as AuditPageResult;
    await assertRows(page, matching);
    expect(matching.items.every(row => row.person === session.user.name && row.action === 'export' && row.time.slice(0, 10) === day)).toBe(true);
    const filters = new URL(page.url()).searchParams;
    filters.delete('tab'); filters.delete('page'); filters.set('page_size', '100');
    // Gather every matching page through the real authenticated API for an all-rows CSV oracle.
    const all: AuditEvent[] = [];
    let pageNumber = 1;
    while (true) {
      filters.set('page', String(pageNumber));
      const response = await page.request.get(`/api/v1/audit?${filters}`, { headers: { Authorization: `Bearer ${session.token}` } });
      expect(response.status()).toBe(200);
      const body = await response.json() as AuditPageResult; all.push(...body.items);
      if (pageNumber * 100 >= body.total) break;
      pageNumber++;
    }
    const expectedCSV = 'time,person,action,entityType,summary\r\n' + all.map(row =>
      [row.time, row.person, row.action, row.entityType, row.summary].map(csvCell).join(',') + '\r\n').join('');
    const csvReceived = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/audit/csv');
    const downloaded = page.waitForEvent('download');
    const ownReceived = history(page);
    await page.getByRole('button', { name: 'Download CSV' }).click();
    const csv = await csvReceived; expect(csv.status()).toBe(200);
    expect(await csv.text()).toBe(expectedCSV);
    expect(csv.headers()['content-type']).toBe('text/csv; charset=utf-8');
    const download = await downloaded; expect(download.suggestedFilename()).toBe('audit-log.csv');
    const stream = await download.createReadStream(); expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString('utf8')).toBe(expectedCSV);
    const ownResponse = await ownReceived; expect(ownResponse.status()).toBe(200);
    const own = await ownResponse.json() as AuditPageResult;
    expect(own.items.some(row => row.entityType === 'audit' && row.summary === `Exported ${all.length} matching audit rows.`)).toBe(true);
    await assertRows(page, own);
    const url = page.url(); const refreshedReceived = history(page); await page.reload();
    const refreshed = await refreshedReceived; expect(refreshed.status()).toBe(200);
    expect((await refreshed.json()).items).toEqual(own.items); expect(page.url()).toBe(url);
    await page.screenshot({ path: test.info().outputPath(`audit-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true });
    await signOut(page); await administrator(page);
    await page.getByRole('link', { name: 'Administration', exact: true }).click();
    const signedInReceived = history(page);
    await page.getByRole('link', { name: 'Audit log', exact: true }).click();
    const signedInResponse = await signedInReceived; expect(signedInResponse.status()).toBe(200);
    const signedIn = await signedInResponse.json() as AuditPageResult;
    expect(signedIn.items.some(row => row.entityType === 'audit' && row.action === 'export')).toBe(true);
    await assertRows(page, signedIn);
    expect(JSON.stringify(signedIn)).not.toContain(session.token);
    expect(JSON.stringify(signedIn)).not.toContain('passwordHash');
    expect(errors).toEqual([]);
  });
}

test('Auditor separate read-only history supports paging and empty dates but forbids export/admin', async ({ page }) => {
  const errors = captureErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const session = await signIn(page, 'auditor@portfolio.local');
  await expect(page.getByRole('link', { name: 'Administration', exact: true })).toHaveCount(0);
  const received = history(page);
  await page.getByRole('link', { name: 'Audit history', exact: true }).click();
  const response = await received; expect(response.status()).toBe(200);
  const body = await response.json() as AuditPageResult; await assertRows(page, body);
  await expect(page.getByRole('button', { name: 'Download CSV' })).toHaveCount(0);
  if (body.total > body.page_size) {
    const nextReceived = history(page); await page.getByRole('button', { name: 'Next' }).click();
    const next = await nextReceived; expect(next.status()).toBe(200);
    const nextBody = await next.json() as AuditPageResult;
    expect(nextBody.page).toBe(2); await assertRows(page, nextBody);
    const previousReceived = history(page); await page.getByRole('button', { name: 'Previous' }).click();
    expect((await previousReceived).status()).toBe(200);
  }
  const emptyReceived = history(page);
  await page.getByLabel('From date (UTC)').fill('9999-12-31');
  const empty = await emptyReceived; expect(empty.status()).toBe(200); expect((await empty.json()).total).toBe(0);
  await expect(page.getByText('No records match these filters.')).toBeVisible();
  await page.getByLabel('To date (UTC)').fill('2000-01-01');
  await expect(page.getByRole('alert')).toHaveText('To date must be on or after From date.');
  const clearReceived = history(page); await page.getByRole('button', { name: 'Clear filters' }).click();
  expect((await clearReceived).status()).toBe(200);
  for (const path of ['/api/v1/audit/csv', '/api/v1/admin/users', '/api/v1/admin/roles']) {
    const denied = await page.request.get(path, { headers: { Authorization: `Bearer ${session.token}` } });
    expect(denied.status()).toBe(403);
  }
  await signOut(page);
  expect((await page.request.get('/api/v1/audit')).status()).toBe(401);
  expect(errors).toEqual([]);
});
