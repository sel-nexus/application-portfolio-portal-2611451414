/** Edit a persisted role description and the six allowed permission selections. */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../../api';
import { Field } from '../../components/Field';
import type { AdminRole, Permission } from '../../types';
const choices: Permission[] = ['view', 'create', 'edit', 'delete', 'export', 'administer'];

/** Preserve the role name and surface server refusals without discarding selections. */
export function RoleForm({ role, onSaved, onCancel }: { role: AdminRole; onSaved: () => void; onCancel: () => void }) {
  const [description, setDescription] = useState(role.description);
  const [permissions, setPermissions] = useState(role.permissions);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Save only editable role configuration and then requery the list. */
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError(''); setErrors({});
    try {
      await api<AdminRole>(`/admin/roles/${role.id}`, { method: 'PUT', body: JSON.stringify({ description, permissions }) });
      onSaved();
    } catch (reason) {
      if (reason instanceof ApiError) { setError(reason.message); setErrors(reason.fields); }
      else setError('Unable to save role.');
    } finally { setPending(false); }
  }
  return (
    <form className="card" noValidate onSubmit={save}>
      <h2>Edit {role.name}</h2>
      <p className="muted">Role names stay fixed. Delete and administration remain Administrator-only even when selected for other roles.</p>
      <div className="form-grid">
        <Field id="role-description" label="Description" error={errors.description}>
          <textarea id="role-description" className="h-24 py-2" maxLength={5000} value={description}
            aria-invalid={Boolean(errors.description)} aria-describedby={errors.description ? 'role-description-error' : undefined}
            onChange={event => setDescription(event.target.value)} />
        </Field>
        <fieldset className="admin-choices" aria-describedby={errors.permissions ? 'role-permissions-error' : undefined}>
          <legend>Permissions</legend>
          {choices.map(permission => (
            <label key={permission}>
              <input type="checkbox" checked={permissions.includes(permission)}
                onChange={event => setPermissions(event.target.checked
                  ? [...permissions, permission] : permissions.filter(value => value !== permission))} />
              {permission}
            </label>
          ))}
          {errors.permissions && <p id="role-permissions-error" role="alert" className="error">{errors.permissions}</p>}
        </fieldset>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions">
        <button type="button" className="secondary" disabled={pending} onClick={onCancel}>Cancel</button>
        <button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}
