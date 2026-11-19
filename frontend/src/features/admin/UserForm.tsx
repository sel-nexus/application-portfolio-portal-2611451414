/** Maintain full account facts without retaining passwords after successful saves. */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../../api';
import { Field } from '../../components/Field';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import type { AdminRole, AdminUserPayload, DashboardLink, User } from '../../types';

interface Props {
  existing?: User; roles: AdminRole[]; portfolios: DashboardLink[];
  onSaved: () => void; onCancel: () => void;
}
/** Validate account fields and confirm transitions to Inactive before writing. */
export function UserForm({ existing, roles, portfolios, onSaved, onCancel }: Props) {
  const [fields, setFields] = useState<AdminUserPayload>(() => existing ? {
    name: existing.name, email: existing.email, role: existing.role, portfolioAccess: existing.portfolioAccess,
    status: existing.status, managerName: existing.managerName, vendor: existing.vendor,
  } : { name: '', email: '', role: roles[0].name, portfolioAccess: [], status: 'Active', managerName: '', vendor: false });
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  /** Persist only maintained fields, preserving input and field errors on refusal. */
  async function persist() {
    if (pending) return;
    setPending(true); setError('');
    try {
      await api<User>(existing ? `/admin/users/${existing.id}` : '/admin/users', {
        method: existing ? 'PUT' : 'POST',
        body: JSON.stringify(existing ? fields : { ...fields, initialPassword: password }),
      });
      setPassword(''); onSaved();
    } catch (reason) {
      setConfirm(false);
      if (reason instanceof ApiError) { setErrors(reason.fields); setError(reason.message); }
      else setError('Unable to save user.');
    } finally { setPending(false); }
  }
  /** Apply native labeled validation before opening a deactivation confirmation. */
  function save(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const validation: Record<string, string> = {};
    if (!fields.name.trim()) validation.name = 'Name is required';
    if (!fields.email.trim()) validation.email = 'Email is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email.trim())) validation.email = 'Enter a valid email';
    if (!existing && !password) validation.initialPassword = 'Initial password is required';
    else if (!existing && new TextEncoder().encode(password).length > 72) validation.initialPassword = 'Password must be at most 72 UTF-8 bytes';
    setErrors(validation); setError('');
    if (Object.keys(validation).length) return;
    if (fields.status === 'Inactive' && existing?.status !== 'Inactive') setConfirm(true);
    else void persist();
  }
  /** Associate server field errors with their controls. */
  function attrs(key: string) {
    return { 'aria-invalid': Boolean(errors[key]), 'aria-describedby': errors[key] ? `user-${key}-error` : undefined };
  }
  return (
    <form className="card" noValidate onSubmit={save}>
      <h2>{existing ? 'Edit user' : 'New user'}</h2>
      <div className="form-grid">
        {(['name', 'email', 'managerName'] as const).map(key => (
          <Field key={key} id={`user-${key}`} label={{ name: 'Name', email: 'Email', managerName: 'Manager name' }[key]}
            required={key !== 'managerName'} error={errors[key]}>
            <input id={`user-${key}`} type={key === 'email' ? 'email' : 'text'} maxLength={key === 'email' ? 254 : 200}
              value={fields[key]} aria-required={key !== 'managerName'} {...attrs(key)}
              onChange={event => setFields({ ...fields, [key]: event.target.value })} />
          </Field>
        ))}
        <Field id="user-role" label="Role" required error={errors.role}>
          <select id="user-role" value={fields.role} aria-required {...attrs('role')}
            onChange={event => setFields({ ...fields, role: event.target.value as AdminUserPayload['role'] })}>
            {roles.map(role => <option key={role.id}>{role.name}</option>)}
          </select>
        </Field>
        <Field id="user-status" label="Status" required error={errors.status}>
          <select id="user-status" value={fields.status} aria-required {...attrs('status')}
            onChange={event => setFields({ ...fields, status: event.target.value as AdminUserPayload['status'] })}>
            <option>Active</option>
            <option>Inactive</option>
          </select>
        </Field>
        <fieldset className="admin-choices" aria-describedby={errors.portfolioAccess ? 'user-portfolioAccess-error' : undefined}>
          <legend>Portfolio access</legend>
          <p className="muted">An unassigned Portfolio Leader has no access; an unassigned Engineer is unrestricted.</p>
          {portfolios.map(portfolio => (
            <label key={portfolio.id}>
              <input type="checkbox" checked={fields.portfolioAccess.includes(portfolio.id)}
                onChange={event => setFields({ ...fields, portfolioAccess: event.target.checked
                  ? [...fields.portfolioAccess, portfolio.id] : fields.portfolioAccess.filter(id => id !== portfolio.id) })} />
              {portfolio.name}
            </label>
          ))}
          {errors.portfolioAccess && <p id="user-portfolioAccess-error" role="alert" className="error">{errors.portfolioAccess}</p>}
        </fieldset>
        <Field id="user-vendor" label="Vendor indicator" error={errors.vendor}>
          <input id="user-vendor" type="checkbox" checked={fields.vendor} {...attrs('vendor')}
            onChange={event => setFields({ ...fields, vendor: event.target.checked })} />
        </Field>
        {!existing && (
          <Field id="user-initialPassword" label="Initial password" required error={errors.initialPassword}>
            <input id="user-initialPassword" type="password" autoComplete="new-password" value={password} aria-required
              {...attrs('initialPassword')} onChange={event => setPassword(event.target.value)} />
          </Field>
        )}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <button type="button" className="secondary" disabled={pending} onClick={onCancel}>Cancel</button>
        <button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save'}</button>
      </div>
      <ConfirmDialog open={confirm} title="Deactivate user?" pending={pending}
        message="This account will become inactive and all existing sessions will be revoked. Audit history is retained."
        onClose={() => { if (!pending) setConfirm(false); }} onConfirm={() => void persist()} />
    </form>
  );
}
