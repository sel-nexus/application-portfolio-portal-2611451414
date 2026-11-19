/** Render stored-value executive metrics and scoped, linked breakdowns. */
import { Link, useSearchParams } from 'react-router-dom';
import type { DashboardMetrics, DashboardResponse } from '../../types';
import { useResource } from '../../useResource';

const tiles: { key: keyof DashboardMetrics; label: string; alert?: boolean }[] = [
  { key: 'enterpriseQualityScore', label: 'Enterprise Quality Score' },
  { key: 'applicationHealth', label: 'Application Health' },
  { key: 'automationMaturity', label: 'Automation Maturity' },
  { key: 'openCriticalDefects', label: 'Open Critical Defects', alert: true },
  { key: 'applicationsAtRisk', label: 'Applications at Risk', alert: true },
  { key: 'totalApplications', label: 'Total Applications' },
  { key: 'totalPortfolios', label: 'Total Portfolios' },
];

/** Keep all dashboard filters shareable and apply them to one API response. */
export default function DashboardPage() {
  const [params, setParams] = useSearchParams();
  const query = new URLSearchParams();
  for (const key of ['portfolioId', 'productArea', 'risk']) {
    if (params.has(key)) query.set(key, params.get(key)!);
  }
  const resource = useResource<DashboardResponse>(`/dashboard?${query}`);
  const data = resource.data;
  /** Update one URL filter while retaining the other two current selections. */
  function filter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  }
  return (
    <>
      <h1>Executive Dashboard</h1>
      <p className="muted">Inspect quality, health, automation, defects, and risk across your permitted inventory.</p>
      <section className="dashboard-filters" aria-label="Dashboard filters">
        <div>
          <label htmlFor="dashboard-portfolio">Portfolio</label>
          <select id="dashboard-portfolio" value={params.get('portfolioId') ?? ''}
            onChange={event => filter('portfolioId', event.target.value)}>
            <option value="">All</option>
            {data?.portfolios.map(row => (
              <option key={row.id} value={row.id}>{row.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="dashboard-area">Product Area</label>
          <select id="dashboard-area" value={params.get('productArea') ?? ''}
            onChange={event => filter('productArea', event.target.value)}>
            <option value="">All</option>
            {data?.productAreas.map(area => (
              <option key={area} value={area}>{area || 'Unspecified'}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="dashboard-risk">Risk</label>
          <select id="dashboard-risk" value={params.get('risk') ?? ''}
            onChange={event => filter('risk', event.target.value)}>
            <option value="">All</option>
            {data?.risks.map(risk => (
              <option key={risk} value={risk}>{risk}</option>
            ))}
          </select>
        </div>
        <button className="secondary" onClick={() => setParams({})}>Clear filters</button>
      </section>
      {resource.loading ? (
        <section role="status" aria-label="Loading dashboard" className="dashboard-metrics" aria-busy="true">
          {tiles.map(tile => (
            <div key={tile.key} className="card dashboard-skeleton">
              <span className="muted">{tile.label}</span>
              <div className="skeleton-value" />
            </div>
          ))}
        </section>
      ) : resource.error ? (
        <section className="card">
          <p role="alert" className="error">{resource.error}</p>
          <button className="secondary" onClick={resource.reload}>Retry</button>
        </section>
      ) : data && (
        <>
          {data.metrics.totalApplications === 0 && (
            <p role="status" className="muted">No records match these filters.</p>
          )}
          <section className="dashboard-metrics" aria-label="Dashboard metrics">
            {tiles.map(tile => (
              <article className="card metric-card" key={tile.key} aria-label={tile.label}>
                <h2>{tile.label}</h2>
                <p className={`metric-value ${tile.alert ? (data.metrics[tile.key] > 0 ? 'metric-alert' : 'metric-zero') : ''}`}>
                  {data.metrics[tile.key]}
                </p>
              </article>
            ))}
          </section>
          <div className="dashboard-breakdowns">
            <section className="card" aria-labelledby="portfolio-quality-title">
              <h2 id="portfolio-quality-title">Portfolio Quality</h2>
              {data.portfolioQuality.length === 0 && <p className="muted">No matching portfolios.</p>}
              <ul className="dashboard-list">
                {data.portfolioQuality.map(row => (
                  <li key={row.id}>
                    <div className="quality-label">
                      <Link to={`/portfolios/${row.id}`}>{row.name}</Link>
                      <span>{row.qualityScore}</span>
                    </div>
                    <div className="quality-track" role="progressbar" aria-label={`${row.name} quality`}
                      aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.qualityScore}>
                      <div style={{ width: `${row.qualityScore}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
            <section className="card" aria-labelledby="risk-applications-title">
              <h2 id="risk-applications-title">Applications at Risk</h2>
              {data.applicationsAtRisk.length === 0 && <p className="muted">No matching High-risk applications.</p>}
              <ul className="dashboard-list risk-groups">
                {data.applicationsAtRisk.map(row => (
                  <li key={row.id}>
                    <h3>{row.name}</h3>
                    <ul>
                      {row.applications.map(app => (
                        <li key={app.id}>
                          <Link to={`/applications/${app.id}`}>{app.name}</Link>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </>
      )}
    </>
  );
}
