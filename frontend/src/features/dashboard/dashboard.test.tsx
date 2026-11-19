/** Verify API-backed dashboard states, URL filters, metrics, and detail navigation. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import DashboardPage from './DashboardPage';
import type { DashboardResponse } from '../../types';

const populated: DashboardResponse = {
  metrics: { enterpriseQualityScore: 76, applicationHealth: 76, automationMaturity: 62,
    openCriticalDefects: 11, applicationsAtRisk: 3, totalApplications: 10, totalPortfolios: 3 },
  portfolios: [{ id: 'payments', name: 'Payments' }, { id: 'empty', name: 'Empty' }],
  productAreas: ['Commerce', 'Customer'], risks: ['High', 'Low', 'Medium'],
  portfolioQuality: [{ id: 'payments', name: 'Payments', qualityScore: 72 }],
  applicationsAtRisk: [{ id: 'payments', name: 'Payments', applications: [{ id: 'gateway', name: 'Payment Gateway' }] }],
};
const empty: DashboardResponse = { ...populated,
  metrics: { enterpriseQualityScore: 0, applicationHealth: 0, automationMaturity: 0,
    openCriticalDefects: 0, applicationsAtRisk: 0, totalApplications: 0, totalPortfolios: 0 },
  portfolioQuality: [], applicationsAtRisk: [],
};

/** Expose the observable route for filter and link assertions. */
function Location() {
  const location = useLocation();
  return <output aria-label="Current route">{location.pathname}{location.search}</output>;
}

/** Render with real routing; replace only the HTTP boundary in component tests. */
function mount(path = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Location />
      <Routes>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/portfolios/:id" element={<h1>Portfolio detail</h1>} />
        <Route path="/applications/:id" element={<h1>Application detail</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(populated), { status: 200 }));
});
afterEach(() => vi.restoreAllMocks());

it('renders all seven values, integer bars and read-only linked breakdowns', async () => {
  mount();
  await screen.findByRole('region', { name: 'Dashboard metrics' });
  const values = [['Enterprise Quality Score', 76], ['Application Health', 76], ['Automation Maturity', 62],
    ['Open Critical Defects', 11], ['Applications at Risk', 3], ['Total Applications', 10], ['Total Portfolios', 3]] as const;
  for (const [label, value] of values) {
    expect(within(screen.getByRole('article', { name: label })).getByText(String(value))).toBeVisible();
  }
  expect(screen.getByRole('progressbar', { name: 'Payments quality' })).toHaveAttribute('aria-valuenow', '72');
  expect(screen.getByRole('progressbar').firstElementChild).toHaveStyle({ width: '72%' });
  expect(screen.getByRole('link', { name: 'Payments' })).toHaveAttribute('href', '/portfolios/payments');
  expect(screen.getByRole('link', { name: 'Payment Gateway' })).toHaveAttribute('href', '/applications/gateway');
  expect(screen.queryByRole('button', { name: /save|export|delete|create/i })).not.toBeInTheDocument();
  expect(within(screen.getByRole('article', { name: 'Open Critical Defects' })).getByText('11')).toHaveClass('metric-alert');
});

it.each([['Payments', 'Portfolio detail', '/portfolios/payments'],
  ['Payment Gateway', 'Application detail', '/applications/gateway']])('opens %s through its real link', async (name, heading, path) => {
  mount();
  await userEvent.setup().click(await screen.findByRole('link', { name }));
  expect(screen.getByRole('heading', { name: heading })).toBeVisible();
  expect(screen.getByLabelText('Current route')).toHaveTextContent(path);
});

it('shows shaped loading cards without stale numbers while the request is pending', async () => {
  let resolve!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
  mount();
  expect(screen.getByRole('status', { name: 'Loading dashboard' })).toHaveAttribute('aria-busy', 'true');
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
  resolve(new Response(JSON.stringify(populated), { status: 200 }));
  expect(await screen.findByRole('article', { name: 'Total Applications' })).toBeVisible();
  expect(screen.queryByRole('status', { name: 'Loading dashboard' })).not.toBeInTheDocument();
});

it('renders zeros and both empty breakdown messages without hidden links', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(empty), { status: 200 }));
  mount();
  expect(await screen.findByText('No records match these filters.')).toBeVisible();
  expect(screen.getAllByRole('article')).toHaveLength(7);
  for (const article of screen.getAllByRole('article')) expect(within(article).getByText('0')).toBeVisible();
  expect(screen.getByText('No matching portfolios.')).toBeVisible();
  expect(screen.getByText('No matching High-risk applications.')).toBeVisible();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(within(screen.getByRole('article', { name: 'Applications at Risk' })).getByText('0')).toHaveClass('metric-zero');
});

it.each(['network', 'server'])('shows %s failure and recovers with Retry', async kind => {
  if (kind === 'network') vi.mocked(fetch).mockRejectedValueOnce(new TypeError('offline'));
  else vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'The service is unavailable.' }), { status: 503 }));
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent(kind === 'network' ? 'Unable to connect.' : 'The service is unavailable.');
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('article', { name: 'Total Applications' })).toBeVisible();
});

it('persists all three filters in URL and renders every filtered result, then clears them', async () => {
  vi.mocked(fetch).mockImplementation(async input => {
    const params = new URL(String(input), 'http://test').searchParams;
    const filtered = params.get('portfolioId') === 'payments' && params.get('productArea') === 'Commerce' && params.get('risk') === 'High';
    return new Response(JSON.stringify(filtered ? { ...populated, metrics: { ...populated.metrics,
      enterpriseQualityScore: 72, applicationHealth: 67, automationMaturity: 60,
      openCriticalDefects: 7, applicationsAtRisk: 2, totalApplications: 2, totalPortfolios: 1 } } : populated), { status: 200 });
  });
  mount();
  await screen.findByRole('article', { name: 'Total Applications' });
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('Portfolio'), 'payments');
  await screen.findByRole('article', { name: 'Total Applications' });
  await user.selectOptions(screen.getByLabelText('Product Area'), 'Commerce');
  await screen.findByRole('article', { name: 'Total Applications' });
  await user.selectOptions(screen.getByLabelText('Risk'), 'High');
  await waitFor(() => expect(within(screen.getByRole('article', { name: 'Total Applications' })).getByText('2')).toBeVisible());
  expect(screen.getByLabelText('Current route')).toHaveTextContent('/dashboard?portfolioId=payments&productArea=Commerce&risk=High');
  expect(screen.getByLabelText('Portfolio')).toHaveValue('payments');
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '72');
  await user.click(screen.getByRole('button', { name: 'Clear filters' }));
  await waitFor(() => expect(within(screen.getByRole('article', { name: 'Total Applications' })).getByText('10')).toBeVisible());
  expect(screen.getByLabelText('Current route')).toHaveTextContent('/dashboard');
  expect(screen.getByLabelText('Risk')).toHaveValue('');
});

it('hydrates bookmarked filters and never invents inaccessible option labels', async () => {
  mount('/dashboard?portfolioId=payments&productArea=Commerce&risk=High');
  await screen.findByRole('article', { name: 'Total Applications' });
  expect(screen.getByLabelText('Portfolio')).toHaveValue('payments');
  expect(screen.getByLabelText('Product Area')).toHaveValue('Commerce');
  expect(screen.getByLabelText('Risk')).toHaveValue('High');
  expect(screen.queryByRole('option', { name: 'Data & Analytics' })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'Secret' })).not.toBeInTheDocument();
});
