/** Inspect persisted history using the inherited flat administration grammar. */
import { useEffect, useRef, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { api, SESSION_EXPIRED, TOKEN_KEY } from '../../api';
import { DataTable } from '../../components/DataTable';
import { Field } from '../../components/Field';
import { useAuth } from '../identity/AuthContext';
import type { AuditEvent, AuditPageResult } from '../../types';

/** Gate history before mounting any protected history request. */
export default function AuditPage({ embedded = false }: { embedded?: boolean }) {
  const { user, loading } = useAuth();
  useEffect(() => { document.title = `${embedded ? 'Audit log' : 'Audit history'} | Portfolio`; }, [embedded]);
  if (loading || !user) return <p role="status">Checking audit access…</p>;
  if (user.mustChangePassword) return <Navigate to="/profile" replace />;
  const allowed = user.role === 'Administrator' ? user.permissions.includes('administer')
    : user.role === 'Auditor' && user.permissions.includes('view') && !embedded;
  if (!allowed) return <p role="alert">You do not have access to audit history.</p>;
  return <AuditHistory embedded={embedded} canExport={user.role === 'Administrator' && user.permissions.includes('export')} />;
}

/** Preserve filters and paging in the URL and never show stale results on errors. */
function AuditHistory({ embedded, canExport }: { embedded: boolean; canExport: boolean }) {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<AuditPageResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [revision, setRevision] = useState(0);
  const busy = useRef(false);
  const query = new URLSearchParams(params);
  query.delete('tab');
  const queryString = query.toString();
  const invalidDates = Boolean(params.get('from') && params.get('to') && params.get('from')! > params.get('to')!);
  useEffect(() => {
    if (invalidDates) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError('');
    api<AuditPageResult>(`/audit?${queryString}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setData(result);
    }).catch((reason: Error) => {
      if (!controller.signal.aborted) setError(reason.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [queryString, invalidDates, revision]);
  /** Reset the page while retaining the selected administration tab. */
  function filter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    next.delete('page'); setParams(next);
  }
  /** Download matching bytes and reload history so this export becomes visible. */
  async function download() {
    if (busy.current) return;
    busy.current = true; setPending(true); setDownloadError('');
    try {
      const filters = new URLSearchParams(queryString);
      filters.delete('page'); filters.delete('page_size');
      const base = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
      const response = await fetch(`${base}/api/v1/audit/csv?${filters}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) ?? ''}` }, cache: 'no-store',
      });
      if (!response.ok) {
        if (response.status === 401) {
          localStorage.removeItem(TOKEN_KEY); window.dispatchEvent(new Event(SESSION_EXPIRED));
        }
        const body = await response.json().catch(() => ({ detail: 'Unable to download CSV.' }));
        throw new Error(typeof body.detail === 'string' ? body.detail : 'Unable to download CSV.');
      }
      const url = URL.createObjectURL(await response.blob());
      try {
        const anchor = document.createElement('a');
        anchor.href = url; anchor.download = 'audit-log.csv'; anchor.click();
      } finally { URL.revokeObjectURL(url); }
      setRevision(value => value + 1);
    } catch (reason) { setDownloadError(reason instanceof Error ? reason.message : 'Unable to download CSV.'); }
    finally { busy.current = false; setPending(false); }
  }
  const columns = [
    { label: 'Time', render: (row: AuditEvent) => <time dateTime={row.time}>{row.time.replace('T', ' ').replace('Z', ' UTC')}</time> },
    { label: 'Person', render: (row: AuditEvent) => row.person },
    { label: 'Action', render: (row: AuditEvent) => row.action },
    { label: 'Entity type', render: (row: AuditEvent) => row.entityType },
    { label: 'Summary', render: (row: AuditEvent) => row.summary },
  ];
  const title = embedded ? 'Audit log' : 'Audit history';
  return (
    <>
      {embedded ? <h2>{title}</h2> : <h1>{title}</h1>}
      <p className="muted">Inspect persisted sensitive actions. Dates include the whole day in UTC.</p>
      <div className="dashboard-filters">
        {(['person', 'action'] as const).map(key => (
          <Field key={key} id={`audit-${key}`} label={key === 'person' ? 'Person' : 'Action'}>
            <select id={`audit-${key}`} value={params.get(key) ?? ''} onChange={event => filter(key, event.target.value)}>
              <option value="">{key === 'person' ? 'All people' : 'All actions'}</option>
              {params.get(key) && !data?.[key === 'person' ? 'persons' : 'actions'].includes(params.get(key)!) && (
                <option value={params.get(key)!}>{params.get(key)}</option>
              )}
              {data?.[key === 'person' ? 'persons' : 'actions'].map(value => <option key={value}>{value}</option>)}
            </select>
          </Field>
        ))}
        <Field id="audit-from" label="From date (UTC)">
          <input id="audit-from" type="date" value={params.get('from') ?? ''}
            onChange={event => filter('from', event.target.value)} />
        </Field>
        <Field id="audit-to" label="To date (UTC)">
          <input id="audit-to" type="date" value={params.get('to') ?? ''} aria-invalid={invalidDates}
            aria-describedby={invalidDates ? 'audit-date-error' : undefined} onChange={event => filter('to', event.target.value)} />
        </Field>
        <button className="secondary" onClick={() => setParams(embedded ? { tab: 'audit' } : {})}>Clear filters</button>
      </div>
      {invalidDates && <p id="audit-date-error" role="alert" className="error">To date must be on or after From date.</p>}
      {canExport && (
        <div className="actions mb-4">
          <button disabled={pending || loading || Boolean(error) || invalidDates} onClick={download}>
            {pending ? 'Downloading…' : 'Download CSV'}
          </button>
          {pending && <span role="status">Preparing audit CSV…</span>}
          {downloadError && <p role="alert" className="error">{downloadError}</p>}
        </div>
      )}
      {!invalidDates && (loading ? (
        <div className="card" role="status" aria-busy="true">
          <p>Loading audit history…</p>
          <div className="bg-surface-container h-10 mb-4 rounded" aria-hidden="true" />
          <div className="bg-surface-container h-10 rounded" aria-hidden="true" />
        </div>
      ) : error ? (
        <div className="card">
          <p role="alert" className="error">{error}</p>
          <button className="secondary" onClick={() => setRevision(value => value + 1)}>Retry</button>
        </div>
      ) : data && (
        <DataTable rows={data.items} columns={columns} rowKey={row => row.id}
          page={data.page} pageSize={data.page_size} total={data.total}
          onPage={page => { const next = new URLSearchParams(params); next.set('page', String(page)); setParams(next); }} />
      ))}
    </>
  );
}
