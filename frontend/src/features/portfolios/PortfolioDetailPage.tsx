/** Inspect full portfolio facts and guard administrator deletion with confirmation. */
import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import { useResource } from '../../useResource';
import { useAuth } from '../identity/AuthContext';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import type { PortfolioDetail } from '../../types';

/** Render authorized detail and associated names without linking unfinished application routes. */
export default function PortfolioDetailPage() {
  const { portfolioId } = useParams();
  const { user } = useAuth();
  const resource = useResource<PortfolioDetail>(`/portfolios/${portfolioId}`);
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  /** Delete through the API, preserving detail and explanatory errors on refusal. */
  async function remove() {
    if (pending) return;
    setPending(true); setError('');
    try {
      await api<void>(`/portfolios/${portfolioId}`, { method: 'DELETE' });
      navigate('/portfolios', { replace: true, state: { message: 'Portfolio deleted.' } });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to delete portfolio.');
      setOpen(false);
    } finally { setPending(false); }
  }
  if (user?.mustChangePassword) return <Navigate to="/profile" replace />;
  if (resource.loading) return <div className="card bg-surface-container" role="status">Loading portfolio…</div>;
  if (resource.error) return (
    <div className="card">
      <p className="error" role="alert">{resource.error}</p>
      <button className="secondary" onClick={resource.reload}>Retry</button>
      <Link to="/portfolios">Back to portfolios</Link>
    </div>
  );
  const row = resource.data;
  if (!row) return null;
  const canEdit = user?.permissions.includes('edit') && (user.role === 'Administrator' || (
    user.role === 'Portfolio Leader' && user.portfolioAccess.includes(row.id)));
  const canDelete = user?.role === 'Administrator' && user.permissions.includes('delete');
  return (
    <>
      <h1>{row.name}</h1>
      <p className="muted">Portfolio ownership and quality calculated from stored application records.</p>
      {location.state?.message && <p className="feedback" role="status">{location.state.message}</p>}
      <div className="card">
        <dl className="facts">
          <div>
            <dt>Name</dt>
            <dd>{row.name}</dd>
          </div>
          <div>
            <dt>Owner</dt>
            <dd>{row.owner || 'Not specified'}</dd>
          </div>
          <div>
            <dt>Description</dt>
            <dd>{row.description || 'Not specified'}</dd>
          </div>
          <div>
            <dt>Product area</dt>
            <dd>{row.productArea || 'Not specified'}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd><span className="chip" role="status">{row.status}</span></dd>
          </div>
          <div>
            <dt>Applications</dt>
            <dd>{row.applicationCount}</dd>
          </div>
          <div>
            <dt>Quality Score</dt>
            <dd>{row.qualityScore}</dd>
          </div>
        </dl>
        <h2>Applications</h2>
        {row.applications.length ? (
          <ul className="divide-y divide-outline-variant">
            {row.applications.map(application => <li className="py-4" key={application.id}>{application.name}</li>)}
          </ul>
        ) : <p className="muted">No applications in this portfolio.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <Link className="secondary inline-flex items-center h-10 px-4 rounded no-underline" to="/portfolios">
            Back to portfolios
          </Link>
          {canEdit && <Link to={`/portfolios/${row.id}/edit`}>Edit portfolio</Link>}
          {canDelete && <button onClick={() => setOpen(true)}>Delete portfolio</button>}
        </div>
      </div>
      <ConfirmDialog open={open} title="Delete portfolio?" message="Delete this portfolio permanently? Applications must be moved or deleted first."
        pending={pending} onClose={() => setOpen(false)} onConfirm={remove} />
    </>
  );
}
