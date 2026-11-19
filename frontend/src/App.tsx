/** Define the single browser router and fail-closed protected identity routes. */
import { useEffect } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell';
import { AuthProvider, useAuth } from './features/identity/AuthContext';
import LoginPage from './features/identity/LoginPage';
import ProfilePage from './features/identity/ProfilePage';
import DashboardPage from './features/dashboard/DashboardPage';
import PortfolioListPage from './features/portfolios/PortfolioListPage';
import PortfolioDetailPage from './features/portfolios/PortfolioDetailPage';
import PortfolioFormPage from './features/portfolios/PortfolioFormPage';
import ApplicationListPage from './features/applications/ApplicationListPage';
import ApplicationDetailPage from './features/applications/ApplicationDetailPage';
import ApplicationFormPage from './features/applications/ApplicationFormPage';
import ReportsPage from './features/reports/ReportsPage';

/** Revalidate the bearer on protected route navigation, including history Back. */
function Protected() {
  const auth = useAuth();
  const location = useLocation();
  useEffect(() => { auth.refresh(); }, [location.pathname, auth.refresh]);
  if (auth.loading) return <main className="container" role="status">Checking session…</main>;
  if (auth.error) return (
    <main className="container">
      <p role="alert">{auth.error}</p>
      <button onClick={auth.refresh}>Retry</button>
      <a href="/">Return to sign in</a>
    </main>
  );
  if (auth.user?.mustChangePassword && location.pathname !== '/profile') return <Navigate to="/profile" replace />;
  return auth.user ? <Outlet /> : <Navigate to="/" replace />;
}

/** Map completed inventory and dashboard pages through one protected shell. */
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<LoginPage />} />
          <Route element={<Protected />}>
            <Route element={<Shell />}>
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/reports/:report" element={<ReportsPage />} />
              <Route path="/applications" element={<ApplicationListPage />} />
              <Route path="/applications/new" element={<ApplicationFormPage />} />
              <Route path="/applications/:applicationId" element={<ApplicationDetailPage />} />
              <Route path="/applications/:applicationId/edit" element={<ApplicationFormPage />} />
              <Route path="/portfolios" element={<PortfolioListPage />} />
              <Route path="/portfolios/new" element={<PortfolioFormPage />} />
              <Route path="/portfolios/:portfolioId" element={<PortfolioDetailPage />} />
              <Route path="/portfolios/:portfolioId/edit" element={<PortfolioFormPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
