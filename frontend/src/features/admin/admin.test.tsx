/** Verify administration through actual user interactions and the shared HTTP parser. */
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { AuthProvider } from '../identity/AuthContext';
import AdminPage from './AdminPage';
import { TOKEN_KEY } from '../../api';
import type { User, AdminRole } from '../../types';
let actor: User;
let rows: User[];
let roles: AdminRole[];
let writes: { path: string; body: Record<string, unknown> }[];
let failure: number;
let readFailure: boolean;
let defer: ((body: unknown) => Promise<Response>) | null;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
/** Expose URL tab and paging state as user-observable navigation. */
function Location() {
  const location = useLocation();
  return <output aria-label="Current route">{location.pathname}{location.search}</output>;
}
/** Mount real authentication and administration panels. */
function mount(path = '/admin') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Location />
        <Routes>
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/profile" element={<h1>My Profile</h1>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  actor = { id: 'u0', name: 'Admin', email: 'admin@portfolio.local', role: 'Administrator', permissions: ['view', 'administer'],
    portfolioAccess: [], portfolioNames: [], status: 'Active', managerName: '', vendor: false,
    mustChangePassword: false, defaultLanding: 'Dashboard', lastSignIn: null };
  rows = [{ ...actor, id: 'u1', name: 'Person', email: 'person@portfolio.local', role: 'Engineer', managerName: 'Manager', vendor: true,
    portfolioAccess: ['p1'], portfolioNames: ['Payments'] }, { ...actor, id: 'u2', name: 'Second' }];
  roles = [{ id: 'r1', name: 'Engineer', description: 'Engineer duties', permissions: ['view', 'edit'] },
    { id: 'r2', name: 'Executive', description: 'Executive duties', permissions: ['view', 'export'] }];
  writes = []; failure = 0; readFailure = false; defer = null;
  localStorage.setItem(TOKEN_KEY, 'session');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), 'http://test');
    if (url.pathname.endsWith('/auth/me')) return json(actor);
    if (options?.method === 'POST' || options?.method === 'PUT') {
      const body = JSON.parse(String(options.body)); writes.push({ path: url.pathname, body });
      if (defer) return defer(body);
      if (failure) return json({ detail: failure === 409 ? { email: 'Email already exists.' } : 'Save denied.' }, failure);
      if (url.pathname.includes('/roles/')) {
        roles = roles.map(row => url.pathname.endsWith(row.id) ? { ...row, ...body } : row);
        return json(roles[0]);
      }
      if (options.method === 'POST') rows.push({ ...actor, ...body, id: 'new', portfolioNames: ['Payments'] });
      else rows = rows.map(row => url.pathname.endsWith(row.id) ? { ...row, ...body } : row);
      return json(rows.at(-1), options.method === 'POST' ? 201 : 200);
    }
    if (readFailure) return json({ detail: 'Unavailable.' }, 503);
    if (url.pathname.endsWith('/roles')) return json(roles);
    if (url.pathname.endsWith('/portfolios')) return json({ items: [{ id: 'p1', name: 'Payments' }], total: 1, page: 1, page_size: 100 });
    const page = Number(url.searchParams.get('page') || 1); const size = Number(url.searchParams.get('page_size') || 10);
    return json({ items: rows.slice((page - 1) * size, page * size), total: rows.length, page, page_size: size });
  }));
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function() { this.removeAttribute('open'); } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('pages users through URL, switches tabs and renders stored role configuration', async () => {
  mount('/admin?tab=users&page_size=1'); const user = userEvent.setup();
  await screen.findByText('Person');
  expect(screen.getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Name','Email','Role','Status','Last sign-in','Actions']);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('Second'); expect(screen.getByLabelText('Current route')).toHaveTextContent('page=2');
  await user.click(screen.getByRole('button', { name: 'Previous' })); await screen.findByText('Person');
  await user.click(screen.getByRole('link', { name: 'Roles' }));
  await screen.findByText('Engineer duties'); expect(screen.getByLabelText('Current route')).toHaveTextContent('tab=roles');
  expect(screen.queryByText('Audit log')).not.toBeInTheDocument();
});
it('creates all fields with inline required errors then renders requery and edit facts without password', async () => {
  mount(); const user = userEvent.setup(); await screen.findByRole('table');
  await user.click(screen.getByRole('button', { name: 'New user' })); await screen.findByRole('heading', { name: 'New user' });
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByText('Name is required')).toBeVisible(); expect(writes).toHaveLength(0);
  await user.type(screen.getByLabelText('Name'), 'Created');
  await user.type(screen.getByLabelText('Email'), 'created@portfolio.local');
  await user.type(screen.getByLabelText('Manager name'), 'Lead');
  await user.selectOptions(screen.getByLabelText('Role'), 'Executive');
  await user.click(screen.getByLabelText('Payments'));
  await user.click(screen.getByLabelText('Vendor indicator'));
  await user.type(screen.getByLabelText('Initial password'), 'Initial123!');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Created');
  expect(writes[0].body).toEqual({ name: 'Created', email: 'created@portfolio.local', managerName: 'Lead', role: 'Executive',
    portfolioAccess: ['p1'], status: 'Active', vendor: true, initialPassword: 'Initial123!' });
  await user.click(screen.getByRole('button', { name: 'Edit Created' })); await screen.findByRole('heading', { name: 'Edit user' });
  expect(screen.getByLabelText('Manager name')).toHaveValue('Lead');
  expect(screen.getByLabelText('Payments')).toBeChecked(); expect(screen.queryByLabelText('Initial password')).not.toBeInTheDocument();
  await user.clear(screen.getByLabelText('Name')); await user.type(screen.getByLabelText('Name'), 'Renamed');
  await user.click(screen.getByRole('button', { name: 'Save' })); await screen.findByText('Renamed');
  expect(writes[1].body).not.toHaveProperty('initialPassword');
});
it.each([409,403,503])('preserves edit input and shows server save failure %s', async status => {
  mount(); const user = userEvent.setup(); await screen.findByText('Person');
  await user.click(screen.getByRole('button', { name: 'Edit Person' })); await screen.findByLabelText('Name');
  failure = status; await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText(status === 409 ? 'Email already exists.' : 'Save denied.')).toBeVisible();
  expect(screen.getByLabelText('Name')).toHaveValue('Person');
  if (status === 409) expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
});
it('deactivation cancel and confirm revoke through full maintenance and requery inactive row', async () => {
  mount(); const user = userEvent.setup(); await screen.findByText('Person');
  await user.click(screen.getByRole('button', { name: 'Deactivate Person' }));
  const dialog = screen.getByRole('dialog'); expect(within(dialog).getByText(/Audit history is retained/)).toBeVisible();
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' })); expect(writes).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'Deactivate Person' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }));
  await screen.findByText('User deactivated.');
  expect(writes[0].body.status).toBe('Inactive');
  expect(screen.queryByRole('button', { name: 'Deactivate Person' })).not.toBeInTheDocument();
});
it('edit status requires confirmation and cancel keeps the editable facts', async () => {
  mount(); const user = userEvent.setup(); await screen.findByText('Person');
  await user.click(screen.getByRole('button', { name: 'Edit Person' })); await screen.findByLabelText('Status');
  await user.selectOptions(screen.getByLabelText('Status'), 'Inactive'); await user.click(screen.getByRole('button', { name: 'Save' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
  expect(writes).toHaveLength(0); expect(screen.getByLabelText('Status')).toHaveValue('Inactive');
});
it('persists role description and all six selectable permissions without name changes', async () => {
  mount('/admin?tab=roles'); const user = userEvent.setup(); await screen.findByText('Engineer duties');
  await user.click(screen.getByRole('button', { name: 'Edit Engineer' }));
  expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  expect(screen.getAllByRole('checkbox')).toHaveLength(6);
  await user.clear(screen.getByLabelText('Description')); await user.type(screen.getByLabelText('Description'), 'Updated');
  await user.click(screen.getByLabelText('edit')); await user.click(screen.getByLabelText('administer'));
  await user.click(screen.getByRole('button', { name: 'Save' })); await screen.findByText('Updated');
  expect(writes[0].body).toEqual({ description: 'Updated', permissions: ['view', 'administer'] });
});
it('shows role save denial and supports cancel', async () => {
  mount('/admin?tab=roles'); const user = userEvent.setup(); await screen.findByText('Engineer duties');
  await user.click(screen.getByRole('button', { name: 'Edit Engineer' })); failure = 403;
  await user.click(screen.getByRole('button', { name: 'Save' })); expect(await screen.findByText('Save denied.')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Cancel' })); await screen.findByText('Engineer duties');
});
it.each(['/admin','/admin?tab=roles'])('supports empty and retryable list error %s', async path => {
  readFailure = true; mount(path); const user = userEvent.setup();
  expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable.');
  readFailure = false; rows = []; roles = [];
  await user.click(screen.getByRole('button', { name: 'Retry' })); expect(await screen.findByText('No records match these filters.')).toBeVisible();
});
it.each(['Executive','Auditor','Read Only'])('denies %s even with configured administer', async role => {
  actor.role = role as User['role']; mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('You do not have access to administration.');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});
it('denies administrator without permission and routes forced change to profile', async () => {
  actor.permissions = []; const view = mount(); expect(await screen.findByRole('alert')).toBeVisible(); view.unmount();
  actor.permissions = ['administer']; actor.mustChangePassword = true; mount();
  expect(await screen.findByRole('heading', { name: 'My Profile' })).toBeVisible();
});
it('shows pending save and ignores double submission', async () => {
  mount(); const user = userEvent.setup(); await screen.findByText('Person');
  await user.click(screen.getByRole('button', { name: 'Edit Person' })); await screen.findByLabelText('Name');
  let resolve!: (value: Response) => void;
  defer = () => new Promise<Response>(done => { resolve = done; });
  await user.dblClick(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled(); expect(writes).toHaveLength(1);
  resolve(json(rows[0])); await screen.findByText('User saved.');
});
it('surfaces form-choice failure and deactivation failure', async () => {
  mount(); const user = userEvent.setup(); await screen.findByText('Person'); readFailure = true;
  await user.click(screen.getByRole('button', { name: 'New user' })); expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable.');
  readFailure = false; failure = 403;
  await user.click(screen.getByRole('button', { name: 'Deactivate Person' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Save denied.');
  expect(rows[0].status).toBe('Active');
});

it.each(['/admin','/admin?tab=roles'])('shows loading skeleton while the real list request is pending %s', async path => {
  const original = globalThis.fetch;
  let resolve!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    if (String(input).endsWith('/auth/me')) return json(actor);
    return new Promise<Response>(done => { resolve = done; });
  }));
  mount(path);
  expect(await screen.findByText(path.includes('roles') ? 'Loading roles…' : 'Loading users…')).toBeVisible();
  expect(document.querySelector('.skeleton-value')).not.toBeNull();
  resolve(path.includes('roles') ? json([]) : json({ items: [], total: 0, page: 1, page_size: 10 }));
  expect(await screen.findByText('No records match these filters.')).toBeVisible();
  vi.stubGlobal('fetch', original);
});

it('shows email validation and initial password byte-limit errors without sending writes', async () => {
  mount(); const user = userEvent.setup(); await screen.findByRole('table');
  await user.click(screen.getByRole('button', { name: 'New user' })); await screen.findByLabelText('Initial password');
  await user.type(screen.getByLabelText('Name'), 'Valid'); await user.type(screen.getByLabelText('Email'), 'invalid');
  await user.type(screen.getByLabelText('Initial password'), 'é'.repeat(37));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByText('Enter a valid email')).toBeVisible();
  expect(screen.getByText('Password must be at most 72 UTF-8 bytes')).toBeVisible();
  expect(writes).toHaveLength(0);
});
