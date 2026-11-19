/** Verify portfolio pages through real routing, auth, and fetch-boundary interactions. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../../App';
import { TOKEN_KEY } from '../../api';
import type { PortfolioDetail, User } from '../../types';

const initial: User = {
  id: 'actor', name: 'Test Admin', email: 'admin@portfolio.local', role: 'Administrator',
  permissions: ['view', 'create', 'edit', 'delete'], portfolioAccess: ['p1'], portfolioNames: ['Payments'],
  status: 'Active', managerName: '', vendor: false, mustChangePassword: false,
  defaultLanding: 'Dashboard', lastSignIn: null,
};
const portfolio: PortfolioDetail = {
  id: 'p1', name: 'Payments', owner: 'Casey Rivera', productArea: 'Commerce',
  description: 'Stored portfolio description', status: 'Active', applicationCount: 1, qualityScore: 81,
  applications: [{ id: 'a1', name: 'Payment Gateway' }],
};
let actor: User;
let rows: PortfolioDetail[];
let failure: string;
let writeFailure: number;
let requests: { url: string; method: string; body: unknown }[];

/** Build a standard Response, retaining the production HTTP error parser. */
function response(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status });
}

beforeEach(() => {
  actor = structuredClone(initial); rows = [structuredClone(portfolio)]; failure = ''; writeFailure = 0; requests = [];
  localStorage.setItem(TOKEN_KEY, 'test-session');
  window.history.replaceState({}, '', '/portfolios');
  // jsdom lacks native dialog methods; polyfill only the browser boundary.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open'); } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    const url = new URL(String(input), 'http://test');
    const method = options?.method ?? 'GET';
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    requests.push({ url: url.pathname + url.search, method, body });
    if (url.pathname.endsWith('/auth/me')) return response(actor);
    if (failure) return response({ detail: failure }, 404);
    if (method !== 'GET' && writeFailure) return response({ detail: writeFailure === 409 ? { name: 'A portfolio with this name already exists.' } : 'Service unavailable.' }, writeFailure);
    if (url.pathname === '/api/v1/portfolios' && method === 'GET') {
      const search = url.searchParams.get('search') ?? '';
      const status = url.searchParams.get('status');
      const area = url.searchParams.get('productArea');
      const filtered = rows.filter(row => row.name.toLowerCase().includes(search.toLowerCase()) && (!status || row.status === status) && (!area || row.productArea === area));
      const page = Number(url.searchParams.get('page') ?? 1);
      return response({ items: filtered.slice((page - 1) * 10, page * 10), total: filtered.length, page, page_size: 10,
        productAreas: ['Commerce'], statuses: ['Active', 'Archived'] });
    }
    const id = url.pathname.split('/').at(-1);
    if (method === 'POST') {
      const row = { ...body, id: 'created-id', applicationCount: 0, qualityScore: 0, applications: [] };
      rows.push(row); return response(row, 201);
    }
    const row = rows.find(row => row.id === id);
    if (!row) return response({ detail: 'This record is not available.' }, 404);
    if (method === 'PUT') { Object.assign(row, body); return response(row); }
    if (method === 'DELETE') {
      if (row.applicationCount) return response({ detail: 'This portfolio contains applications. Move or delete them before deleting the portfolio.' }, 409);
      rows = rows.filter(item => item.id !== id); return response(null, 204);
    }
    return response(row);
  });
});
afterEach(() => vi.restoreAllMocks());

it('renders scoped columns and navigates from the shell to detail with stored application names', async () => {
  window.history.replaceState({}, '', '/profile'); render(<App />);
  await screen.findByRole('heading', { name: 'My Profile' });
  await userEvent.setup().click(screen.getByRole('link', { name: 'Portfolios' }));
  await screen.findByRole('columnheader', { name: 'Quality Score' });
  expect(screen.getByRole('cell', { name: '81' })).toBeVisible();
  expect(screen.queryByRole('option', { name: 'Data' })).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('link', { name: 'Payments' }));
  expect(await screen.findByText('Stored portfolio description')).toBeVisible();
  expect(screen.getByText('Payment Gateway')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Payment Gateway' })).toHaveAttribute('href', '/applications/a1');
});

it('interacts with URL filters, clear and next/previous paging', async () => {
  rows = Array.from({ length: 11 }, (_, i) => ({ ...portfolio, id: `p${i}`, name: `Portfolio ${i}` }));
  render(<App />); await screen.findByRole('table'); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByText('Showing 11–11 of 11')).toBeVisible();
  expect(window.location.search).toContain('page=2');
  await user.click(screen.getByRole('button', { name: 'Previous' }));
  await screen.findByText('Showing 1–10 of 11');
  await user.type(screen.getByLabelText('Search by name'), 'unmatched');
  expect(await screen.findByText('No records match these filters.')).toBeVisible();
  await user.selectOptions(screen.getByLabelText('Status'), 'Archived');
  await user.selectOptions(screen.getByLabelText('Product area'), 'Commerce');
  await waitFor(() => expect(window.location.search).toContain('productArea=Commerce'));
  await user.click(screen.getByRole('button', { name: 'Clear filters' }));
  await screen.findByText('Showing 1–10 of 11');
  expect(window.location.search).toBe('');
});

it('shows loading and retryable list failure without stale rows', async () => {
  failure = 'This record is not available.'; render(<App />);
  expect(await screen.findByRole('alert')).toHaveTextContent(failure);
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  failure = ''; await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('table');
});

it('keeps resource loading visible until the boundary response arrives', async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  let finish!: (value: Response) => void;
  vi.mocked(fetch).mockImplementation((input, options) => String(input).includes('/portfolios')
    ? new Promise<Response>(resolve => { finish = resolve; }) : original(input, options));
  render(<App />);
  expect(await screen.findByText('Loading portfolios…')).toBeVisible();
  finish(response({ items: [], total: 0, page: 1, page_size: 10, productAreas: [], statuses: [] }));
  expect(await screen.findByText('No records match these filters.')).toBeVisible();
});

