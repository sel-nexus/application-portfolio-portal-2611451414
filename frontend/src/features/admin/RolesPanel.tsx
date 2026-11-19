/** Read current role configuration and requery after permission changes. */
import { useState } from 'react';
import { useResource } from '../../useResource';
import { RoleForm } from './RoleForm';
import { useAuth } from '../identity/AuthContext';
import type { AdminRole } from '../../types';

/** Display stable names with actual persisted descriptions and permission sets. */
export function RolesPanel() {
  const resource = useResource<AdminRole[]>('/admin/roles');
  const auth = useAuth();
  const [role, setRole] = useState<AdminRole | null>(null);
  const [message, setMessage] = useState('');
  if (role) return (
    <RoleForm role={role} onCancel={() => setRole(null)} onSaved={() => {
      setRole(null); setMessage('Role saved.'); resource.reload();
      if (role.name === 'Administrator') auth.refresh();
    }} />
  );
  if (resource.loading) return (
    <div className="card" role="status">
      Loading roles…
      <div className="skeleton-value" />
    </div>
  );
  if (resource.error) return (
    <div className="card">
      <p role="alert" className="error">{resource.error}</p>
      <button className="secondary" onClick={resource.reload}>Retry</button>
    </div>
  );
  return (
    <>
      {message && <p role="status" className="feedback">{message}</p>}
      <div className="card table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Description</th>
              <th scope="col">Permissions</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {resource.data?.map(row => (
              <tr key={row.id}>
                <td>{row.name}</td>
                <td>{row.description}</td>
                <td>{row.permissions.join(', ') || 'None'}</td>
                <td>
                  <button className="text-button" aria-label={`Edit ${row.name}`} onClick={() => { setMessage(''); setRole(row); }}>Edit</button>
                </td>
              </tr>
            ))}
            {!resource.data?.length && (
              <tr>
                <td colSpan={4}>No records match these filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
