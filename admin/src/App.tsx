import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { ToastProvider } from './components/Toast';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { SetupPage } from './pages/SetupPage';
import { DashboardPage } from './pages/DashboardPage';
import { UsersPage } from './pages/UsersPage';
import { ClassesPage } from './pages/ClassesPage';
import { SessionsPage } from './pages/SessionsPage';
import { LogsPage } from './pages/LogsPage';
import { TunnelPage } from './pages/TunnelPage';
import { DishesPage } from './pages/DishesPage';
import { SubjectImagesPage } from './pages/SubjectImagesPage';
import { CommentsPage } from './pages/CommentsPage';
import { LogFilesPage } from './pages/LogFilesPage';
import { ReactNode, Suspense, useState, useEffect } from 'react';
import { setupApi } from './api';
import type { SetupStatus } from './types';

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
}

function RootRedirect() {
  const { isAuthenticated } = useAuth();
  return <Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />;
}

function Spinner() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#000000',
      }}
    >
      <div
        style={{
          width: '28px',
          height: '28px',
          borderRadius: '50%',
          border: '2px solid rgba(255,255,255,0.1)',
          borderTopColor: '#0a84ff',
          animation: 'spin 0.8s linear infinite',
        }}
      />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export default function App() {
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [setupLoading, setSetupLoading] = useState(true);

  useEffect(() => {
    setupApi.status()
      .then(s => setSetupStatus(s))
      .catch(() => setSetupStatus(null))
      .finally(() => setSetupLoading(false));
  }, []);

  const handleSetupComplete = () => {
    setSetupStatus(prev => prev ? { ...prev, needsSetup: false } : null);
    window.location.hash = '#/dashboard';
  };

  if (setupLoading) return <Spinner />;

  if (setupStatus?.needsSetup) {
    return (
      <SetupPage
        onComplete={handleSetupComplete}
        initialStatus={{
          cloudflaredInstalled: setupStatus.cloudflaredInstalled,
          cloudflareAuthed: setupStatus.cloudflareAuthed,
          tunnelConfigured: setupStatus.tunnelConfigured,
          tunnelHostname: setupStatus.tunnelHostname,
        }}
      />
    );
  }

  return (
    <ToastProvider>
      <HashRouter>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/"               element={<RootRedirect />} />
            <Route path="/login"          element={<LoginPage />} />
            <Route path="/dashboard"      element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
            <Route path="/users"          element={<ProtectedRoute><UsersPage /></ProtectedRoute>} />
            <Route path="/classes"        element={<ProtectedRoute><ClassesPage /></ProtectedRoute>} />
            <Route path="/sessions"       element={<ProtectedRoute><SessionsPage /></ProtectedRoute>} />
            <Route path="/logs"           element={<ProtectedRoute><LogsPage /></ProtectedRoute>} />
            <Route path="/tunnel"         element={<ProtectedRoute><TunnelPage /></ProtectedRoute>} />
            <Route path="/dishes"         element={<ProtectedRoute><DishesPage /></ProtectedRoute>} />
            <Route path="/subject-images" element={<ProtectedRoute><SubjectImagesPage /></ProtectedRoute>} />
            <Route path="/comments"       element={<ProtectedRoute><CommentsPage /></ProtectedRoute>} />
            <Route path="/log-files"      element={<ProtectedRoute><LogFilesPage /></ProtectedRoute>} />
            <Route path="*"               element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </HashRouter>
    </ToastProvider>
  );
}
