/** Maintain every application field with inline validation and scope-safe portfolio choices. */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../api';
import { Field } from '../../components/Field';
import { useResource } from '../../useResource';
import { useAuth } from '../identity/AuthContext';
import type { ApplicationDetail, ApplicationPage, ApplicationPayload } from '../../types';

const blank: ApplicationPayload = { name: '', portfolioId: '', description: '', productArea: '', businessOwner: '',
  technologyOwner: '', qualityOwner: '', criticality: 'Low', tier: 1, lifecycle: 'Active', technologyStack: '',
  repositoryLink: '', pipelineLink: '', healthScore: 0, qualityScore: 0, automationCoverage: 0, unitTestCoverage: 0,
  openDefects: 0, openCriticalDefects: 0, risk: 'Low' };
const labels: Record<keyof ApplicationPayload, string> = { name: 'Name', portfolioId: 'Portfolio', description: 'Description',
  productArea: 'Product area', businessOwner: 'Business owner', technologyOwner: 'Technology owner', qualityOwner: 'Quality owner',
  criticality: 'Criticality', tier: 'Tier', lifecycle: 'Lifecycle', technologyStack: 'Technology stack', repositoryLink: 'Repository link',
  pipelineLink: 'Pipeline link', healthScore: 'Health score', qualityScore: 'Quality score', automationCoverage: 'Automation coverage',
  unitTestCoverage: 'Unit-test coverage', openDefects: 'Open defects', openCriticalDefects: 'Open critical defects', risk: 'Risk' };
const choices: Partial<Record<keyof ApplicationPayload, string[]>> = {
  criticality: ['Low', 'Medium', 'High', 'Critical'], lifecycle: ['Active', 'Deprecated', 'Retired'], risk: ['Low', 'Medium', 'High'],
};
const numbers = ['tier', 'healthScore', 'qualityScore', 'automationCoverage', 'unitTestCoverage', 'openDefects', 'openCriticalDefects'];

/** Resolve the edit record before exposing form values; creation requires no detail read. */
export default function ApplicationFormPage() {
  const { applicationId } = useParams();
  return applicationId ? <EditApplication applicationId={applicationId} /> : <ApplicationForm />;
}

/** Refuse missing or hidden edits with the exact server message and a retry action. */
function EditApplication({ applicationId }: { applicationId: string }) {
  const resource = useResource<ApplicationDetail>(`/applications/${applicationId}`);
  if (resource.loading) return <div className="card bg-surface-container" role="status">Loading application…</div>;
  if (resource.error) return (
    <div className="card">
      <p role="alert" className="error">{resource.error}</p>
      <button className="secondary" onClick={resource.reload}>Retry</button>
      <Link to="/applications">Back to applications</Link>
    </div>
  );
  return resource.data ? <ApplicationForm existing={resource.data} /> : null;
}

