/** Provide the signed-in shell with navigation only to implemented routes. */
import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../features/identity/AuthContext';

/** Render current identity and an accessible account disclosure with server sign-out. */
export function Shell() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  /** Clear protected content after attempting server revocation, surfacing network failure. */
  async function signOut() {
    if (pending) return;
    setPending(true);
    try { await auth.logout(); navigate('/', { replace: true }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Sign-out failed.'); navigate('/', { replace: true }); }
    finally { setPending(false); }
  }
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="site-header">
        <Link className="wordmark"
          to={auth.user?.mustChangePassword ? '/profile' : auth.user?.defaultLanding === 'Dashboard' ? '/dashboard' : '/applications'}>
          Portfolio
        </Link>
        <nav aria-label="Main navigation">
          {!auth.user?.mustChangePassword && auth.user?.permissions.includes('view') && (
            <>
              <NavLink to="/dashboard">Dashboard</NavLink>
              <NavLink to="/portfolios">Portfolios</NavLink>
              <NavLink to="/applications">Applications</NavLink>
              <NavLink to="/reports">Reports</NavLink>
            </>
          )}
        </nav>
        <div className="account">
          <span>{auth.user?.name}</span>
          <span className="chip">{auth.user?.role}</span>
          <details onKeyDown={event => { if (event.key === 'Escape') event.currentTarget.open = false; }}>
            <summary>Account</summary>
            <div className="account-menu">
              <Link to="/profile">My Profile</Link>
              <button className="text-button" disabled={pending} onClick={signOut}>{pending ? 'Signing out…' : 'Sign out'}</button>
            </div>
          </details>
        </div>
      </header>
      <main id="main-content" className="container">
        {error && <p role="alert" className="error">{error}</p>}
        <Outlet />
      </main>
    </>
  );
}
