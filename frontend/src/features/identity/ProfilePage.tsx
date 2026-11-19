/** Show current account facts and persist password and landing changes. */
import { useEffect, useState } from 'react';
import { ApiError, api } from '../../api';
import { Field } from '../../components/Field';
import type { Landing, PasswordPayload, Session, User } from '../../types';
import { useAuth } from './AuthContext';

/** Offer bounded self-service changes without editing email, role, or portfolio scope. */
export default function ProfilePage() {
  const auth = useAuth();
  const user = auth.user!;
  const [landing, setLanding] = useState<Landing>(user.defaultLanding);
  const [passwords, setPasswords] = useState<PasswordPayload>({ currentPassword: '', newPassword: '', confirmation: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [pending, setPending] = useState('');
  useEffect(() => setLanding(user.defaultLanding), [user.defaultLanding]);
  /** Persist a landing preference without navigating to an unimplemented feature. */
  async function saveLanding(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending('landing'); setError(''); setSuccess('');
    try {
      auth.setUser(await api<User>('/profile', { method: 'PUT', body: JSON.stringify({ defaultLanding: landing }) }));
      setSuccess('Default landing page saved.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save.'); }
    finally { setPending(''); }
  }
  /** Validate password proof and confirmation, then replace the revoked bearer session. */
  async function savePassword(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    const fields: Record<string, string> = {};
    for (const key of Object.keys(passwords) as (keyof PasswordPayload)[]) {
      if (!passwords[key]) fields[key] = 'This field is required';
      else if (new TextEncoder().encode(passwords[key]).length > 72) fields[key] = 'Password must be at most 72 UTF-8 bytes';
    }
    if (passwords.newPassword !== passwords.confirmation) fields.confirmation = 'Passwords do not match.';
    setErrors(fields); setError(''); setSuccess('');
    if (Object.keys(fields).length) return;
    setPending('password');
    try {
      auth.replaceSession(await api<Session>('/profile/password', { method: 'POST', body: JSON.stringify(passwords) }));
      setPasswords({ currentPassword: '', newPassword: '', confirmation: '' });
      setSuccess('Password changed. Other sessions have been signed out.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to change password.');
      if (reason instanceof ApiError) setErrors(reason.fields);
    } finally { setPending(''); }
  }
  const facts = [
    ['Name', user.name], ['Email', user.email], ['Role', user.role],
    ['Portfolio access', user.portfolioNames.length ? user.portfolioNames.join(', ') : user.role === 'Portfolio Leader' ? 'No portfolios assigned' : 'All portfolios'],
    ['Manager name', user.managerName || 'Not assigned'], ['Vendor', user.vendor ? 'Yes' : 'No'],
  ];
  return (
    <>
      <h1>My Profile</h1>
      <p className="muted">Review your account and manage your sign-in preferences.</p>
      <section className="card profile-card">
        {user.mustChangePassword && <p role="alert">Change your initial password before continuing.</p>}
        <dl className="facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <h2>Change password</h2>
        <form noValidate onSubmit={savePassword}>
          <div className="form-grid">
            {(['currentPassword', 'newPassword', 'confirmation'] as const).map((key, index) => (
              <Field key={key} id={key} label={['Current password', 'New password', 'Confirm new password'][index]}
                required error={errors[key]}>
                <input id={key} type="password" autoComplete={key === 'currentPassword' ? 'current-password' : 'new-password'}
                  value={passwords[key]} aria-required="true" aria-invalid={Boolean(errors[key])}
                  aria-describedby={errors[key] ? `${key}-error` : undefined}
                  onChange={event => setPasswords(value => ({ ...value, [key]: event.target.value }))} />
              </Field>
            ))}
          </div>
          <button disabled={Boolean(pending)}>{pending === 'password' ? 'Saving password…' : 'Save password'}</button>
        </form>
        <h2>Landing preference</h2>
        <form onSubmit={saveLanding}>
          <Field id="landing" label="Default landing page">
            <select id="landing" value={landing} onChange={event => setLanding(event.target.value as Landing)}>
              <option>Dashboard</option>
              <option>Applications</option>
            </select>
          </Field>
          <button disabled={Boolean(pending)}>{pending === 'landing' ? 'Saving preference…' : 'Save preference'}</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        {success && <p className="feedback" role="status">{success}</p>}
      </section>
    </>
  );
}
