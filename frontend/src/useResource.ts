/** Provide cancellable loading, error, and retry state for API-backed resources. */
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/** Load a typed resource and ignore responses belonging to a superseded path. */
export function useResource<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    api<T>(path, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setData(value);
    }).catch((reason: Error) => {
      if (!controller.signal.aborted) setError(reason.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, revision]);
  return { data, loading, error, reload };
}
