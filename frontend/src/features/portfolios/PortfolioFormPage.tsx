/** Maintain the five portfolio fields through validated, permission-aware API writes. */
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../api';
import { useResource } from '../../useResource';
import { useAuth } from '../identity/AuthContext';
import { Field } from '../../components/Field';
import type { PortfolioDetail, PortfolioPayload } from '../../types';

const blank: PortfolioPayload = { name: '', owner: '', description: '', productArea: '', status: 'Active' };

/** Load existing detail only for edits, keeping create free from unnecessary reads. */
export default function PortfolioFormPage() {
  const { portfolioId } = useParams();
  return portfolioId ? <EditPortfolio portfolioId={portfolioId} /> : <PortfolioForm />;
}

/** Refuse unavailable edits before exposing any stored form values. */
function EditPortfolio({ portfolioId }: { portfolioId: string }) {
  const resource = useResource<PortfolioDetail>(`/portfolios/${portfolioId}`);
  if (resource.loading) return <div role="status" className="card bg-surface-container">Loading portfolio…</div>;
  if (resource.error) return (
    <div className="card">
      <p className="error" role="alert">{resource.error}</p>
      <button className="secondary" onClick={resource.reload}>Retry</button>
      <Link to="/portfolios">Back to portfolios</Link>
    </div>
  );
  return resource.data ? <PortfolioForm existing={resource.data} /> : null;
}

/** Validate inline and save only public maintenance fields, never computed values. */
function PortfolioForm({ existing }: { existing?: PortfolioDetail }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [fields, setFields] = useState<PortfolioPayload>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (existing) {
      const { name, owner, description, productArea, status } = existing;
      setFields({ name, owner, description, productArea, status });
    }
  }, [existing]);
  /** Validate visible name text and preserve inputs when the server refuses a save. */
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const validation: Record<string, string> = {};
    if (!fields.name.trim()) validation.name = 'Name is required';
    else if (fields.name.trim().length > 200 || /[\x00-\x1f\x7f]/.test(fields.name)) validation.name = 'Enter a valid portfolio name';
    setErrors(validation); setError('');
    if (Object.keys(validation).length) return;
    setPending(true);
    try {
      const saved = await api<PortfolioDetail>(existing ? `/portfolios/${existing.id}` : '/portfolios', {
        method: existing ? 'PUT' : 'POST', body: JSON.stringify(fields),
      });
      navigate(`/portfolios/${saved.id}`, { replace: true, state: { message: 'Portfolio saved.' } });
    } catch (reason) {
      if (reason instanceof ApiError) { setErrors(reason.fields); setError(reason.message); }
      else setError('Unable to save portfolio.');
    } finally { setPending(false); }
  }
  if (user?.mustChangePassword) return <Navigate to="/profile" replace />;
  const allowed = user?.permissions.includes(existing ? 'edit' : 'create') && (user.role === 'Administrator' || (
    existing && user.role === 'Portfolio Leader' && user.portfolioAccess.includes(existing.id)));
  if (!allowed) return <p role="alert">You do not have permission for this action.</p>;
  return (
    <>
      <h1>{existing ? 'Edit portfolio' : 'New portfolio'}</h1>
      <p className="muted">Maintain portfolio ownership, description, classification, and status.</p>
      <form className="card" noValidate onSubmit={save}>
        <div className="form-grid">
          {(['name', 'owner', 'productArea', 'description'] as const).map(key => (
            <Field key={key} id={`portfolio-${key}`} label={{ name: 'Name', owner: 'Owner', productArea: 'Product area', description: 'Description' }[key]}
              required={key === 'name'} error={errors[key]}>
              {key === 'description' ? (
                <textarea id={`portfolio-${key}`} className="h-24 py-2" maxLength={5000} value={fields[key]}
                  aria-invalid={Boolean(errors[key])} aria-describedby={errors[key] ? `portfolio-${key}-error` : undefined}
                  onChange={event => setFields({ ...fields, [key]: event.target.value })} />
              ) : (
                <input id={`portfolio-${key}`} maxLength={200} value={fields[key]} aria-required={key === 'name'}
                  aria-invalid={Boolean(errors[key])} aria-describedby={errors[key] ? `portfolio-${key}-error` : undefined}
                  onChange={event => setFields({ ...fields, [key]: event.target.value })} />
              )}
            </Field>
          ))}
          <Field id="portfolio-status" label="Status" error={errors.status}>
            <select id="portfolio-status" value={fields.status} aria-invalid={Boolean(errors.status)}
              aria-describedby={errors.status ? 'portfolio-status-error' : undefined}
              onChange={event => setFields({ ...fields, status: event.target.value as PortfolioPayload['status'] })}>
              <option>Active</option>
              <option>Archived</option>
            </select>
          </Field>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <Link className="secondary inline-flex items-center h-10 px-4 rounded no-underline"
            to={existing ? `/portfolios/${existing.id}` : '/portfolios'}>
            Cancel
          </Link>
          <button disabled={pending} type="submit">{pending ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </>
  );
}
