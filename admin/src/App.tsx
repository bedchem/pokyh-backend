import { BrowserRouter, Routes, Route, Navigate, useLocation, Link, Outlet } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';
import { useAuth } from './hooks/useAuth';
import { AccessProvider, useAccess } from './access';
import { allowed, entryFor } from './nav';
import { ToastProvider } from './components/Toast';
import { Layout } from './components/Layout';
import { MarkLoader } from './components/kit';
import { SecondFactorGate } from './components/SecondFactorGate';
import { LoginPage } from './pages/LoginPage';
import { SetupPage } from './pages/SetupPage';
import { DashboardPage } from './pages/DashboardPage';
import { Suspense, lazy, useState, useEffect } from 'react';
// Every page but the first ones is its own chunk, loaded when it is opened:
// the panel starts with the sign-in, the dashboard and the shell only.
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })));
const UsersPage = lazy(() => import('./pages/UsersPage').then((m) => ({ default: m.UsersPage })));
const ClassesPage = lazy(() => import('./pages/ClassesPage').then((m) => ({ default: m.ClassesPage })));
const SessionsPage = lazy(() => import('./pages/SessionsPage').then((m) => ({ default: m.SessionsPage })));
const DishesPage = lazy(() => import('./pages/DishesPage').then((m) => ({ default: m.DishesPage })));
const SubjectImagesPage = lazy(() => import('./pages/SubjectImagesPage').then((m) => ({ default: m.SubjectImagesPage })));
const CommentsPage = lazy(() => import('./pages/CommentsPage').then((m) => ({ default: m.CommentsPage })));
const LogFilesPage = lazy(() => import('./pages/LogFilesPage').then((m) => ({ default: m.LogFilesPage })));
const TodosRemindersPage = lazy(() => import('./pages/TodosRemindersPage').then((m) => ({ default: m.TodosRemindersPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const SchoolYearsPage = lazy(() => import('./pages/SchoolYearsPage').then((m) => ({ default: m.SchoolYearsPage })));
const ApiKeysPage = lazy(() => import('./pages/ApiKeysPage').then((m) => ({ default: m.ApiKeysPage })));
const BackupsPage = lazy(() => import('./pages/BackupsPage').then((m) => ({ default: m.BackupsPage })));
const PopupsPage = lazy(() => import('./pages/PopupsPage').then((m) => ({ default: m.PopupsPage })));
const RecapsPage = lazy(() => import('./pages/RecapsPage').then((m) => ({ default: m.RecapsPage })));
const ClusterPage = lazy(() => import('./pages/ClusterPage').then((m) => ({ default: m.ClusterPage })));
const RequestsPage = lazy(() => import('./pages/RequestsPage').then((m) => ({ default: m.RequestsPage })));
const SchoolsPage = lazy(() => import('./pages/SchoolsPage').then((m) => ({ default: m.SchoolsPage })));
const SchoolSettingsPage = lazy(() => import('./pages/SchoolSettingsPage').then((m) => ({ default: m.SchoolSettingsPage })));
const AdminsPage = lazy(() => import('./pages/AdminsPage').then((m) => ({ default: m.AdminsPage })));
const FrontendLogsPage = lazy(() => import('./pages/FrontendLogsPage').then((m) => ({ default: m.FrontendLogsPage })));
const BackendLogsPage = lazy(() => import('./pages/BackendLogsPage').then((m) => ({ default: m.BackendLogsPage })));
const AuditPage = lazy(() => import('./pages/AuditPage').then((m) => ({ default: m.AuditPage })));
const SystemPage = lazy(() => import('./pages/SystemPage').then((m) => ({ default: m.SystemPage })));
const PrivacyPage = lazy(() => import('./pages/PrivacyPage').then((m) => ({ default: m.PrivacyPage })));

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
  if (me?.secondFactorSetupRequired) return <SecondFactorGate />;
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
  return (
    <Layout bleed={BLEED.has(pathname)}>
      <Suspense fallback={<div className="grid min-h-[40vh] place-items-center"><MarkLoader size={40} /></div>}>
        <Outlet />
      </Suspense>
    </Layout>
  );
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
            <Route path="/backups"           element={<BackupsPage />} />
            <Route path="/popups"            element={<PopupsPage />} />
            <Route path="/recaps"            element={<RecapsPage />} />
            <Route path="/cluster"           element={<ClusterPage />} />
            </Route>
            <Route path="*"                  element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  );
}
