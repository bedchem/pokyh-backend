import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { ToastProvider } from './components/Toast';
import { Layout } from './components/Layout';
import { MarkLoader } from './components/kit';
import { LoginPage } from './pages/LoginPage';
import { SetupPage } from './pages/SetupPage';
import { DashboardPage } from './pages/DashboardPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { UsersPage } from './pages/UsersPage';
import { ClassesPage } from './pages/ClassesPage';
import { SessionsPage } from './pages/SessionsPage';
import { LogsPage } from './pages/LogsPage';
import { DishesPage } from './pages/DishesPage';
import { SubjectImagesPage } from './pages/SubjectImagesPage';
import { CommentsPage } from './pages/CommentsPage';
import { LogFilesPage } from './pages/LogFilesPage';
import { TodosRemindersPage } from './pages/TodosRemindersPage';
import { SettingsPage } from './pages/SettingsPage';
import { SchoolYearsPage } from './pages/SchoolYearsPage';
import { ApiKeysPage } from './pages/ApiKeysPage';
import { LearnConfigPage } from './pages/LearnConfigPage';
import { LearnAiPage } from './pages/LearnAiPage';
import { LearnTeamsPage } from './pages/LearnTeamsPage';
import { LearnCoursesPage } from './pages/LearnCoursesPage';
import { BackupsPage } from './pages/BackupsPage';
import { PopupsPage } from './pages/PopupsPage';
import { ClusterPage } from './pages/ClusterPage';
import { ReactNode, Suspense, useState, useEffect } from 'react';
import { setupApi } from './api';
import type { SetupStatus } from './types';

// "/admin/" from vite's base, without the trailing slash.
const ROUTER_BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '');

function ProtectedRoute({ children, bleed }: { children: ReactNode; bleed?: boolean }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <Layout bleed={bleed}>{children}</Layout>;
}

function RootRedirect() {
  const { isAuthenticated } = useAuth();
  return <Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />;
}

function Spinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas">
      <MarkLoader size={40} />
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
    // The router is not mounted yet; it starts at this address.
    window.history.replaceState(null, '', `${import.meta.env.BASE_URL}dashboard`);
    setSetupStatus(prev => prev ? { ...prev, needsSetup: false } : null);
  };

  if (setupLoading) return <Spinner />;

  if (setupStatus?.needsSetup) {
    return (
      <SetupPage onComplete={handleSetupComplete} />
    );
  }

  return (
    <ToastProvider>
      {/* Plain paths under /admin/ (the server answers every one of them with
          the panel), e.g. /admin/dashboard. */}
      <BrowserRouter basename={ROUTER_BASENAME}>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/"               element={<RootRedirect />} />
            <Route path="/login"          element={<LoginPage />} />
            <Route path="/dashboard"      element={<ProtectedRoute bleed><DashboardPage /></ProtectedRoute>} />
            <Route path="/analytics"      element={<ProtectedRoute><AnalyticsPage /></ProtectedRoute>} />
            <Route path="/users"          element={<ProtectedRoute><UsersPage /></ProtectedRoute>} />
            <Route path="/classes"        element={<ProtectedRoute><ClassesPage /></ProtectedRoute>} />
            <Route path="/sessions"       element={<ProtectedRoute><SessionsPage /></ProtectedRoute>} />
            <Route path="/logs"           element={<ProtectedRoute><LogsPage /></ProtectedRoute>} />
            <Route path="/dishes"         element={<ProtectedRoute><DishesPage /></ProtectedRoute>} />
            <Route path="/subject-images" element={<ProtectedRoute><SubjectImagesPage /></ProtectedRoute>} />
            <Route path="/comments"          element={<ProtectedRoute><CommentsPage /></ProtectedRoute>} />
            <Route path="/log-files"         element={<ProtectedRoute><LogFilesPage /></ProtectedRoute>} />
            <Route path="/todos-reminders"   element={<ProtectedRoute><TodosRemindersPage /></ProtectedRoute>} />
            <Route path="/settings"          element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
            <Route path="/school-years"      element={<ProtectedRoute><SchoolYearsPage /></ProtectedRoute>} />
            <Route path="/api-keys"          element={<ProtectedRoute><ApiKeysPage /></ProtectedRoute>} />
            <Route path="/learn"             element={<ProtectedRoute><LearnConfigPage /></ProtectedRoute>} />
            <Route path="/learn/ai"          element={<ProtectedRoute><LearnAiPage /></ProtectedRoute>} />
            <Route path="/learn/teams"       element={<ProtectedRoute><LearnTeamsPage /></ProtectedRoute>} />
            <Route path="/learn/courses"     element={<ProtectedRoute><LearnCoursesPage /></ProtectedRoute>} />
            <Route path="/backups"           element={<ProtectedRoute><BackupsPage /></ProtectedRoute>} />
            <Route path="/popups"            element={<ProtectedRoute><PopupsPage /></ProtectedRoute>} />
            <Route path="/cluster"           element={<ProtectedRoute><ClusterPage /></ProtectedRoute>} />
            <Route path="*"                  element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  );
}
