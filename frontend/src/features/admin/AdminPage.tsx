/** Gate sensitive administration and preserve navigable tab/page state in the URL. */
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../identity/AuthContext';
import { UsersPanel } from './UsersPanel';
import { RolesPanel } from './RolesPanel';
import AuditPage from '../audit/AuditPage';

/** Compose user, role, and persisted audit panels behind administration access. */
export default function AdminPage() {
  const auth = useAuth();
  const [params] = useSearchParams();
  const tab = params.get('tab') === 'audit' ? 'audit' : params.get('tab') === 'roles' ? 'roles' : 'users';
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
        <Link to="/admin?tab=audit" aria-current={tab === 'audit' ? 'page' : undefined}>Audit log</Link>
      </nav>
      <section aria-label={tab === 'audit' ? 'Audit log' : tab === 'users' ? 'Users' : 'Roles'}>
        {tab === 'audit' ? <AuditPage embedded /> : tab === 'users' ? <UsersPanel /> : <RolesPanel />}
      </section>
    </>
  );
}
