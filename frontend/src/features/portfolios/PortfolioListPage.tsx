/** Browse the server-owned scoped inventory using shareable filters and pagination. */
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../identity/AuthContext';
import { useResource } from '../../useResource';
import { DataTable } from '../../components/DataTable';
import { Field } from '../../components/Field';
import type { PortfolioPage, PortfolioSummary } from '../../types';

/** Render computed inventory rows and only server-provided scoped filter options. */
export default function PortfolioListPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const resource = useResource<PortfolioPage>(`/portfolios?${params.toString()}`);
  /** Reset paging when the user changes a filter while retaining other URL state. */
  function filter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    next.delete('page'); setParams(next);
  }
  if (user?.mustChangePassword) return <Navigate to="/profile" replace />;
  if (!user?.permissions.includes('view')) return <p role="alert">You do not have permission for this action.</p>;
  const columns = [
    { label: 'Name', render: (row: PortfolioSummary) => <Link to={`/portfolios/${row.id}`}>{row.name}</Link> },
    { label: 'Owner', render: (row: PortfolioSummary) => row.owner },
    { label: 'Product Area', render: (row: PortfolioSummary) => row.productArea },
    { label: 'Applications', numeric: true, render: (row: PortfolioSummary) => row.applicationCount },
    { label: 'Quality Score', numeric: true, render: (row: PortfolioSummary) => row.qualityScore },
    { label: 'Status', render: (row: PortfolioSummary) => <span className="chip" role="status">{row.status}</span> },
  ];
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1>Portfolios</h1>
        {user.role === 'Administrator' && user.permissions.includes('create') && (
          <Link to="/portfolios/new"
            className="inline-flex items-center h-10 px-4 rounded bg-deep-forest-teal text-on-primary text-label-md no-underline hover:bg-primary-button-hover">
            New portfolio
          </Link>
        )}
      </div>
      <p className="muted">Explore ownership, application counts, and quality across your permitted portfolios.</p>
      {location.state?.message && <p role="status" className="feedback">{location.state.message}</p>}
      <div className="bg-surface-tint rounded-lg p-4 flex flex-wrap gap-4 mb-4">
        <Field id="portfolio-search" label="Search by name">
          <input id="portfolio-search" value={params.get('search') ?? ''} maxLength={200}
            onChange={event => filter('search', event.target.value)} />
        </Field>
        <Field id="portfolio-status" label="Status">
          <select id="portfolio-status" value={params.get('status') ?? ''} onChange={event => filter('status', event.target.value)}>
            <option value="">All statuses</option>
            {resource.data?.statuses.map(status => <option key={status}>{status}</option>)}
          </select>
        </Field>
        <Field id="portfolio-area" label="Product area">
          <select id="portfolio-area" value={params.get('productArea') ?? ''} onChange={event => filter('productArea', event.target.value)}>
            <option value="">All product areas</option>
            {resource.data?.productAreas.map(area => <option key={area} value={area}>{area || 'Unspecified'}</option>)}
          </select>
        </Field>
        <button className="secondary" onClick={() => setParams({})}>Clear filters</button>
      </div>
      {resource.loading ? (
        <div role="status" className="card bg-surface-container">Loading portfolios…</div>
      ) : resource.error ? (
        <div className="card">
          <p className="error" role="alert">{resource.error}</p>
          <button className="secondary" onClick={resource.reload}>Retry</button>
        </div>
      ) : resource.data && (
        <DataTable rows={resource.data.items} columns={columns} rowKey={row => row.id}
          page={resource.data.page} pageSize={resource.data.page_size} total={resource.data.total}
          onPage={page => { const next = new URLSearchParams(params); next.set('page', String(page)); setParams(next); }} />
      )}
    </>
  );
}