it('creates all fields, validates required name and shows save success', async () => {
  render(<App />); await screen.findByRole('table'); const user = userEvent.setup();
  await user.click(screen.getByRole('link', { name: 'New portfolio' }));
  await screen.findByRole('heading', { name: 'New portfolio' });
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByText('Name is required')).toBeVisible();
  expect(screen.getByLabelText('Name')).toHaveAttribute('aria-describedby', 'portfolio-name-error');
  await user.type(screen.getByLabelText('Name'), 'New inventory');
  await user.type(screen.getByLabelText('Owner'), 'Owner');
  await user.type(screen.getByLabelText('Product area'), 'New area');
  await user.type(screen.getByLabelText('Description'), 'New description');
  await user.selectOptions(screen.getByLabelText('Status'), 'Archived');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Portfolio saved.')).toBeVisible();
  expect(screen.getByText('No applications in this portfolio.')).toBeVisible();
  expect(requests.find(row => row.method === 'POST')?.body).toEqual({ name: 'New inventory', owner: 'Owner', description: 'New description', productArea: 'New area', status: 'Archived' });
});

it.each([409, 503])('retains edit values and exposes save failure %s', async status => {
  window.history.replaceState({}, '', '/portfolios/p1/edit'); render(<App />);
  const name = await screen.findByLabelText('Name'); const user = userEvent.setup();
  expect(name).toHaveValue('Payments'); writeFailure = status;
  await user.clear(screen.getByLabelText('Owner')); await user.type(screen.getByLabelText('Owner'), 'Changed');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText(status === 409 ? 'A portfolio with this name already exists.' : 'Service unavailable.')).toBeVisible();
  expect(screen.getByLabelText('Owner')).toHaveValue('Changed');
  writeFailure = 0; await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Portfolio saved.')).toBeVisible();
  expect(screen.getByText('Changed')).toBeVisible();
});

it('disables a pending save and can cancel form navigation', async () => {
  window.history.replaceState({}, '', '/portfolios/new'); render(<App />);
  const user = userEvent.setup(); await screen.findByLabelText('Name');
  await user.type(screen.getByLabelText('Name'), 'Pending');
  const original = vi.mocked(fetch).getMockImplementation()!;
  let finish!: (value: Response) => void;
  vi.mocked(fetch).mockImplementation((input, options) => options?.method === 'POST'
    ? new Promise<Response>(resolve => { finish = resolve; }) : original(input, options));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  finish(response({ ...portfolio, id: 'p1' }, 201)); await screen.findByRole('heading', { name: 'Payments' });
  await user.click(await screen.findByRole('link', { name: 'Edit portfolio' }));
  await screen.findByLabelText('Name'); await user.click(screen.getByRole('link', { name: 'Cancel' }));
  await screen.findByRole('heading', { name: 'Payments' });
});

it('guards occupied deletion, closes cancellation and deletes an empty portfolio', async () => {
  window.history.replaceState({}, '', '/portfolios/p1'); render(<App />);
  await screen.findByRole('heading', { name: 'Payments' }); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Delete portfolio' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(requests.some(row => row.method === 'DELETE')).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Delete portfolio' }));
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByText(/This portfolio contains applications/)).toBeVisible();
  rows[0].applicationCount = 0; rows[0].applications = [];
  await user.click(screen.getByRole('button', { name: 'Delete portfolio' }));
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByText('Portfolio deleted.')).toBeVisible();
  expect(screen.getByText('No records match these filters.')).toBeVisible();
});

it.each(['Engineer', 'Read Only', 'Executive', 'Auditor'] as const)('hides mutation controls and refuses edit routes for %s', async role => {
  actor.role = role; window.history.replaceState({}, '', '/portfolios/p1'); render(<App />);
  await screen.findByRole('heading', { name: 'Payments' });
  expect(screen.queryByRole('link', { name: 'Edit portfolio' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Delete portfolio' })).not.toBeInTheDocument();
});

it('allows assigned leader edit but not creation/deletion, refusing unassigned edit', async () => {
  actor.role = 'Portfolio Leader'; window.history.replaceState({}, '', '/portfolios/p1');
  const rendered = render(<App />); await screen.findByRole('link', { name: 'Edit portfolio' });
  expect(screen.queryByRole('button', { name: 'Delete portfolio' })).not.toBeInTheDocument();
  rendered.unmount(); actor.portfolioAccess = []; window.history.replaceState({}, '', '/portfolios/p1/edit');
  render(<App />); expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission for this action.');
  expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
});

it.each(['/portfolios/p1', '/portfolios/p1/edit'])('does not reveal unavailable detail on %s and supports retry/back', async path => {
  failure = 'This record is not available.'; window.history.replaceState({}, '', path); render(<App />);
  expect(await screen.findByRole('alert')).toHaveTextContent(failure);
  expect(screen.queryByText('Casey Rivera')).not.toBeInTheDocument();
  failure = ''; await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
  if (path.endsWith('edit')) await screen.findByLabelText('Name'); else await screen.findByRole('heading', { name: 'Payments' });
});

it('routes forced users to profile and hides portfolio navigation', async () => {
  actor.mustChangePassword = true; render(<App />);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'My Profile' })).toBeVisible());
  expect(screen.queryByRole('link', { name: 'Portfolios' })).not.toBeInTheDocument();
  expect(window.location.pathname).toBe('/profile');
});

it('rejects unauthenticated portfolio routes', async () => {
  localStorage.clear(); render(<App />);
  expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});
