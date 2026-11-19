/** Inspect complete persisted application facts and confirm administrator deletion. */
import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useResource } from '../../useResource';
import { useAuth } from '../identity/AuthContext';
import { applicationChip } from './ApplicationListPage';
import type { ApplicationDetail } from '../../types';

/** Show summary, description, owners, four percentage bars and count-only defects. */
export default function ApplicationDetailPage() {
  const { applicationId } = useParams();
  const { user } = useAuth();
  const resource = useResource<ApplicationDetail>(`/applications/${applicationId}`);
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  /** Delete through the API only after explicit confirmation, retaining refused records. */
  async function remove() {
    if (pending) return;
    setPending(true); setError('');
    try {
      await api<void>(`/applications/${applicationId}`, { method: 'DELETE' });
      navigate('/applications', { replace: true, state: { message: 'Application deleted.' } });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to delete application.'); setOpen(false); }
    finally { setPending(false); }
  }
  if (user?.mustChangePassword) return <Navigate to="/profile" replace />;
  if (resource.loading) return <div className="card bg-surface-container" role="status">Loading application…</div>;
  if (resource.error) return (
    <div className="card">
      <p className="error" role="alert">{resource.error}</p>
      <button className="secondary" onClick={resource.reload}>Retry</button>
      <Link to="/applications">Back to applications</Link>
    </div>
  );
  const row = resource.data;
  if (!row) return null;
  const scoped = user?.role === 'Portfolio Leader' || (user?.role === 'Engineer' && user.portfolioAccess.length > 0);
  const canEdit = user?.permissions.includes('edit') && ['Administrator', 'Portfolio Leader', 'Engineer'].includes(user.role)
    && (!scoped || user.portfolioAccess.includes(row.portfolioId));
  const facts = [['Name', row.name], ['Product area', row.productArea], ['Tier', row.tier],
    ['Technology stack', row.technologyStack], ['Description', row.description]];
  const owners = [['Business owner', row.businessOwner], ['Technology owner', row.technologyOwner], ['Quality owner', row.qualityOwner]];
  const scores = [['Health', row.healthScore], ['Quality', row.qualityScore],
    ['Automation coverage', row.automationCoverage], ['Unit-test coverage', row.unitTestCoverage]] as const;
  return (
    <>
      <h1>{row.name}</h1>
      <p className="muted">Stored inventory, ownership, scores, and defect counts.</p>
      {location.state?.message && <p role="status" className="feedback">{location.state.message}</p>}
      <section className="card mb-4">
        <h2>Summary</h2>
        <dl className="facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value || 'Not specified'}</dd>
            </div>
          ))}
          <div>
            <dt>Portfolio</dt>
            <dd><Link to={`/portfolios/${row.portfolioId}`}>{row.portfolio}</Link></dd>
          </div>
          {(['criticality', 'lifecycle', 'risk'] as const).map(key => (
            <div key={key}>
              <dt>{key[0].toUpperCase() + key.slice(1)}</dt>
              <dd>{applicationChip(row[key], key)}</dd>
            </div>
          ))}
          {([['Repository link', row.repositoryLink], ['Pipeline link', row.pipelineLink]]).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value ? <a href={value} target="_blank" rel="noopener noreferrer">{value}</a> : 'Not specified'}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="card mb-4">
        <h2>Ownership</h2>
        <dl className="facts">
          {owners.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value || 'Not specified'}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="card">
        <h2>Scores</h2>
        <dl className="facts">
          {scores.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                {value}%
                <div role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}
                  className="h-2 rounded-full bg-surface-container mt-2">
                  <div className="h-2 rounded-full bg-living-green" style={{ width: `${value}%` }} />
                </div>
              </dd>
            </div>
          ))}
          <div>
            <dt>Open defects</dt>
            <dd>{row.openDefects}</dd>
          </div>
          <div>
            <dt>Open critical defects</dt>
            <dd>{row.openCriticalDefects}</dd>
          </div>
        </dl>
        {error && <p role="alert" className="error">{error}</p>}
        <div className="actions">
          <Link to="/applications">Back to applications</Link>
          {canEdit && <Link to={`/applications/${row.id}/edit`}>Edit application</Link>}
          {user?.role === 'Administrator' && user.permissions.includes('delete') && (
            <button onClick={() => setOpen(true)}>Delete application</button>
          )}
        </div>
      </section>
      <ConfirmDialog open={open} title="Delete application?" message="Delete this application permanently? This cannot be undone."
        pending={pending} onClose={() => setOpen(false)} onConfirm={remove} />
    </>
  );
}
