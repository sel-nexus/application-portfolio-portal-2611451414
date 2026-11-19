/** Render internal sign-in with accessible errors and designated demo credentials. */
import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { ApiError } from '../../api';
import { Field } from '../../components/Field';
import { useAuth } from './AuthContext';

/** Authenticate local accounts; root is intentionally login, without self-signup. */
export default function LoginPage() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  if (auth.user) return <Navigate to="/profile" replace />;
  /** Validate required inputs before contacting the account service. */
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    const fields: Record<string, string> = {};
    if (!email.trim()) fields.email = 'Email is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) fields.email = 'Enter a valid email';
    if (!password) fields.password = 'Password is required';
    else if (new TextEncoder().encode(password).length > 72) fields.password = 'Password must be at most 72 UTF-8 bytes';
    setErrors(fields); setError('');
    if (Object.keys(fields).length) return;
    setPending(true);
    try { await auth.login(email, password); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sign-in failed.');
      if (reason instanceof ApiError) setErrors(reason.fields);
    } finally { setPending(false); }
  }
  return (
    <main className="login-canvas">
      <div className="login-stack">
        <section className="card login-card">
          <h1>Sign in</h1>
          <p className="muted">Use your portal email and password.</p>
          <form noValidate onSubmit={submit}>
            <Field id="email" label="Email" error={errors.email} required>
              <input id="email" type="email" autoComplete="username" value={email}
                aria-required="true" aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? 'email-error' : undefined}
                onChange={event => setEmail(event.target.value)} />
            </Field>
            <Field id="password" label="Password" error={errors.password} required>
              <div className="password-control">
                <input id="password" type={visible ? 'text' : 'password'} autoComplete="current-password" value={password}
                  aria-required="true" aria-invalid={Boolean(errors.password)}
                  aria-describedby={errors.password ? 'password-error' : undefined} onChange={event => setPassword(event.target.value)} />
                <button type="button" className="text-button" aria-pressed={visible} onClick={() => setVisible(value => !value)}>
                  {visible ? 'Hide password' : 'Show password'}
                </button>
              </div>
            </Field>
            <button className="full-width" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
            {error && <p className="error" role="alert">{error}</p>}
          </form>
        </section>
        <section className="card demo-card" aria-labelledby="demo-title">
          <h2 id="demo-title">Demo access</h2>
          <p>Starting password for all accounts: <strong>PortalDemo123!</strong></p>
          <ul>
            {['admin', 'executive', 'leader', 'engineer', 'auditor', 'readonly'].map(name => (
              <li key={name}>{name}@portfolio.local / PortalDemo123!</li>
            ))}
          </ul>
          <p className="muted">Administrator must change the starting password. Startup does not reset changed credentials.</p>
        </section>
      </div>
    </main>
  );
}
