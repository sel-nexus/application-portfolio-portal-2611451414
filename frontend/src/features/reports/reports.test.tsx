/** Verify report navigation, matching columns, URL queries and export feedback. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from '../identity/AuthContext';
import ReportsPage from './ReportsPage';
import { TOKEN_KEY } from '../../api';
import type { ApplicationDetail, PortfolioSummary, User } from '../../types';

const application: ApplicationDetail = { id: 'a1', name: 'Gateway', portfolioId: 'p1', portfolio: 'Payments',
  description: '', productArea: 'Commerce', businessOwner: '', technologyOwner: '', qualityOwner: '',
  criticality: 'Critical', tier: 4, lifecycle: 'Active', technologyStack: '', repositoryLink: '', pipelineLink: '',
  healthScore: 72, qualityScore: 81, automationCoverage: 64, unitTestCoverage: 80, openDefects: 5,
  openCriticalDefects: 3, risk: 'High' };
const portfolio: PortfolioSummary = { id: 'p1', name: 'Payments', owner: 'Owner', description: '',
  productArea: 'Commerce', status: 'Active', applicationCount: 4, qualityScore: 72 };
const appLabels = ['Name', 'Portfolio', 'Criticality', 'Tier', 'Lifecycle', 'Health', 'Automation %', 'Open Critical Defects', 'Risk'];
const portLabels = ['Name', 'Owner', 'Product Area', 'Applications', 'Quality Score', 'Status'];
let actor: User;
let requests: string[];
let failure: number;
let empty: boolean;
let csvResponse: () => Promise<Response>;
let tableResponse: (() => Promise<Response>) | null;

/** Preserve real response parsing while substituting only fetch. */
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
/** Expose URL state as an observable browser navigation outcome. */
function Location() {
  const location = useLocation();
  return <output aria-label="Current route">{location.pathname}{location.search}</output>;
}
/** Mount actual auth hydration and report components with the existing route parameter. */
function mount(path = '/reports') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Location />
        <Routes>
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/reports/:report" element={<ReportsPage />} />
          <Route path="/profile" element={<h1>My Profile</h1>} />
          <Route path="/applications/:id" element={<h1>Application detail</h1>} />
          <Route path="/portfolios/:id" element={<h1>Portfolio detail</h1>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  actor = { id: 'u1', name: 'Executive', email: 'executive@portfolio.local', role: 'Executive', permissions: ['view', 'export'],
    portfolioAccess: [], portfolioNames: [], status: 'Active', managerName: '', vendor: false,
    mustChangePassword: false, defaultLanding: 'Dashboard', lastSignIn: null };
  requests = []; failure = 0; empty = false; tableResponse = null;
  localStorage.setItem(TOKEN_KEY, 'session');
  csvResponse = async () => new Response('Name,Owner\r\nPayments,Owner\r\n', { status: 200 });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://test'); requests.push(url.pathname + url.search);
    if (url.pathname.endsWith('/auth/me')) return json(actor);
    if (url.pathname.endsWith('/csv')) return csvResponse();
    if (tableResponse) return tableResponse();
    if (failure) return json({ detail: 'The service is unavailable.' }, failure);
    const isApp = url.pathname.includes('/applications');
    const rows = isApp ? [application, { ...application, id: 'a2', name: 'Second' }] : [portfolio, { ...portfolio, id: 'p2', name: 'Second' }];
    const filtered = rows.filter(row => !empty && row.name.includes(url.searchParams.get('search') ?? ''));
    const page = Number(url.searchParams.get('page') ?? 1); const size = Number(url.searchParams.get('page_size') ?? 10);
    return json({ items: filtered.slice((page - 1) * size, page * size), total: filtered.length, page, page_size: size,
      portfolios: [{ id: 'p1', name: 'Payments' }], criticalities: ['Critical'], risks: ['High'], lifecycles: ['Active'],
      productAreas: ['Commerce'], statuses: ['Active'] });
  }));
  vi.stubGlobal('URL', URL);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:csv') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([['Application Report', 'applications', appLabels], ['Portfolio Report', 'portfolios', portLabels]])(
  'opens %s from the index and shows prescribed columns then returns', async (title, kind, labels) => {
    mount(); const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: title }));
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(labels);
    expect(screen.getByRole('heading', { name: title })).toBeVisible();
    expect(screen.getByLabelText('Current route')).toHaveTextContent(`/reports/${kind}`);
    expect(screen.getByRole('button', { name: 'Download CSV' })).toBeEnabled();
    await user.click(screen.getByRole('link', { name: 'Back to reports' }));
    expect(screen.getByRole('heading', { name: 'Reports' })).toBeVisible();
  },
);
it.each([['applications', ['Gateway', 'Payments', 'Critical', '4', 'Active', '72', '64', '3', 'High']],
  ['portfolios', ['Payments', 'Owner', 'Commerce', '4', '72', 'Active']]])('renders %s values and clickable names', async (kind, values) => {
  mount(`/reports/${kind}`);
  const table = await screen.findByRole('table');
  expect(within(table).getAllByRole('row')[1].textContent).toBe(values.join(''));
  await userEvent.setup().click(within(table).getByRole('link', { name: kind === 'applications' ? 'Gateway' : 'Payments' }));
  expect(screen.getByRole('heading', { name: kind === 'applications' ? 'Application detail' : 'Portfolio detail' })).toBeVisible();
});
it.each(['applications', 'portfolios'])('retains %s URL paging and resets page on filtering and clear', async kind => {
  mount(`/reports/${kind}?page_size=1`); const user = userEvent.setup();
  await screen.findByRole('table');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByText('Showing 2–2 of 2')).toBeVisible();
  expect(screen.getByLabelText('Current route')).toHaveTextContent('page=2');
  await user.click(screen.getByRole('button', { name: 'Previous' }));
  await screen.findByText('Showing 1–1 of 2');
  await user.type(screen.getByLabelText('Search by name'), kind === 'applications' ? 'Gateway' : 'Payments');
  await screen.findByText('Showing 1–1 of 1');
  expect(screen.getByLabelText('Current route').textContent).not.toContain('page=');
  await user.click(screen.getByRole('button', { name: 'Clear filters' }));
  await screen.findByText('Showing 1–2 of 2');
  expect(screen.getByLabelText('Search by name')).toHaveValue('');
});
it.each([['Portfolio', 'p1', 'portfolioId=p1'], ['Criticality', 'Critical', 'criticality=Critical'],
  ['Risk', 'High', 'risk=High'], ['Lifecycle', 'Active', 'lifecycle=Active'],
  ['Status', 'Active', 'status=Active'], ['Product area', 'Commerce', 'productArea=Commerce']])(
  'puts %s in the matching report query and removes it when All is selected', async (label, value, query) => {
    mount(`/reports/${label === 'Status' || label === 'Product area' ? 'portfolios' : 'applications'}?page=2`);
    const user = userEvent.setup(); await screen.findByRole('table');
    await user.selectOptions(screen.getByLabelText(label), value);
    await waitFor(() => expect(requests.at(-1)).toContain(query));
    expect(screen.getByLabelText('Current route').textContent).not.toContain('page=');
    await user.selectOptions(screen.getByLabelText(label), '');
    expect(screen.getByLabelText('Current route').textContent).not.toContain(query);
  },
);
it.each(['applications', 'portfolios'])('shows %s empty, pending and retryable failure without stale table', async kind => {
  let resolve!: (value: Response) => void;
  tableResponse = () => new Promise<Response>(done => { resolve = done; });
  mount(`/reports/${kind}`);
  expect(await screen.findByText(`Loading ${kind}…`)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Download CSV' })).toBeDisabled();
  resolve(json({ detail: 'The service is unavailable.' }, 503));
  expect(await screen.findByRole('alert')).toHaveTextContent('The service is unavailable.');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  tableResponse = null; empty = true;
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('No records match these filters.')).toBeVisible();
});
it.each(['applications', 'portfolios'])('hides %s export for Read Only even if configured', async kind => {
  actor.role = 'Read Only'; mount(`/reports/${kind}`);
  await screen.findByRole('table');
  expect(screen.queryByRole('button', { name: 'Download CSV' })).not.toBeInTheDocument();
});
it('denies missing view and sends forced-password sessions to profile', async () => {
  actor.permissions = []; const view = mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission');
  view.unmount(); actor.permissions = ['view', 'export']; actor.mustChangePassword = true;
  mount('/reports/applications');
  expect(await screen.findByRole('heading', { name: 'My Profile' })).toBeVisible();
  expect(requests.some(path => path.startsWith('/api/v1/reports/'))).toBe(false);
});
it.each(['applications', 'portfolios'])('downloads %s current filters without paging and ignores double click', async kind => {
  let resolve!: (value: Response) => void;
  csvResponse = () => new Promise<Response>(done => { resolve = done; });
  mount(`/reports/${kind}?search=${kind === 'applications' ? 'Gateway' : 'Payments'}&page=1&page_size=1`);
  await screen.findByRole('table');
  await userEvent.setup().dblClick(screen.getByRole('button', { name: 'Download CSV' }));
  expect(screen.getByRole('button', { name: 'Downloading…' })).toBeDisabled();
  const exports = requests.filter(path => path.includes('/csv'));
  expect(exports).toHaveLength(1); expect(exports[0]).not.toContain('page'); expect(exports[0]).toContain('search=');
  resolve(new Response('Name\r\nMatched\r\n', { status: 200 }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Download CSV' })).toBeEnabled());
  expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:csv');
});
it.each([403, 401, 503, 0])('surfaces export failure %s and clears expired bearer', async status => {
  csvResponse = async () => { if (!status) throw new Error('Offline'); return json({ detail: 'Export denied.' }, status); };
  mount('/reports/applications'); await screen.findByRole('table');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Download CSV' }));
  if (status === 401) await waitFor(() => expect(localStorage.getItem(TOKEN_KEY)).toBeNull());
  else expect(await screen.findByRole('alert')).toHaveTextContent(status ? 'Export denied.' : 'Offline');
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it.each(['applications', 'portfolios'])('hides %s export when current export permission is absent', async kind => {
  actor.permissions = ['view']; mount(`/reports/${kind}`);
  await screen.findByRole('table');
  expect(screen.queryByRole('button', { name: 'Download CSV' })).not.toBeInTheDocument();
});
it('surfaces malformed export errors and non-Error rejection safely', async () => {
  csvResponse = async () => new Response('invalid-json', { status: 503 });
  mount('/reports/portfolios'); await screen.findByRole('table');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Download CSV' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to download CSV.');
  csvResponse = async () => { throw 'untyped failure'; };
  await user.click(screen.getByRole('button', { name: 'Download CSV' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to download CSV.');
});
it('recovers a table network failure via Retry', async () => {
  tableResponse = async () => { throw new Error('offline'); };
  mount('/reports/applications');
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to connect.');
  tableResponse = null;
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('table')).toBeVisible();
});
