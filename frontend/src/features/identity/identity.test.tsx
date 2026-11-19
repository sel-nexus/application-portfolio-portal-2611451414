/** Exercise the actual auth provider, router, login, and profile through user interactions. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../../App';
import { api, TOKEN_KEY } from '../../api';
import type { User } from '../../types';

const initial: User = {
  id: 'user-id', name: 'Sam Chen', email: 'engineer@portfolio.local', role: 'Engineer',
  permissions: ['view', 'create', 'edit', 'export'], portfolioAccess: ['payments-id'],
  portfolioNames: ['Payments'], status: 'Active', managerName: 'Casey Rivera', vendor: true,
  mustChangePassword: false, defaultLanding: 'Applications', lastSignIn: '2025-01-01T12:00:00Z',
};
let account: User;
let currentPassword: string;
let loginFailure: string;
let calls: { path: string; body: Record<string, string>; token: string | null }[];

/** Return a real Response at the fetch boundary while preserving application logic. */
function response(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status });
}

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  account = structuredClone(initial); currentPassword = 'PortalDemo123!'; loginFailure = ''; calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    const path = String(input);
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    const token = new Headers(options?.headers).get('Authorization');
    calls.push({ path, body, token });
    if (path.endsWith('/auth/login')) {
      if (loginFailure) return response({ detail: loginFailure }, loginFailure.includes('inactive') ? 403 : 401);
      if (body.password !== currentPassword) return response({ detail: 'Email or password is incorrect.' }, 401);
      return response({ token: 'session-one', user: account });
    }
    if (!token) return response({ detail: 'Please sign in.' }, 401);
    if (path.endsWith('/auth/me')) return response(account);
    if (path.endsWith('/auth/logout')) return response(null, 204);
    if (path.endsWith('/profile/password')) {
      if (body.currentPassword !== currentPassword) return response({ detail: { currentPassword: 'Current password is incorrect.' } }, 422);
      currentPassword = body.newPassword; account.mustChangePassword = false;
      return response({ token: 'replacement-session', user: account });
    }
    if (path.endsWith('/profile')) { account.defaultLanding = body.defaultLanding; return response(account); }
    return response({ detail: 'Not found' }, 404);
  });
});
afterEach(() => vi.restoreAllMocks());

/** Sign in through labeled controls, never bypassing the provider's HTTP contract. */
async function signIn() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Email'), initial.email);
  await user.type(screen.getByLabelText('Password'), 'PortalDemo123!');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { name: 'My Profile' });
  return user;
}

