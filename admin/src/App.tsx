import { BrowserRouter, Routes, Route, Navigate, useLocation, Link, Outlet } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';
import { useAuth } from './hooks/useAuth';
import { AccessProvider, useAccess } from './access';
import { allowed, entryFor } from './nav';
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
import { RequestsPage } from './pages/RequestsPage';
import { SchoolsPage } from './pages/SchoolsPage';
import { SchoolSettingsPage } from './pages/SchoolSettingsPage';
import { AdminsPage } from './pages/AdminsPage';
import { FrontendLogsPage } from './pages/FrontendLogsPage';
import { BackendLogsPage } from './pages/BackendLogsPage';
import { AuditPage } from './pages/AuditPage';
import { SystemPage } from './pages/SystemPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { Suspense, useState, useEffect } from 'react';
import { setupApi } from './api';
import type { SetupStatus } from './types';

// "/admin/" from vite's base, without the trailing slash.
const ROUTER_BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '');

// Everything behind the login: one access context and one layout for all
// pages, so switching sections keeps both (and the view) in place.
function AuthedShell() {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return (
    <AccessProvider fallback={<Spinner />}>
      <Guarded />
    </AccessProvider>
  );
}

// Pages that lay out the full height themselves.
const BLEED = new Set(['/dashboard']);

// A page the admin may not open in this view shows why, instead of a broken
// page; the API would refuse its data anyway.
function Guarded() {
  const { view, can, me } = useAccess();
  const { pathname } = useLocation();
  if (!view) {
    return (
      <NoAccess
        title="Noch keine Rechte"
        text={`Das Konto ${me?.username ?? ''} kann sich anmelden, hat aber noch keine Rechte. Ein Admin muss sie unter „Admins & Rechte“ vergeben.`}
        showHome={false}
      />
    );
  }
  const entry = entryFor(pathname);
  if (entry && !allowed(entry, view.kind, can)) {
    return (
      <Layout>
        <NoAccess
          title="Kein Zugriff"
          text={view.kind === 'school' ? 'Diesen Bereich gibt es in der Schulansicht nicht, oder dir fehlen dafür die Rechte in dieser Schule.' : 'Für diesen Bereich fehlen dir die Rechte.'}
          showHome
        />
      </Layout>
    );
  }
  return <Layout bleed={BLEED.has(pathname)}><Outlet /></Layout>;
}

function NoAccess({ title, text, showHome }: { title: string; text: string; showHome: boolean }) {
  const { logout } = useAuth();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="orb h-14 w-14"><ShieldOff size={24} strokeWidth={1.6} /></span>
      <h1 className="text-[22px] font-semibold">{title}</h1>
      <p className="max-w-[46ch] text-[15px] text-ink-3">{text}</p>
      {showHome
        ? <Link to="/dashboard" className="btn">Zur Übersicht</Link>
        : <button type="button" className="btn" onClick={() => { logout(); window.location.assign(`${import.meta.env.BASE_URL}login`); }}>Abmelden</button>}
    </div>
  );
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
            <Route element={<AuthedShell />}>
            <Route path="/dashboard"      element={<DashboardPage />} />
            <Route path="/analytics"      element={<AnalyticsPage />} />
            <Route path="/users"          element={<UsersPage />} />
            <Route path="/classes"        element={<ClassesPage />} />
            <Route path="/sessions"       element={<SessionsPage />} />
            <Route path="/logs"           element={<Navigate to="/requests" replace />} />
            <Route path="/requests"       element={<RequestsPage />} />
            <Route path="/schools"        element={<SchoolsPage />} />
            <Route path="/school"         element={<SchoolSettingsPage />} />
            <Route path="/admins"         element={<AdminsPage />} />
            <Route path="/logs/frontend"  element={<FrontendLogsPage />} />
            <Route path="/logs/backend"   element={<BackendLogsPage />} />
            <Route path="/logs/backend/files" element={<LogFilesPage />} />
            <Route path="/audit"          element={<AuditPage />} />
            <Route path="/system"         element={<SystemPage />} />
            <Route path="/privacy"        element={<PrivacyPage />} />
            <Route path="/dishes"         element={<DishesPage />} />
            <Route path="/subject-images" element={<SubjectImagesPage />} />
            <Route path="/comments"          element={<CommentsPage />} />
            <Route path="/log-files"         element={<Navigate to="/logs/backend/files" replace />} />
            <Route path="/todos-reminders"   element={<TodosRemindersPage />} />
            <Route path="/settings"          element={<SettingsPage />} />
            <Route path="/school-years"      element={<SchoolYearsPage />} />
            <Route path="/api-keys"          element={<ApiKeysPage />} />
            <Route path="/learn"             element={<LearnConfigPage />} />
            <Route path="/learn/ai"          element={<LearnAiPage />} />
            <Route path="/learn/teams"       element={<LearnTeamsPage />} />
            <Route path="/learn/courses"     element={<LearnCoursesPage />} />
            <Route path="/backups"           element={<BackupsPage />} />
            <Route path="/popups"            element={<PopupsPage />} />
            <Route path="/cluster"           element={<ClusterPage />} />
            </Route>
            <Route path="*"                  element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  );
}
