import {
  LayoutDashboard,
  ChartNoAxesColumn,
  Users,
  Building2,
  MonitorSmartphone,
  UtensilsCrossed,
  Image,
  MessageCircle,
  CheckSquare,
  Settings,
  Archive,
  KeyRound,
  DatabaseBackup,
  Megaphone,
  Sparkles,
  Network,
  Activity,
  School,
  ShieldCheck,
  Bug,
  ServerCog,
  History,
  Gauge,
  Lock,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import type { View } from './access';

// The panel's navigation, built from what the signed-in admin may do and from
// the view they are in. A school's view shows that school's work only; the
// global view adds the installation (schools, system). Hiding an entry
// is convenience: every page's API checks the same rights again.

export interface NavEntry {
  to: string;
  label: string;
  icon: LucideIcon;
  // Shown when the admin holds any of these in the current view.
  perms?: string[];
  // Which views offer it (default: both).
  views?: Array<View['kind']>;
}

export interface NavGroup {
  title: string;
  items: NavEntry[];
}

const BOTH: Array<View['kind']> = ['global', 'school'];
const GLOBAL: Array<View['kind']> = ['global'];
const SCHOOL: Array<View['kind']> = ['school'];

const GROUPS: NavGroup[] = [
  {
    title: 'Übersicht',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, perms: ['dashboard.view', 'global.dashboard'] },
      { to: '/analytics', label: 'Analytics', icon: ChartNoAxesColumn, perms: ['analytics.view'] },
      { to: '/requests', label: 'Anfragen', icon: Activity, perms: ['requests.view'] },
      { to: '/schools', label: 'Schulen', icon: School, perms: ['schools.view'], views: GLOBAL },
    ],
  },
  {
    title: 'Menschen',
    items: [
      { to: '/users', label: 'Nutzer', icon: Users, perms: ['users.view'] },
      { to: '/admins', label: 'Admins & Rechte', icon: ShieldCheck, perms: ['admins.view'] },
      { to: '/classes', label: 'Klassen', icon: Building2, perms: ['classes.view'] },
      { to: '/sessions', label: 'Sitzungen', icon: MonitorSmartphone, perms: ['sessions.view'] },
    ],
  },
  {
    title: 'Inhalte',
    items: [
      { to: '/dishes', label: 'Speiseplan', icon: UtensilsCrossed, perms: ['mensa.view'] },
      { to: '/comments', label: 'Kommentare', icon: MessageCircle, perms: ['comments.view'] },
      { to: '/todos-reminders', label: 'Todos & Erinnerungen', icon: CheckSquare, perms: ['todos.view'] },
      { to: '/popups', label: 'Popups', icon: Megaphone, perms: ['popups.view'] },
      { to: '/recaps', label: 'Recaps', icon: Sparkles, perms: ['recaps.view'] },
      { to: '/subject-images', label: 'Fachbilder', icon: Image, perms: ['subjectimages.manage'], views: GLOBAL },
    ],
  },
  {
    title: 'Protokolle',
    items: [
      { to: '/logs/frontend', label: 'Frontend-Logs', icon: Bug, perms: ['logs.frontend.view'] },
      { to: '/logs/backend', label: 'Backend-Logs', icon: ServerCog, perms: ['system.logs.view'], views: GLOBAL },
      { to: '/audit', label: 'Admin-Protokoll', icon: History, perms: ['audit.view'] },
    ],
  },
  {
    title: 'System',
    items: [
      { to: '/system', label: 'System & Leistung', icon: Gauge, perms: ['system.monitoring.view'], views: GLOBAL },
      { to: '/privacy', label: 'Datenschutz', icon: Lock, perms: ['privacy.view'], views: GLOBAL },
      { to: '/school-years', label: 'Schuljahre', icon: Archive, perms: ['schoolyears.manage'], views: GLOBAL },
      { to: '/api-keys', label: 'API-Keys', icon: KeyRound, perms: ['apikeys.manage'], views: GLOBAL },
      { to: '/backups', label: 'Backups', icon: DatabaseBackup, perms: ['backups.manage'], views: GLOBAL },
      { to: '/cluster', label: 'Cluster', icon: Network, perms: ['cluster.manage'], views: GLOBAL },
    ],
  },
  {
    title: 'Einstellungen',
    items: [
      { to: '/school', label: 'Schule', icon: SlidersHorizontal, perms: ['school.settings.view'], views: SCHOOL },
      { to: '/settings', label: 'Mein Konto', icon: Settings, views: BOTH },
    ],
  },
];

// Every route the panel has, with the rights it needs — for the page guard.
export const ALL_ENTRIES: NavEntry[] = GROUPS.flatMap((g) => g.items);

export function allowed(entry: NavEntry, kind: View['kind'], can: (p: string) => boolean): boolean {
  if (!(entry.views ?? BOTH).includes(kind)) return false;
  return !entry.perms || entry.perms.some(can);
}

export function navFor(kind: View['kind'], can: (p: string) => boolean): NavGroup[] {
  return GROUPS
    .map((g) => ({ title: g.title, items: g.items.filter((item) => allowed(item, kind, can)) }))
    .filter((g) => g.items.length > 0);
}

// The quick-access bar: the most used sections the admin can open, at most
// four, plus "Mehr" for everything else.
const DOCK_ORDER = ['/dashboard', '/analytics', '/users', '/requests', '/comments', '/dishes', '/admins', '/schools'];

export function dockFor(kind: View['kind'], can: (p: string) => boolean): NavEntry[] {
  return DOCK_ORDER
    .map((to) => ALL_ENTRIES.find((e) => e.to === to)!)
    .filter((entry) => allowed(entry, kind, can))
    .slice(0, 4)
    .map((entry) => (entry.to === '/admins' ? { ...entry, label: 'Admins' } : entry.to === '/todos-reminders' ? { ...entry, label: 'Todos' } : entry));
}

// The longest matching prefix wins: an entry lights up for its own page and
// every page below it, the most specific entry first.
export function activeNavPath(pathname: string, items: NavEntry[] = ALL_ENTRIES): string | null {
  let best: string | null = null;
  for (const item of items) {
    if (pathname === item.to || pathname.startsWith(`${item.to}/`)) {
      if (!best || item.to.length > best.length) best = item.to;
    }
  }
  return best;
}

export function entryFor(pathname: string): NavEntry | undefined {
  const path = activeNavPath(pathname);
  return path ? ALL_ENTRIES.find((e) => e.to === path) : undefined;
}
