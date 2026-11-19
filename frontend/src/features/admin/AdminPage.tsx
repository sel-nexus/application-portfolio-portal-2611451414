/** Gate sensitive administration and preserve navigable tab/page state in the URL. */
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../identity/AuthContext';
import { UsersPanel } from './UsersPanel';
import { RolesPanel } from './RolesPanel';

/** Compose user and role panels without exposing an unfinished audit tab. */
export default function AdminPage() {
  const auth = useAuth();
  const [params] = useSearchParams();
  const tab = params.get('tab') === 'roles' ? 'roles' : 'users';
  if (auth.loading) return <div role="status">Checking administration access…</div>;
  if (auth.user?.mustChangePassword) return <Navigate to="/profile" replace />;
  if (auth.user?.role !== 'Administrator' || !auth.user.permissions.includes('administer')) {
    return <p role="alert">You do not have access to administration.</p>;
  }
  return (
    <>
      <h1>Administration</h1>
      <p className="muted">Maintain account access and fixed-role configuration.</p>
      <nav className="admin-tabs" aria-label="Administration tabs">
        <Link to="/admin?tab=users" aria-current={tab === 'users' ? 'page' : undefined}>Users</Link>
        <Link to="/admin?tab=roles" aria-current={tab === 'roles' ? 'page' : undefined}>Roles</Link>
      </nav>
      <section aria-label={tab === 'users' ? 'Users' : 'Roles'}>
        {tab === 'users' ? <UsersPanel /> : <RolesPanel />}
      </section>
    </>
  );
}
