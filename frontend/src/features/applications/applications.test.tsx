/** Exercise real application pages and routing with fetch-only HTTP substitutes. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../../App';
import { TOKEN_KEY } from '../../api';
import type { ApplicationDetail, User } from '../../types';
const sample: ApplicationDetail = { id: 'a1', name: 'Gateway', portfolioId: 'p1', portfolio: 'Payments',
  description: 'Stored description', productArea: 'Commerce', businessOwner: 'Business', technologyOwner: 'Technology',
  qualityOwner: 'Quality', criticality: 'Critical', tier: 4, lifecycle: 'Active', technologyStack: 'Python React',
  repositoryLink: 'https://example.com/repo', pipelineLink: '', healthScore: 0, qualityScore: 100,
  automationCoverage: 45, unitTestCoverage: 80, openDefects: 3, openCriticalDefects: 2, risk: 'High' };
let actor: User;
let rows: ApplicationDetail[];
let failure: string;
let writeFailure: number;
let empty: boolean;
let requests: { url: string; method: string; body: Record<string, unknown> }[];
/** Return actual Response instances so production parsers remain exercised. */
function response(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status });
}
beforeEach(() => {
  actor = { id: 'actor', name: 'Admin', email: 'admin@portfolio.local', role: 'Administrator',
    permissions: ['view', 'create', 'edit', 'delete', 'export'], portfolioAccess: ['p1'], portfolioNames: ['Payments'],
    status: 'Active', managerName: '', vendor: false, mustChangePassword: false, defaultLanding: 'Dashboard', lastSignIn: null };
  rows = [structuredClone(sample)]; failure = ''; writeFailure = 0; empty = false; requests = [];
  localStorage.setItem(TOKEN_KEY, 'session'); window.history.replaceState({}, '', '/applications');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true,
    value: function (this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true,
    value: function (this: HTMLDialogElement) { this.removeAttribute('open'); } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    const url = new URL(String(input), 'http://test'); const method = options?.method ?? 'GET';
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    requests.push({ url: url.pathname + url.search, method, body });
    if (url.pathname.endsWith('/auth/me')) return response(actor);
    if (failure) return response({ detail: failure }, 404);
    if (url.pathname.endsWith('/csv')) return response({ detail: 'Export denied.' }, 403);
    if (method !== 'GET' && writeFailure) return response({ detail: writeFailure === 409
      ? { name: 'An application with this name already exists.' } : 'Service unavailable.' }, writeFailure);
    if (url.pathname === '/api/v1/applications' && method === 'GET') {
      const filtered = rows.filter(row => row.name.includes(url.searchParams.get('search') ?? '')
        && ['portfolioId', 'criticality', 'risk', 'lifecycle'].every(key => !url.searchParams.get(key)
          || row[key as keyof ApplicationDetail] === url.searchParams.get(key)));
      const page = Number(url.searchParams.get('page') ?? 1); const size = Number(url.searchParams.get('page_size') ?? 10);
      return response({ items: filtered.slice((page - 1) * size, page * size), total: filtered.length, page, page_size: size,
        portfolios: empty ? [] : [{ id: 'p1', name: 'Payments' }], criticalities: ['Low', 'Critical'], risks: ['Low', 'High'],
        lifecycles: ['Active', 'Retired'] });
    }
    if (url.pathname === '/api/v1/portfolios/p1') return response({ id: 'p1', name: 'Payments', owner: 'Owner',
      description: 'Portfolio description', productArea: 'Commerce', status: 'Active', applicationCount: 1,
      qualityScore: 100, applications: [{ id: 'a1', name: 'Gateway' }] });
    if (method === 'POST') { const row = { ...body, id: 'created', portfolio: 'Payments' }; rows.push(row); return response(row, 201); }
    const row = rows.find(row => row.id === url.pathname.split('/').at(-1));
    if (!row) return response({ detail: 'This record is not available.' }, 404);
    if (method === 'PUT') { Object.assign(row, body); return response(row); }
    if (method === 'DELETE') { rows = []; return response(null, 204); }
    return response(row);
  });
});
afterEach(() => vi.restoreAllMocks());
it('navigates list and portfolio entry and renders complete summary, ownership and four bars', async () => {
  render(<App />); await screen.findByRole('table'); const user = userEvent.setup();
  expect(screen.getAllByRole('columnheader')).toHaveLength(9);
  await user.click(screen.getByRole('link', { name: 'Gateway' })); await screen.findByText('Stored description');
  expect(screen.getAllByRole('progressbar')).toHaveLength(4);
  expect(screen.getByRole('progressbar', { name: 'Health' })).toHaveAttribute('aria-valuenow', '0');
  expect(screen.getByRole('progressbar', { name: 'Quality' })).toHaveAttribute('aria-valuenow', '100');
  expect(screen.getByText('Python React')).toBeVisible(); expect(screen.getByText('Business')).toBeVisible();
  await user.click(screen.getByRole('link', { name: 'Payments' })); await screen.findByRole('heading', { name: 'Payments' });
  await user.click(screen.getByRole('link', { name: 'Gateway' })); await screen.findByRole('heading', { name: 'Gateway' });
});
it('changes every URL filter, pages, clears and shows empty results', async () => {
  rows = Array.from({ length: 11 }, (_, index) => ({ ...sample, id: String(index), name: `Gateway ${index}` }));
  render(<App />); await screen.findByRole('table'); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Next' })); await screen.findByText('Showing 11–11 of 11');
  await user.click(screen.getByRole('button', { name: 'Previous' })); await screen.findByText('Showing 1–10 of 11');
  for (const [label, value] of [['Portfolio', 'p1'], ['Criticality', 'Critical'], ['Risk', 'High'], ['Lifecycle', 'Active']]) {
    await user.selectOptions(screen.getByLabelText(label), value); await screen.findByRole('table');
  }
  await user.type(screen.getByLabelText('Search by name'), 'absent'); await screen.findByText('No records match these filters.');
  expect(window.location.search).toContain('risk=High');
  await user.click(screen.getByRole('button', { name: 'Clear filters' })); await screen.findByRole('table');
  expect(window.location.search).toBe('');
});
it.each(['/applications', '/applications/a1', '/applications/a1/edit', '/applications/new'])('handles error and retry on %s', async path => {
  failure = 'This record is not available.'; window.history.replaceState({}, '', path); render(<App />);
  expect(await screen.findByRole('alert')).toHaveTextContent(failure); failure = '';
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
  if (path.endsWith('new') || path.endsWith('edit')) await screen.findByLabelText('Name');
  else if (path.endsWith('a1')) await screen.findByRole('heading', { name: 'Gateway' }); else await screen.findByRole('table');
});
it.each(['/applications', '/applications/a1', '/applications/a1/edit', '/applications/new'])('shows pending resource loading on %s', async path => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, options) => String(input).includes('/applications')
    ? new Promise<Response>(() => {}) : original(input, options));
  window.history.replaceState({}, '', path); render(<App />);
  expect(await screen.findByText(path === '/applications' ? 'Loading applications…'
    : path.endsWith('new') ? 'Loading portfolios…' : 'Loading application…')).toBeVisible();
});
it('validates required name/portfolio, numeric boundaries, defects and invalid URLs inline', async () => {
  window.history.replaceState({}, '', '/applications/new'); render(<App />); await screen.findByLabelText('Name');
  const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByText('Name is required')).toBeVisible(); expect(screen.getByText('Portfolio is required')).toBeVisible();
  await user.type(screen.getByLabelText('Name'), 'Invalid'); await user.selectOptions(screen.getByLabelText('Portfolio'), 'p1');
  for (const [label, value] of [['Health score', '101'], ['Quality score', '-1'], ['Automation coverage', '1.5'],
    ['Unit-test coverage', '101'], ['Tier', '5'], ['Open defects', '-1'], ['Open critical defects', '2']]) {
    await user.clear(screen.getByLabelText(label)); await user.type(screen.getByLabelText(label), value);
  }
  await user.type(screen.getByLabelText('Repository link'), 'javascript:alert(1)');
  await user.type(screen.getByLabelText('Pipeline link'), 'not-url'); await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getAllByText('Enter a valid URL')).toHaveLength(2);
  expect(screen.getByText('Open critical defects cannot exceed open defects')).toBeVisible();
  expect(screen.getByLabelText('Health score')).toHaveAttribute('aria-invalid', 'true');
  expect(requests.some(row => row.method === 'POST')).toBe(false);
});
it('creates all fields, saves edit and supports cancel without submitting response metadata', async () => {
  window.history.replaceState({}, '', '/applications/new'); render(<App />); await screen.findByLabelText('Name');
  const user = userEvent.setup();
  for (const [label, value] of [['Name', 'Created'], ['Description', 'New description'], ['Product area', 'Area'],
    ['Business owner', 'BO'], ['Technology owner', 'TO'], ['Quality owner', 'QO'], ['Technology stack', 'Stack'],
    ['Repository link', 'https://example.com/r'], ['Pipeline link', 'https://example.com/p']]) {
    await user.type(screen.getByLabelText(label), value);
  }
  await user.selectOptions(screen.getByLabelText('Portfolio'), 'p1');
  for (const [label, value] of [['Criticality', 'High'], ['Lifecycle', 'Retired'], ['Risk', 'Medium']]) {
    await user.selectOptions(screen.getByLabelText(label), value);
  }
  for (const [label, value] of [['Tier', '3'], ['Health score', '100'], ['Quality score', '0'], ['Automation coverage', '70'],
    ['Unit-test coverage', '80'], ['Open defects', '5'], ['Open critical defects', '2']]) {
    await user.clear(screen.getByLabelText(label)); await user.type(screen.getByLabelText(label), value);
  }
  await user.click(screen.getByRole('button', { name: 'Save' })); await screen.findByText('Application saved.');
  const posted = requests.find(row => row.method === 'POST')!.body;
  expect(Object.keys(posted)).toHaveLength(20); expect(posted.healthScore).toBe(100); expect(posted.openDefects).toBe(5);
  await user.click(screen.getByRole('link', { name: 'Edit application' })); await screen.findByLabelText('Name');
  await user.clear(screen.getByLabelText('Description')); await user.type(screen.getByLabelText('Description'), 'Changed');
  await user.click(screen.getByRole('button', { name: 'Save' })); await screen.findByText('Changed');
  expect(requests.find(row => row.method === 'PUT')!.body).not.toHaveProperty('id');
  await user.click(screen.getByRole('link', { name: 'Edit application' })); await screen.findByLabelText('Name');
  await user.click(screen.getByRole('link', { name: 'Cancel' })); await screen.findByRole('heading', { name: 'Created' });
});
it.each([409, 503])('retains refused edit and permits retry for %s', async status => {
  window.history.replaceState({}, '', '/applications/a1/edit'); render(<App />); await screen.findByLabelText('Name');
  const user = userEvent.setup(); writeFailure = status; await user.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText(status === 409 ? 'An application with this name already exists.' : 'Service unavailable.');
  expect(screen.getByLabelText('Description')).toHaveValue('Stored description'); writeFailure = 0;
  await user.click(screen.getByRole('button', { name: 'Save' })); await screen.findByText('Application saved.');
});
it('disables pending edit submission', async () => {
  window.history.replaceState({}, '', '/applications/a1/edit'); render(<App />); await screen.findByLabelText('Name');
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, options) => options?.method === 'PUT'
    ? new Promise<Response>(() => {}) : original(input, options));
  await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
});
it('confirms deletion, preserves failures and deletes to empty list', async () => {
  window.history.replaceState({}, '', '/applications/a1'); render(<App />); await screen.findByRole('heading', { name: 'Gateway' });
  const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'Delete application' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
  expect(requests.some(row => row.method === 'DELETE')).toBe(false); writeFailure = 503;
  await user.click(screen.getByRole('button', { name: 'Delete application' })); await user.click(screen.getByRole('button', { name: 'Confirm' }));
  await screen.findByText('Service unavailable.'); writeFailure = 0;
  await user.click(screen.getByRole('button', { name: 'Delete application' })); await user.click(screen.getByRole('button', { name: 'Confirm' }));
  await screen.findByText('Application deleted.'); await screen.findByText('No records match these filters.');
});
it.each(['Executive', 'Auditor', 'Read Only'] as const)('hides maintenance for %s despite configurable permissions', async role => {
  actor.role = role; window.history.replaceState({}, '', '/applications/a1'); render(<App />); await screen.findByRole('heading', { name: 'Gateway' });
  expect(screen.queryByRole('link', { name: 'Edit application' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Delete application' })).toBeNull();
});
it.each(['Engineer', 'Portfolio Leader'] as const)('allows assigned edit but refuses hidden edit for %s', async role => {
  actor.role = role; window.history.replaceState({}, '', '/applications/a1'); const view = render(<App />);
  await screen.findByRole('link', { name: 'Edit application' }); view.unmount(); actor.portfolioAccess = ['p2'];
  window.history.replaceState({}, '', '/applications/a1/edit'); render(<App />);
  expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission for this action.');
});
it('shows unavailable portfolio choices and disables maintenance', async () => {
  empty = true; window.history.replaceState({}, '', '/applications/new'); render(<App />);
  await screen.findByText('No portfolios are available for application maintenance.'); expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});
it('exports matching filters excluding paging and surfaces denied/pending downloads', async () => {
  window.history.replaceState({}, '', '/applications?risk=High&page=2&page_size=1'); render(<App />); await screen.findByRole('table');
  const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'Download CSV' })); await screen.findByText('Export denied.');
  expect(requests.find(row => row.url.includes('/csv'))!.url).toBe('/api/v1/applications/csv?risk=High');
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, options) => String(input).includes('/csv')
    ? new Promise<Response>(() => {}) : original(input, options));
  await user.click(screen.getByRole('button', { name: 'Download CSV' })); expect(screen.getByRole('button', { name: 'Downloading…' })).toBeDisabled();
});
it('hides read-only export and forced navigation', async () => {
  actor.role = 'Read Only'; const view = render(<App />); await screen.findByRole('table');
  expect(screen.queryByRole('button', { name: 'Download CSV' })).toBeNull(); view.unmount(); actor.mustChangePassword = true;
  render(<App />); await screen.findByRole('heading', { name: 'My Profile' }); expect(screen.queryByRole('link', { name: 'Applications' })).toBeNull();
});
it('redirects unauthenticated application visitors', async () => {
  localStorage.clear(); render(<App />); await screen.findByRole('heading', { name: 'Sign in' });
});
it('downloads successful CSV bytes through the browser download boundary', async () => {
  render(<App />); await screen.findByRole('table');
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, options) => String(input).includes('/csv')
    ? Promise.resolve(new Response('Name,Portfolio\r\nGateway,Payments\r\n', { headers: { 'Content-Type': 'text/csv' } }))
    : original(input, options));
  // jsdom has no object-URL or file-download implementation; provide browser primitives only.
  let downloaded: Blob | undefined;
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: (blob: Blob) => { downloaded = blob; return 'blob:download'; } });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
  const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe('applications.csv'); expect(this.href).toBe('blob:download');
  });
  await userEvent.setup().click(screen.getByRole('button', { name: 'Download CSV' }));
  expect(downloaded).toBeDefined();
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(downloaded!);
  });
  expect(text).toContain('Gateway,Payments');
  expect(clicked).toHaveBeenCalledOnce(); expect(screen.queryByRole('alert')).toBeNull();
});
it('expires the session when a CSV request returns 401', async () => {
  render(<App />); await screen.findByRole('table');
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, options) => String(input).includes('/csv')
    ? Promise.resolve(response({ detail: 'Session expired.' }, 401)) : original(input, options));
  await userEvent.setup().click(screen.getByRole('button', { name: 'Download CSV' }));
  await screen.findByRole('heading', { name: 'Sign in' }); expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
});
