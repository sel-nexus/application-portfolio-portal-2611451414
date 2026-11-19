/** Reuse browser error capture and UI sign-in without mocking any application boundary. */
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Session } from '../src/types';

/** Capture runtime errors before navigation, excluding only expected HTTP credential refusals. */
export function captureErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !/Failed to load resource: the server responded with a status of (401|403|422)/.test(message.text())) {
      errors.push(message.text());
    }
  });
  return errors;
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
  await expect(page.getByRole('heading', { name: 'My Profile' })).toBeVisible();
  await expect(page.locator('dd').filter({ hasText: session.user.email })).toBeVisible();
  return session;
}

/** Revoke through the visible account disclosure and verify that private UI disappears. */
export async function signOut(page: Page): Promise<void> {
  await page.getByText('Account', { exact: true }).click();
  const received = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/logout'));
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  expect((await received).status()).toBe(204);
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
}
