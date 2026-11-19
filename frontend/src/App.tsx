/** Define the single browser router and fail-closed protected identity routes. */
import { useEffect } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell';
import { AuthProvider, useAuth } from './features/identity/AuthContext';
import LoginPage from './features/identity/LoginPage';
import ProfilePage from './features/identity/ProfilePage';

/** Revalidate the bearer on protected route navigation, including history Back. */
function Protected() {
  const auth = useAuth();
  const location = useLocation();
  useEffect(() => { auth.refresh(); }, [location.key, auth.refresh]);
  if (auth.loading) return <main className="container" role="status">Checking session…</main>;
  if (auth.error) return (
    <main className="container">
      <p role="alert">{auth.error}</p>
      <button onClick={auth.refresh}>Retry</button>
      <a href="/">Return to sign in</a>
    </main>
  );
  return auth.user ? <Outlet /> : <Navigate to="/" replace />;
}

/** Map only completed identity pages; future landing preferences do not create dummy pages. */
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<LoginPage />} />
          <Route element={<Protected />}>
            <Route element={<Shell />}>
              <Route path="/profile" element={<ProfilePage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
