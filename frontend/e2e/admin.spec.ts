/** Verify live administration maintenance, deactivation and role persistence without mocks. */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { captureErrors, signIn, signOut } from './helpers';
import type { AdminRole, PageResult, Session, User } from '../src/types';

/** Complete the seeded administrator's first-password requirement through visible controls. */
async function administrator(page: Page): Promise<Session> {
  const session = await signIn(page, 'admin@portfolio.local');
  if (!session.user.mustChangePassword) return session;
  await page.getByLabel('Current password', { exact: true }).fill('PortalDemo123!');
  await page.getByLabel('New password', { exact: true }).fill('PortalDemo123!');
  await page.getByLabel('Confirm new password', { exact: true }).fill('PortalDemo123!');
  const received = page.waitForResponse(response => response.url().endsWith('/api/v1/profile/password'));
  await page.getByRole('button', { name: 'Save password', exact: true }).click();
  const response = await received; expect(response.status()).toBe(200);
  return await response.json() as Session;
}

for (const mobile of [false, true]) {
  test(`admin create, edit, deactivate and role configuration persist ${mobile ? 'mobile' : 'desktop'}`, async ({ page }) => {
    const errors = captureErrors(page);
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const session = await administrator(page);
    const listReceived = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/users');
    await page.getByRole('link', { name: 'Administration', exact: true }).click();
    const listResponse = await listReceived; expect(listResponse.status()).toBe(200);
    const initial = await listResponse.json() as PageResult<User>;
    for (const user of initial.items) {
      await expect(page.getByRole('row').filter({ has: page.getByRole('button', { name: `Edit ${user.name}`, exact: true }) })).toContainText(user.email);
    }
    await page.getByRole('button', { name: 'New user', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New user', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Name is required', { exact: true })).toBeVisible();
    const name = `Admin Journey ${Date.now()} ${mobile ? 'Mobile' : 'Desktop'}`;
    const email = `journey-${Date.now()}-${mobile}@portfolio.local`;
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Manager name', { exact: true }).fill('Journey Manager');
    await page.getByLabel('Role', { exact: true }).selectOption('Engineer');
    await page.getByLabel('Payments', { exact: true }).check();
    await page.getByLabel('Vendor indicator', { exact: true }).check();
    await page.getByLabel('Initial password', { exact: true }).fill('JourneyInitial123!');
    const createdReceived = page.waitForResponse(response => response.url().endsWith('/api/v1/admin/users') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const createdResponse = await createdReceived; expect(createdResponse.status()).toBe(201);
    const created = await createdResponse.json() as User;
    expect(created.name).toBe(name); expect(created.email).toBe(email);
    expect(created.managerName).toBe('Journey Manager'); expect(created.vendor).toBe(true);
    expect(created.portfolioNames).toEqual(['Payments']);
    expect(created).not.toHaveProperty('passwordHash');
    await expect(page.getByRole('table')).toBeVisible();
    // Locate via the visible pager when previous runs have expanded the account list.
    while (await page.getByRole('button', { name: `Edit ${created.name}`, exact: true }).count() === 0) {
      await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
      const paged = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/users');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      expect((await paged).status()).toBe(200);
    }
    await page.getByRole('button', { name: `Edit ${created.name}`, exact: true }).click();
    await expect(page.getByLabel('Manager name', { exact: true })).toHaveValue(created.managerName);
    await expect(page.getByLabel('Initial password', { exact: true })).toHaveCount(0);
    await page.getByLabel('Manager name', { exact: true }).fill('Updated Journey Manager');
    await page.getByLabel('Role', { exact: true }).selectOption('Executive');
    const editedReceived = page.waitForResponse(response => response.url().endsWith(`/api/v1/admin/users/${created.id}`) && response.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const editedResponse = await editedReceived; expect(editedResponse.status()).toBe(200);
    const edited = await editedResponse.json() as User;
    expect(edited.managerName).toBe('Updated Journey Manager'); expect(edited.role).toBe('Executive');
    const refreshedReceived = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/users');
    const currentURL = page.url(); await page.reload();
    const refreshed = await refreshedReceived; expect(refreshed.status()).toBe(200);
    expect((await refreshed.json() as PageResult<User>).items.find(user => user.id === created.id)).toEqual(edited);
    expect(page.url()).toBe(currentURL);
    // Use a separate actual sign-in token to prove deactivation revokes an existing session.
    const targetLogin = await page.request.post('/api/v1/auth/login', { data: { email, password: 'JourneyInitial123!' } });
    expect(targetLogin.status()).toBe(200);
    const targetSession = await targetLogin.json() as Session;
    await page.getByRole('button', { name: `Deactivate ${created.name}`, exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Audit history is retained.');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: `Deactivate ${created.name}`, exact: true }).click();
    const deactivatedReceived = page.waitForResponse(response => response.url().endsWith(`/api/v1/admin/users/${created.id}`) && response.request().method() === 'PUT');
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    const deactivated = await deactivatedReceived; expect(deactivated.status()).toBe(200);
    expect((await deactivated.json() as User).status).toBe('Inactive');
    await expect(page.getByRole('row').filter({ has: page.getByRole('button', { name: `Edit ${created.name}`, exact: true }) })).toContainText('Inactive');
    const revoked = await page.request.get('/api/v1/auth/me', { headers: { Authorization: `Bearer ${targetSession.token}` } });
    expect(revoked.status()).toBe(401);
    const inactive = await page.request.post('/api/v1/auth/login', { data: { email, password: 'JourneyInitial123!' } });
    expect(inactive.status()).toBe(403); expect((await inactive.json()).detail).toBe('This account is inactive.');
    const rolesReceived = page.waitForResponse(response => response.url().endsWith('/api/v1/admin/roles'));
    await page.getByRole('link', { name: 'Roles', exact: true }).click();
    const rolesResponse = await rolesReceived; expect(rolesResponse.status()).toBe(200);
    const roles = await rolesResponse.json() as AdminRole[];
    expect(roles).toHaveLength(6);
    const role = roles.find(row => row.name === 'Read Only')!;
    await page.getByRole('button', { name: 'Edit Read Only', exact: true }).click();
    const description = `Configured ${mobile ? 'mobile' : 'desktop'} ${Date.now()}`;
    await page.getByLabel('Description', { exact: true }).fill(description);
    await page.getByLabel('view', { exact: true }).check();
    await page.getByLabel('administer', { exact: true }).check();
    const roleSavedReceived = page.waitForResponse(response => response.url().endsWith(`/api/v1/admin/roles/${role.id}`) && response.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const roleSaved = await roleSavedReceived; expect(roleSaved.status()).toBe(200);
    const persistedRole = await roleSaved.json() as AdminRole;
    expect(persistedRole.description).toBe(description); expect(persistedRole.permissions).toContain('administer');
    await expect(page.getByText(description, { exact: true })).toBeVisible();
    const reloadedRoles = page.waitForResponse(response => response.url().endsWith('/api/v1/admin/roles'));
    await page.reload(); const reread = await reloadedRoles; expect(reread.status()).toBe(200);
    expect((await reread.json() as AdminRole[]).find(row => row.id === role.id)).toEqual(persistedRole);
    expect(new URL(page.url()).searchParams.get('tab')).toBe('roles');
    await page.screenshot({ path: test.info().outputPath(`admin-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true });
    // Restore this shared seeded role after proving persistence, to keep other journeys independent.
    const restored = await page.request.put(`/api/v1/admin/roles/${role.id}`, {
      headers: { Authorization: `Bearer ${session.token}` }, data: { description: role.description, permissions: role.permissions },
    });
    expect(restored.status()).toBe(200);
    await signOut(page);
    expect((await page.request.get('/api/v1/admin/users')).status()).toBe(401);
    expect(errors).toEqual([]);
  });
}

test('Read Only cannot administer even when its live role has administer selected', async ({ page }) => {
  const errors = captureErrors(page);
  await page.goto('/');
  const admin = await administrator(page);
  await page.getByRole('link', { name: 'Administration', exact: true }).click();
  const received = page.waitForResponse(response => response.url().endsWith('/api/v1/admin/roles'));
  await page.getByRole('link', { name: 'Roles', exact: true }).click();
  const response = await received; expect(response.status()).toBe(200);
  const role = (await response.json() as AdminRole[]).find(row => row.name === 'Read Only')!;
  await page.getByRole('button', { name: 'Edit Read Only', exact: true }).click();
  await page.getByLabel('administer', { exact: true }).check();
  const changed = page.waitForResponse(r => r.url().endsWith(`/api/v1/admin/roles/${role.id}`) && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); expect((await changed).status()).toBe(200);
  await signOut(page);
  const reader = await signIn(page, 'readonly@portfolio.local');
  expect(reader.user.permissions).toContain('administer');
  await expect(page.getByRole('link', { name: 'Administration', exact: true })).toHaveCount(0);
  const denied = await page.request.get('/api/v1/admin/roles', { headers: { Authorization: `Bearer ${reader.token}` } });
  expect(denied.status()).toBe(403); expect((await denied.json()).detail).toBe('You do not have access to administration.');
  await signOut(page); const freshAdmin = await administrator(page);
  const restored = await page.request.put(`/api/v1/admin/roles/${role.id}`, {
    headers: { Authorization: `Bearer ${freshAdmin.token || admin.token}` }, data: { description: role.description, permissions: role.permissions },
  });
  expect(restored.status()).toBe(200);
  expect(errors).toEqual([]);
});
