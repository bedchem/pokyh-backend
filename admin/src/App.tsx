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

  if (setupLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#080810' }}>
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

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
            <Route path="/" element={<RootRedirect />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/dashboard" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
            <Route path="/users" element={<ProtectedRoute><UsersPage /></ProtectedRoute>} />
            <Route path="/classes" element={<ProtectedRoute><ClassesPage /></ProtectedRoute>} />
            <Route path="/sessions" element={<ProtectedRoute><SessionsPage /></ProtectedRoute>} />
            <Route path="/logs" element={<ProtectedRoute><LogsPage /></ProtectedRoute>} />
            <Route path="/tunnel" element={<ProtectedRoute><TunnelPage /></ProtectedRoute>} />
            <Route path="/dishes" element={<ProtectedRoute><DishesPage /></ProtectedRoute>} />
            <Route path="/subject-images" element={<ProtectedRoute><SubjectImagesPage /></ProtectedRoute>} />
            <Route path="/comments" element={<ProtectedRoute><CommentsPage /></ProtectedRoute>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </HashRouter>
    </ToastProvider>
  );
}
