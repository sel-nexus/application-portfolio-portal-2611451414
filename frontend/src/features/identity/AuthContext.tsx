/** Own session hydration, replacement, revocation, and current public identity. */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, SESSION_EXPIRED, TOKEN_KEY } from '../../api';
import { useResource } from '../../useResource';
import type { Session, User } from '../../types';

interface AuthState {
  user: User | null; loading: boolean; error: string; refresh: () => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>; replaceSession: (session: Session) => void;
  setUser: (user: User) => void;
}
const AuthContext = createContext<AuthState | null>(null);

/** Load profile through the shared resource hook only when a stored session exists. */
function Hydrate({ onUser, onError }: { onUser: (user: User) => void; onError: (error: string) => void }) {
  const resource = useResource<User>('/auth/me');
  useEffect(() => {
    if (resource.data) onUser(resource.data);
    if (resource.error) onError(resource.error);
  }, [resource.data, resource.error, onUser, onError]);
  return null;
}

/** Provide one device session, clearing protected UI immediately on expiry or sign-out. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(localStorage.getItem(TOKEN_KEY)));
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const accept = useCallback((value: User) => { setUser(value); setLoading(false); setError(''); }, []);
  const fail = useCallback((message: string) => {
    setLoading(false);
    setError(localStorage.getItem(TOKEN_KEY) ? message : '');
  }, []);
  const clear = useCallback(() => { localStorage.removeItem(TOKEN_KEY); setUser(null); setLoading(false); }, []);
  useEffect(() => {
    window.addEventListener(SESSION_EXPIRED, clear);
    return () => window.removeEventListener(SESSION_EXPIRED, clear);
  }, [clear]);
  /** Persist the replacement bearer before publishing the corresponding user facts. */
  function replaceSession(session: Session) {
    localStorage.setItem(TOKEN_KEY, session.token); accept(session.user);
  }
  /** Authenticate through the real boundary without redirecting failed login submissions. */
  async function login(email: string, password: string) {
    replaceSession(await api<Session>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }));
  }
  /** Revoke on the server; clear local state even when the connection fails. */
  async function logout() {
    try { await api<void>('/auth/logout', { method: 'POST' }); }
    finally { clear(); }
  }
  /** Recheck the stored session after navigation or a recoverable network error. */
  const refresh = useCallback(() => {
    if (localStorage.getItem(TOKEN_KEY)) { setLoading(true); setError(''); setRevision(value => value + 1); }
    else clear();
  }, [clear]);
  return (
    <AuthContext.Provider value={{ user, loading, error, refresh, login, logout, replaceSession, setUser: accept }}>
      {loading && <Hydrate key={revision} onUser={accept} onError={fail} />}
      {children}
    </AuthContext.Provider>
  );
}

/** Read identity state and surface incorrect provider placement immediately. */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth requires AuthProvider');
  return context;
}