/** Preserve invalid or refused input and submit only maintained fields, not response metadata. */
function ApplicationForm({ existing }: { existing?: ApplicationDetail }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const resource = useResource<ApplicationPage>('/applications?page_size=1');
  const initial = Object.fromEntries(Object.keys(blank).map(key => [key, existing?.[key as keyof ApplicationPayload] ?? blank[key as keyof ApplicationPayload]]));
  const [fields, setFields] = useState<Record<string, string | number>>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  /** Validate strict integers, cross-field counts, safe links, required references and text. */
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const validation: Record<string, string> = {};
    if (!String(fields.name).trim()) validation.name = 'Name is required';
    else if (String(fields.name).trim().length > 200 || /[\x00-\x1f\x7f]/.test(String(fields.name))) validation.name = 'Enter a valid application name';
    if (!fields.portfolioId) validation.portfolioId = 'Portfolio is required';
    else if (!resource.data?.portfolios.some(row => row.id === fields.portfolioId)) validation.portfolioId = 'Select an available portfolio';
    for (const key of numbers) {
      const value = Number(fields[key]);
      const min = key === 'tier' ? 1 : 0;
      const max = key === 'tier' ? 4 : key.includes('Defects') ? Infinity : 100;
      if (fields[key] === '' || !Number.isSafeInteger(value) || value < min || value > max) {
        validation[key] = key.includes('Defects') ? 'Enter an integer of 0 or more' : `Enter an integer from ${min} to ${max}`;
      }
    }
    if (Number(fields.openCriticalDefects) > Number(fields.openDefects)) validation.openCriticalDefects = 'Open critical defects cannot exceed open defects';
    for (const key of ['repositoryLink', 'pipelineLink']) {
      if (String(fields[key]).trim()) {
        try {
          const url = new URL(String(fields[key]));
          if (!['http:', 'https:'].includes(url.protocol)) validation[key] = 'Enter a valid URL';
        } catch { validation[key] = 'Enter a valid URL'; }
      }
    }
    setErrors(validation); setError('');
    if (Object.keys(validation).length) return;
    setPending(true);
    const payload = { ...fields };
    numbers.forEach(key => { payload[key] = Number(fields[key]); });
    try {
      const saved = await api<ApplicationDetail>(existing ? `/applications/${existing.id}` : '/applications', {
        method: existing ? 'PUT' : 'POST', body: JSON.stringify(payload),
      });
      navigate(`/applications/${saved.id}`, { replace: true, state: { message: 'Application saved.' } });
    } catch (reason) {
      if (reason instanceof ApiError) { setErrors(reason.fields); setError(reason.message); }
      else setError('Unable to save application.');
    } finally { setPending(false); }
  }
  if (user?.mustChangePassword) return <Navigate to="/profile" replace />;
  const scoped = user?.role === 'Portfolio Leader' || (user?.role === 'Engineer' && user.portfolioAccess.length > 0);
  const allowed = user?.permissions.includes(existing ? 'edit' : 'create')
    && ['Administrator', 'Portfolio Leader', 'Engineer'].includes(user.role)
    && (!existing || !scoped || user.portfolioAccess.includes(existing.portfolioId));
  if (!allowed) return <p role="alert">You do not have permission for this action.</p>;
  if (resource.loading) return <div className="card bg-surface-container" role="status">Loading portfolios…</div>;
  if (resource.error) return (
    <div className="card">
      <p className="error" role="alert">{resource.error}</p>
      <button className="secondary" onClick={resource.reload}>Retry</button>
    </div>
  );
  return (
    <>
      <h1>{existing ? 'Edit application' : 'New application'}</h1>
      <p className="muted">Maintain inventory, ownership, scores, and defects in the system of record.</p>
      {!resource.data?.portfolios.length && <p role="status">No portfolios are available for application maintenance.</p>}
      <form className="card" noValidate onSubmit={save}>
        <div className="form-grid">
          {(Object.keys(blank) as (keyof ApplicationPayload)[]).map(key => {
            const props = { id: `application-${key}`, value: fields[key], 'aria-invalid': Boolean(errors[key]),
              'aria-describedby': errors[key] ? `application-${key}-error` : undefined,
              'aria-required': key === 'name' || key === 'portfolioId',
              onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
                setFields(value => ({ ...value, [key]: event.target.value })) };
            return (
              <Field key={key} id={props.id} label={labels[key]} required={key === 'name' || key === 'portfolioId'} error={errors[key]}>
                {key === 'portfolioId' ? (
                  <select {...props}>
                    <option value="">Select a portfolio</option>
                    {resource.data?.portfolios.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
                  </select>
                ) : choices[key] ? (
                  <select {...props}>
                    {choices[key]?.map(value => <option key={value}>{value}</option>)}
                  </select>
                ) : key === 'description' || key === 'technologyStack' ? (
                  <textarea {...props} className="h-24 py-2" maxLength={key === 'description' ? 5000 : 2000} />
                ) : (
                  <input {...props} type={numbers.includes(key) ? 'number' : 'text'} step={numbers.includes(key) ? 1 : undefined}
                    maxLength={key.includes('Link') ? 2000 : 200} />
                )}
              </Field>
            );
          })}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <Link className="secondary inline-flex items-center h-10 px-4 rounded no-underline"
            to={existing ? `/applications/${existing.id}` : '/applications'}>Cancel</Link>
          <button disabled={pending || !resource.data?.portfolios.length}>{pending ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </>
  );
}