describe('identity interactions', () => {
  it('validates required fields and shows/hides the password without submitting blank credentials', async () => {
    render(<App />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Email is required')).toBeVisible();
    expect(screen.getByText('Password is required')).toBeVisible();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-describedby', 'email-error');
    expect(calls).toHaveLength(0);
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByText(/admin@portfolio.local \/ PortalDemo123!/)).toBeVisible();
  });

  it.each(['Email or password is incorrect.', 'This account is inactive.'])('keeps rejected sign-in on the login page: %s', async message => {
    loginFailure = message;
    render(<App />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), initial.email);
    await user.type(screen.getByLabelText('Password'), 'PortalDemo123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(message)).toBeVisible();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(window.location.pathname).toBe('/');
  });

  it('rejects malformed email and oversized UTF-8 password without HTTP traffic', async () => {
    render(<App />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'invalid');
    await user.type(screen.getByLabelText('Password'), 'é'.repeat(37));
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter a valid email')).toBeVisible();
    expect(screen.getByText('Password must be at most 72 UTF-8 bytes')).toBeVisible();
    expect(calls).toHaveLength(0);
  });

  it('signs in, reads server facts, saves landing, and hydrates persisted preference on refresh', async () => {
    const rendered = render(<App />);
    const user = await signIn();
    expect(screen.getAllByText('Sam Chen').length).toBeGreaterThan(0);
    expect(screen.getByText('Payments')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Default landing page'), 'Dashboard');
    await user.click(screen.getByRole('button', { name: 'Save preference' }));
    expect(await screen.findByText('Default landing page saved.')).toBeVisible();
    expect(calls.find(call => call.path.endsWith('/profile'))?.body).toEqual({ defaultLanding: 'Dashboard' });
    rendered.unmount(); render(<App />);
    await screen.findByRole('heading', { name: 'My Profile' });
    expect(screen.getByLabelText('Default landing page')).toHaveValue('Dashboard');
    expect(calls.filter(call => call.path.endsWith('/auth/me')).every(call => call.token === 'Bearer session-one')).toBe(true);
  });

  it('shows forced change, validates confirmation/current password, and replaces the bearer after success', async () => {
    account.mustChangePassword = true; account.role = 'Administrator';
    render(<App />); const user = await signIn();
    expect(screen.getByText('Change your initial password before continuing.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    expect(screen.getAllByText('This field is required')).toHaveLength(3);
    await user.type(screen.getByLabelText('Current password'), 'wrong');
    await user.type(screen.getByLabelText('New password', { exact: true }), 'updated');
    await user.type(screen.getByLabelText('Confirm new password'), 'different');
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    expect(screen.getByText('Passwords do not match.')).toBeVisible();
    await user.clear(screen.getByLabelText('Confirm new password'));
    await user.type(screen.getByLabelText('Confirm new password'), 'updated');
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByText('Current password is incorrect.')).toBeVisible();
    await user.clear(screen.getByLabelText('Current password'));
    await user.type(screen.getByLabelText('Current password'), 'PortalDemo123!');
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByText('Password changed. Other sessions have been signed out.')).toBeVisible();
    expect(screen.queryByText('Change your initial password before continuing.')).not.toBeInTheDocument();
    expect(localStorage.getItem(TOKEN_KEY)).toBe('replacement-session');
    expect(screen.getByLabelText('Current password')).toHaveValue('');
  });

  it('rechecks protected access, clears expired storage, and returns unauthenticated routes to sign-in', async () => {
    localStorage.setItem(TOKEN_KEY, 'expired'); window.history.replaceState({}, '', '/profile');
    vi.mocked(fetch).mockResolvedValue(response({ detail: 'Session expired' }, 401));
    render(<App />);
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'My Profile' })).not.toBeInTheDocument();
  });

  it('signs out using the account disclosure and removes protected content', async () => {
    render(<App />); const user = await signIn();
    await user.click(screen.getByText('Account'));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(screen.queryByText('Payments')).not.toBeInTheDocument();
    expect(calls.find(call => call.path.endsWith('/auth/logout'))?.token).toBe('Bearer session-one');
  });

  it('shows retryable network failure rather than a blank profile or silent login failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));
    render(<App />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), initial.email);
    await user.type(screen.getByLabelText('Password'), 'PortalDemo123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Unable to connect. Please try again.')).toBeVisible();
  });

  it('disables pending sign-in and displays the quiet pending label', async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    render(<App />); const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), initial.email);
    await user.type(screen.getByLabelText('Password'), 'PortalDemo123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
    resolve(response({ token: 'session-one', user: account }));
    await screen.findByRole('heading', { name: 'My Profile' });
  });

  it('shows profile save failures without discarding displayed account facts', async () => {
    render(<App />); const user = await signIn();
    vi.mocked(fetch).mockResolvedValueOnce(response({ detail: 'The service is unavailable. Please try again.' }, 503));
    await user.selectOptions(screen.getByLabelText('Default landing page'), 'Dashboard');
    await user.click(screen.getByRole('button', { name: 'Save preference' }));
    expect(await screen.findByText('The service is unavailable. Please try again.')).toBeVisible();
    expect(screen.getByText('Payments')).toBeVisible();
    expect(localStorage.getItem(TOKEN_KEY)).toBe('session-one');
  });

  it('keeps a failed hydration closed and allows an explicit session retry', async () => {
    localStorage.setItem(TOKEN_KEY, 'session-one');
    window.history.replaceState({}, '', '/profile');
    vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));
    render(<App />);
    expect(await screen.findByText('Unable to connect. Please try again.')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'My Profile' })).not.toBeInTheDocument();
    vi.mocked(fetch).mockResolvedValue(response(account));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('heading', { name: 'My Profile' });
    expect(screen.getByText('Payments')).toBeVisible();
  });

  it('maps API field arrays and handles empty logout responses', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ detail: [{ loc: ['body', 'email'], msg: 'Invalid email' }] }, 422));
    await expect(api('/auth/login')).rejects.toMatchObject({ fields: { email: 'Invalid email' } });
    vi.mocked(fetch).mockResolvedValueOnce(response(null, 204));
    await expect(api('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });
});
