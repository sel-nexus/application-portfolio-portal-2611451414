/** Reuse browser error capture and UI sign-in without mocking any application boundary. */
import { expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { TOKEN_KEY } from '../src/api';
import type { Session } from '../src/types';

/** Capture runtime errors, excluding expected credential refusals and explicitly asserted HTTP statuses. */
export function captureErrors(page: Page, expectedResourceStatuses: number[] = []): string[] {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    const resourceStatus = /Failed to load resource: the server responded with a status of (\d+)/.exec(message.text());
    const expectedResourceError = resourceStatus && [401, 403, 422, ...expectedResourceStatuses].includes(Number(resourceStatus[1]));
    if (message.type() === 'error' && !expectedResourceError) {
      errors.push(message.text());
    }
  });
  return errors;
}

/** Obtain a real bearer for initial direct-address authorization tests, without browser navigation. */
export async function signInHttp(request: APIRequestContext, email: string): Promise<Session> {
  const response = await request.post('/api/v1/auth/login', {
    data: { email, password: process.env.PORTFOLIO_E2E_PASSWORD ?? 'PortalDemo123!' },
  });
  expect(response.status()).toBe(200);
  const session = await response.json() as Session;
  expect(session.token).not.toBe('');
  expect(session.user.email).toBe(email);
  expect(session.user.mustChangePassword).toBe(false);
  return session;
}

/** Store only the server-issued bearer before the permission test's first document is loaded. */
export async function establishInitialSession(page: Page, session: Session): Promise<void> {
  await page.addInitScript(({ key, token }: { key: string; token: string }) => {
    localStorage.setItem(key, token);
  }, { key: TOKEN_KEY, token: session.token });
}

/** Authenticate by filling visible inputs and assert on the actual backend-issued profile. */
export async function signIn(page: Page, email: string, password = 'PortalDemo123!'): Promise<Session> {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  const received = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const response = await received;
  expect(response.status()).toBe(200);
  const session = await response.json() as Session;
  const heading = session.user.mustChangePassword ? 'My Profile' : session.user.defaultLanding === 'Dashboard' ? 'Executive Dashboard' : 'Applications';
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  if (session.user.mustChangePassword) {
    await expect(page.locator('dd').filter({ hasText: session.user.email })).toBeVisible();
  }
  return session;
}

/** Revoke through the visible account disclosure and verify that private UI disappears. */
export async function signOut(page: Page): Promise<void> {
  const menu = page.locator('details').filter({ has: page.getByText('Account', { exact: true }) });
  if (await menu.getAttribute('open') === null) await page.getByText('Account', { exact: true }).click();
  const received = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/logout'));
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  expect((await received).status()).toBe(204);
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
}

/** Enter profile through the account menu rather than assuming it is the landing page. */
export async function openProfile(page: Page): Promise<void> {
  const menu = page.locator('details').filter({ has: page.getByText('Account', { exact: true }) });
  if (await menu.getAttribute('open') === null) await page.getByText('Account', { exact: true }).click();
  await page.getByRole('link', { name: 'My Profile', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My Profile', exact: true })).toBeVisible();
}
