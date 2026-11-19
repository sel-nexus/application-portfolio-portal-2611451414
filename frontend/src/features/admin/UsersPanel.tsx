/** Render paged persisted users and bounded account maintenance forms. */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useResource } from '../../useResource';
import { api, ApiError } from '../../api';
import { DataTable } from '../../components/DataTable';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { UserForm } from './UserForm';
import type { AdminRole, DashboardLink, PortfolioPage, PageResult, User } from '../../types';

/** Gather portfolio choices through bounded inventory requests, not a browser datastore. */
async function portfolioChoices(): Promise<DashboardLink[]> {
  const items: DashboardLink[] = [];
  let page = 1;
  let total = 0;
  do {
    const result = await api<PortfolioPage>(`/portfolios?page=${page}&page_size=100`);
    items.push(...result.items.map(({ id, name }) => ({ id, name })));
    total = result.total; page += 1;
  } while (items.length < total);
  return items;
}
/** Show list, loading, empty, retry, create/edit and explicit deactivation confirmation. */
export function UsersPanel() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const size = Math.min(100, Math.max(1, Number(params.get('page_size')) || 10));
  const users = useResource<PageResult<User>>(`/admin/users?page=${page}&page_size=${size}`);
  const [form, setForm] = useState<{ existing?: User; roles: AdminRole[]; portfolios: DashboardLink[] } | null>(null);
  const [target, setTarget] = useState<User | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  /** Load current persisted form choices and surface inaccessible inventory gracefully. */
  async function open(existing?: User) {
    if (pending) return;
    setPending(true); setError(''); setMessage('');
    try {
      const roles = await api<AdminRole[]>('/admin/roles');
      const portfolios = await portfolioChoices();
      if (!roles.length) throw new Error('No roles are available.');
      setForm({ existing, roles, portfolios });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load user form.'); }
    finally { setPending(false); }
  }
  /** Requery successful saves rather than echoing edited browser values into the table. */
  function saved() { setForm(null); setMessage('User saved.'); users.reload(); }
  /** Revoke the target through a full public-facts maintenance write. */
  async function deactivate() {
    if (!target || pending) return;
    setPending(true); setError('');
    const { name, email, role, portfolioAccess, managerName, vendor } = target;
    try {
      await api<User>(`/admin/users/${target.id}`, { method: 'PUT',
        body: JSON.stringify({ name, email, role, portfolioAccess, managerName, vendor, status: 'Inactive' }) });
      setTarget(null); setMessage('User deactivated.'); users.reload();
    } catch (reason) {
      setTarget(null); setError(reason instanceof ApiError ? reason.message : 'Unable to deactivate user.');
    } finally { setPending(false); }
  }
  if (form) return <UserForm {...form} onSaved={saved} onCancel={() => setForm(null)} />;
  return (
    <>
      <div className="actions">
        <button disabled={pending} onClick={() => void open()}>{pending && !target ? 'Loading form…' : 'New user'}</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="feedback" role="status">{message}</p>}
      {users.loading ? (
        <div className="card" role="status">
          Loading users…
          <div className="skeleton-value" />
        </div>
      ) : users.error ? (
        <div className="card">
          <p className="error" role="alert">{users.error}</p>
          <button className="secondary" onClick={users.reload}>Retry</button>
        </div>
      ) : users.data && (
        <DataTable rows={users.data.items} rowKey={row => row.id} page={page} pageSize={size} total={users.data.total}
          onPage={next => { const query = new URLSearchParams(params); query.set('page', String(next)); setParams(query); }}
          columns={[
            { label: 'Name', render: row => row.name }, { label: 'Email', render: row => row.email },
            { label: 'Role', render: row => row.role },
            { label: 'Status', render: row => <span className={`chip admin-status-${row.status.toLowerCase()}`}>{row.status}</span> },
            { label: 'Last sign-in', render: row => row.lastSignIn ? new Date(row.lastSignIn).toLocaleString() : 'Never' },
            { label: 'Actions', render: row => (
              <>
                <button className="text-button" disabled={pending} onClick={() => void open(row)} aria-label={`Edit ${row.name}`}>Edit</button>
                {row.status === 'Active' && (
                  <button className="text-button" disabled={pending} onClick={() => { setError(''); setTarget(row); }}
                    aria-label={`Deactivate ${row.name}`}>
                    Deactivate
                  </button>
                )}
              </>
            ) },
          ]} />
      )}
      <ConfirmDialog open={Boolean(target)} title="Deactivate user?" pending={pending}
        message="This account will become inactive and all existing sessions will be revoked. Audit history is retained."
        onClose={() => { if (!pending) setTarget(null); }} onConfirm={() => void deactivate()} />
    </>
  );
}
