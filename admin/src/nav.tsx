import {
  LayoutDashboard,
  ChartNoAxesColumn,
  Users,
  Building2,
  MonitorSmartphone,
  ScrollText,
  UtensilsCrossed,
  Image,
  MessageCircle,
  FileText,
  CheckSquare,
  Settings,
  Archive,
  KeyRound,
  GraduationCap,
  BookOpen,
  DatabaseBackup,
  Megaphone,
  Bot,
  Network,
  type LucideIcon,
} from 'lucide-react';

export interface NavEntry {
  to: string;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  title: string;
  items: NavEntry[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Overview',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/analytics', label: 'Analytics', icon: ChartNoAxesColumn },
      { to: '/users',     label: 'Users',     icon: Users },
      { to: '/classes',   label: 'Classes',   icon: Building2 },
      { to: '/sessions',  label: 'Sessions',  icon: MonitorSmartphone },
    ],
  },
  {
    title: 'Content',
    items: [
      { to: '/dishes',          label: 'Speiseplan',           icon: UtensilsCrossed },
      { to: '/comments',        label: 'Kommentare',           icon: MessageCircle },
      { to: '/subject-images',  label: 'Fachbilder',           icon: Image },
      { to: '/todos-reminders', label: 'Todos & Erinnerungen', icon: CheckSquare },
      { to: '/popups',          label: 'Popups',               icon: Megaphone },
    ],
  },
  {
    title: 'Learn',
    items: [
      { to: '/learn',         label: 'Learn',       icon: GraduationCap },
      { to: '/learn/courses', label: 'Learn-Kurse', icon: BookOpen },
      { to: '/learn/ai',      label: 'Pokyh AI',    icon: Bot },
    ],
  },
  {
    title: 'System',
    items: [
      { to: '/school-years', label: 'Schuljahre',    icon: Archive },
      { to: '/logs',         label: 'Logs',          icon: ScrollText },
      { to: '/log-files',    label: 'Logdateien',    icon: FileText },
      { to: '/api-keys',     label: 'API-Keys',      icon: KeyRound },
      { to: '/backups',      label: 'Backups',       icon: DatabaseBackup },
      { to: '/cluster',      label: 'Cluster',       icon: Network },
      { to: '/settings',     label: 'Einstellungen', icon: Settings },
    ],
  },
];

export const NAV_ITEMS: NavEntry[] = NAV_GROUPS.flatMap((g) => g.items);

// The tabs of the bottom bar on small screens; everything else is one tap
// away under "Mehr".
export const DOCK_TABS: NavEntry[] = [
  { to: '/dashboard', label: 'Dashboard',  icon: LayoutDashboard },
  { to: '/users',     label: 'Users',      icon: Users },
  { to: '/classes',   label: 'Classes',    icon: Building2 },
  { to: '/dishes',    label: 'Speiseplan', icon: UtensilsCrossed },
];

// The longest matching prefix wins, so /learn/courses lights up "Learn-Kurse"
// alone and an unlisted child such as /learn/teams falls back to "Learn".
export function activeNavPath(pathname: string): string | null {
  let best: string | null = null;
  for (const item of NAV_ITEMS) {
    if (pathname === item.to || pathname.startsWith(`${item.to}/`)) {
      if (!best || item.to.length > best.length) best = item.to;
    }
  }
  return best;
}
