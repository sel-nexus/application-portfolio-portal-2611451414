/** Verify audit access, URL interactions, accessible states and authorized downloads. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from '../identity/AuthContext';
import { Shell } from '../../components/Shell';
import AdminPage from '../admin/AdminPage';
import AuditPage from './AuditPage';
import { TOKEN_KEY } from '../../api';
import type { AuditEvent, User } from '../../types';

let actor: User;
let requests: string[];
let tableResponse: (() => Promise<Response>) | null;
let csvResponse: () => Promise<Response>;
let empty: boolean;
const event: AuditEvent = { id: 'e1', time: '2025-02-02T23:59:59Z', person: 'Historical actor',
  action: 'edit', entityType: 'application', entityId: 'a1', summary: 'Updated application.' };

/** Preserve actual HTTP response parsing while stubbing the network boundary only. */
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
/** Render shareable location as a user-observable navigation result. */
function Location() {
  const location = useLocation();
  return <output aria-label="Current route">{location.pathname}{location.search}</output>;
}
/** Mount actual shell/auth and both history entry points. */
function mount(path = '/audit') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Location />
        <Routes>
          <Route element={<Shell />}>
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/applications" element={<h1>Applications</h1>} />
            <Route path="/profile" element={<h1>My Profile</h1>} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  actor = { id: 'u1', name: 'Admin', email: 'admin@portfolio.local', role: 'Administrator',
    permissions: ['administer', 'view', 'export'], portfolioAccess: [], portfolioNames: [], status: 'Active',
    managerName: '', vendor: false, mustChangePassword: false, defaultLanding: 'Applications', lastSignIn: null };
  requests = []; empty = false; tableResponse = null;
  csvResponse = async () => new Response('time,person,action,entityType,summary\r\n', { status: 200 });
  // jsdom does not implement the browser dialog methods used by the existing Users tab.
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn() });
  localStorage.setItem(TOKEN_KEY, 'session');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://test'); requests.push(url.pathname + url.search);
    if (url.pathname.endsWith('/auth/me')) return json(actor);
    if (url.pathname.endsWith('/csv')) return csvResponse();
    if (url.pathname.endsWith('/audit')) {
      if (tableResponse) return tableResponse();
      const rows = [event, { ...event, id: 'e2', time: '2025-02-01T00:00:00Z', summary: 'Earlier update.' }];
      const matching = rows.filter(row => !empty && (!url.searchParams.get('person') || row.person === url.searchParams.get('person'))
        && (!url.searchParams.get('action') || row.action === url.searchParams.get('action'))
        && (!url.searchParams.get('from') || row.time.slice(0, 10) >= url.searchParams.get('from')!)
        && (!url.searchParams.get('to') || row.time.slice(0, 10) <= url.searchParams.get('to')!));
      const page = Number(url.searchParams.get('page') ?? 1), size = Number(url.searchParams.get('page_size') ?? 10);
      return json({ items: matching.slice((page - 1) * size, page * size), total: matching.length, page, page_size: size,
        persons: ['Historical actor', 'Unknown person'], actions: ['edit', 'export'] });
    }
    if (url.pathname.endsWith('/admin/users')) return json({ items: [], total: 0, page: 1, page_size: 10 });
    return json([]);
  }));
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:audit') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('opens admin Audit log tab by a link and renders all prescribed columns and stored facts', async () => {
  mount('/admin');
  await userEvent.setup().click(await screen.findByRole('link', { name: 'Audit log' }));
  const table = await screen.findByRole('table');
  expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Time', 'Person', 'Action', 'Entity type', 'Summary']);
  expect(within(table).getAllByRole('row')[1]).toHaveTextContent('2025-02-02 23:59:59 UTCHistorical actoreditapplicationUpdated application.');
  expect(screen.getByRole('link', { name: 'Audit log' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByLabelText('Current route')).toHaveTextContent('/admin?tab=audit');
  expect(requests.filter(path => path.includes('/audit')).every(path => !path.includes('tab='))).toBe(true);
});
it('offers Auditor separate history navigation with no Administration or export', async () => {
  actor.role = 'Auditor'; actor.permissions = ['view', 'export', 'administer'];
  mount('/applications');
  await userEvent.setup().click(await screen.findByRole('link', { name: 'Audit history' }));
  await screen.findByRole('table');
  expect(screen.getByRole('heading', { name: 'Audit history' })).toBeVisible();
  expect(screen.queryByRole('link', { name: 'Administration' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Download CSV' })).not.toBeInTheDocument();
});
it.each(['Executive', 'Portfolio Leader', 'Engineer', 'Read Only'] as const)('denies %s even with sensitive permissions before requesting history', async role => {
  actor.role = role; mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('You do not have access to audit history.');
  expect(requests.some(path => path.includes('/audit'))).toBe(false);
});
it.each([['Administrator', ['view', 'export']], ['Auditor', ['export', 'administer']]] as const)(
  'denies %s without the required current permission', async (role, permissions) => {
    actor.role = role; actor.permissions = [...permissions]; mount();
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(requests.some(path => path.includes('/audit'))).toBe(false);
  },
);
it('redirects a forced session and denies Auditor direct administration', async () => {
  actor.mustChangePassword = true; const view = mount();
  expect(await screen.findByRole('heading', { name: 'My Profile' })).toBeVisible();
  expect(requests.some(path => path.includes('/audit'))).toBe(false);
  view.unmount(); actor.mustChangePassword = false; actor.role = 'Auditor'; mount('/admin?tab=audit');
  expect(await screen.findByRole('alert')).toHaveTextContent('You do not have access to administration.');
});
it('preserves paging, filters and tab in URL and clears only audit filter state', async () => {
  mount('/admin?tab=audit&page_size=1'); const user = userEvent.setup();
  await screen.findByRole('table');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByText('Showing 2–2 of 2')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Previous' }));
  await screen.findByText('Showing 1–1 of 2');
  await user.selectOptions(screen.getByLabelText('Person'), 'Historical actor');
  await screen.findByRole('table');
  expect(screen.getByLabelText('Current route').textContent).not.toContain('page=');
  await user.selectOptions(screen.getByLabelText('Action'), 'edit');
  fireEvent.change(screen.getByLabelText('From date (UTC)'), { target: { value: '2025-02-02' } });
  await screen.findByText('Showing 1–1 of 1');
  fireEvent.change(screen.getByLabelText('To date (UTC)'), { target: { value: '2025-02-02' } });
  await waitFor(() => expect(requests.at(-1)).toContain('to=2025-02-02'));
  expect(screen.getByLabelText('Current route')).toHaveTextContent('tab=audit');
  await user.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(await screen.findByText('Showing 1–2 of 2')).toBeVisible();
  expect(screen.getByLabelText('Current route').textContent).toBe('/admin?tab=audit');
  expect(screen.getByLabelText('From date (UTC)')).toHaveValue('');
});
it('keeps unknown URL choices visible and shows empty filtered results', async () => {
  mount('/audit?person=Missing&action=Unknown');
  expect(await screen.findByText('No records match these filters.')).toBeVisible();
  expect(screen.getByLabelText('Person')).toHaveValue('Missing');
  expect(screen.getByLabelText('Action')).toHaveValue('Unknown');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(await screen.findByText('Updated application.')).toBeVisible();
});
it('associates invalid interval error, blocks download and recovers after correction', async () => {
  mount('/audit?from=2025-02-03&to=2025-02-02');
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('To date must be on or after From date.');
  expect(screen.getByLabelText('To date (UTC)')).toHaveAttribute('aria-describedby', alert.id);
  expect(screen.getByRole('button', { name: 'Download CSV' })).toBeDisabled();
  expect(requests.some(path => path.includes('/audit'))).toBe(false);
  fireEvent.change(screen.getByLabelText('From date (UTC)'), { target: { value: '2025-02-02' } });
  expect(await screen.findByRole('table')).toBeVisible();
});
it('shows accessible loading then error and retry to empty without stale table', async () => {
  let resolve!: (value: Response) => void;
  tableResponse = () => new Promise(done => { resolve = done; });
  mount();
  expect(await screen.findByText('Loading audit history…')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Download CSV' })).toBeDisabled();
  resolve(json({ detail: 'Service unavailable.' }, 503));
  expect(await screen.findByRole('alert')).toHaveTextContent('Service unavailable.');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  tableResponse = null; empty = true;
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('No records match these filters.')).toBeVisible();
});
it('surfaces a network error and retry recovers', async () => {
  tableResponse = async () => { throw new Error('offline'); }; mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to connect.');
  tableResponse = null;
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('table')).toBeVisible();
});
it('downloads current filters without paging, ignores duplicate click, and requeries history', async () => {
  let resolve!: (value: Response) => void;
  csvResponse = () => new Promise(done => { resolve = done; });
  mount('/admin?tab=audit&person=Historical+actor&action=edit&from=2025-02-02&to=2025-02-02&page=1&page_size=1');
  await screen.findByRole('table');
  const before = requests.filter(path => path.startsWith('/api/v1/audit?')).length;
  await userEvent.setup().dblClick(screen.getByRole('button', { name: 'Download CSV' }));
  expect(screen.getByRole('button', { name: 'Downloading…' })).toBeDisabled();
  expect(screen.getByText('Preparing audit CSV…')).toHaveAttribute('role', 'status');
  const exports = requests.filter(path => path.includes('/csv'));
  expect(exports).toHaveLength(1);
  expect(exports[0]).toBe('/api/v1/audit/csv?person=Historical+actor&action=edit&from=2025-02-02&to=2025-02-02');
  resolve(new Response('time,person,action,entityType,summary\r\n', { status: 200 }));
  await waitFor(() => expect(requests.filter(path => path.startsWith('/api/v1/audit?')).length).toBe(before + 1));
  await screen.findByRole('table');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:audit');
});
it.each([403, 503, 0, -1])('reports CSV error %s without generating a download', async status => {
  csvResponse = async () => {
    if (status === 0) throw new Error('Offline');
    if (status === -1) return new Response('malformed', { status: 503 });
    return json({ detail: 'Export denied.' }, status);
  };
  mount(); await screen.findByRole('table');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Download CSV' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(status === 0 ? 'Offline' : status === -1 ? 'Unable to download CSV.' : 'Export denied.');
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Download CSV' })).toBeEnabled();
});
it('clears expired bearer on CSV refusal', async () => {
  csvResponse = async () => json({ detail: 'Expired.' }, 401);
  mount(); await screen.findByRole('table');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Download CSV' }));
  await waitFor(() => expect(localStorage.getItem(TOKEN_KEY)).toBeNull());
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it('hides Administrator CSV when export permission is absent', async () => {
  actor.permissions = ['administer']; mount(); await screen.findByRole('table');
  expect(screen.queryByRole('button', { name: 'Download CSV' })).not.toBeInTheDocument();
});
it('surfaces structured and non-Error CSV refusals safely', async () => {
  csvResponse = async () => json({ detail: { action: 'denied' } }, 403);
  mount(); await screen.findByRole('table'); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Download CSV' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to download CSV.');
  csvResponse = async () => { throw 'untyped failure'; };
  await user.click(screen.getByRole('button', { name: 'Download CSV' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to download CSV.');
});
