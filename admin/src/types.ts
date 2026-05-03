export interface AdminUser {
  stableUid: string;
  username: string;
  webuntisKlasseId: number | null;
  webuntisKlasseName: string | null;
  classId: string | null;
  classCode: string | null;
  isAdmin: boolean;
  todoCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminTodo {
  id: string;
  title: string;
  details: string;
  dueAt: string | null;
  done: boolean;
  doneAt: string | null;
  createdAt: string;
}

export interface AdminUserClass {
  classId: string;
  className: string;
  classCode: string;
  joinedAt: string;
}

export interface AdminUserDetail extends AdminUser {
  todos: AdminTodo[];
  classes: AdminUserClass[];
}

export interface AdminStats {
  totalUsers: number;
  totalAdmins: number;
  totalClasses: number;
  totalTodos: number;
  totalReminders: number;
  totalActiveSessions: number;
  usersByDay: Array<{ date: string; count: number }>;
}

export interface AdminReminder {
  id: string;
  classId: string;
  title: string;
  body: string;
  remindAt: string;
  createdBy: string;
  createdByName: string;
  createdByUsername: string;
  createdAt: string;
}

export interface AdminClass {
  id: string;
  name: string;
  code: string;
  webuntisKlasseId: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  memberCount: number;
  members: Array<{ stableUid: string; username: string; joinedAt: string }>;
}

export interface AdminSession {
  id: string;
  stableUid: string;
  username: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  isActive: boolean;
}

export interface UsersResponse {
  users: AdminUser[];
  total: number;
  page: number;
  limit: number;
}

export interface RequestLog {
  id: string;
  method: string;
  path: string;
  status: number;
  duration: number;
  ip: string | null;
  stableUid: string | null;
  username: string | null;
  userAgent: string | null;
  error: string | null;
  createdAt: string;
}

export interface LogsResponse {
  logs: RequestLog[];
  total: number;
  page: number;
  limit: number;
}

export interface UserLogsResponse extends LogsResponse {
  user: { username: string } | null;
}

export interface SetupStatus {
  needsSetup: boolean;
  cloudflaredInstalled: boolean;
  cloudflareAuthed: boolean;
  tunnelConfigured: boolean;
  tunnelHostname: string | null;
}

export interface RequestsChartPoint {
  hour: string;
  count: number;
  errors: number;
}

export interface TopEndpoint {
  path: string;
  count: number;
  avgMs: number;
}
