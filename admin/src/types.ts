export interface AdminUser {
  stableUid: string;
  username: string;
  webuntisKlasseId: number | null;
  webuntisKlasseName: string | null;
  classId: string | null;
  classCode: string | null;
  isAdmin: boolean;
  role: 'student' | 'parent';
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

export interface AdminClassTodo extends AdminTodo {
  stableUid: string;
  username: string;
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
  requestsToday: number;
  errorsToday: number;
  avgResponseTimeToday: number;
  newUsersToday: number;
  newUsersThisWeek: number;
  serverUptime: number;
  usersByDay: Array<{ date: string; count: number }>;
}

export interface FileLogEntry {
  timestamp?: string;
  level?: string;
  message?: string;
  [key: string]: unknown;
}

export interface FileLogFile {
  filename: string;
  date: string;
  size: number;
}

export interface FileLogResponse {
  entries: FileLogEntry[];
  total: number;
  page: number;
  limit: number;
  date: string;
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

export interface AdminDishFull {
  id: string;
  nameDe: string;
  nameIt: string;
  nameEn: string;
  descDe: string;
  descIt: string;
  descEn: string;
  imageUrl: string;
  category: string;
  tags: string[];
  prepTime: number;
  calories: number;
  price: number;
  protein: number;
  fat: number;
  allergens: string[];
  isVegetarian: boolean;
  isVegan: boolean;
  date: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminDishImportResult {
  imported: number;
  updated: number;
  total: number;
}

export interface AdminDishRatingEntry {
  stableUid: string;
  username: string;
  stars: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminDish {
  dishId: string;
  name: string;
  imageUrl: string;
  avgStars: number;
  count: number;
  ratings: AdminDishRatingEntry[];
}


export interface AdminSubjectImage {
  key: string;
  longName: string;
  shortName: string;
  hasImage: boolean;
  mimeType: string | null;
  updatedAt: string | null;
}

export interface AdminComment {
  id: string;
  type: 'reminder' | 'dish';
  stableUid: string;
  username: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  contextId: string;
  contextTitle: string;
  classId: string | null;
}

export interface AdminCommentsResponse {
  comments: AdminComment[];
  total: number;
  page: number;
  limit: number;
}

export interface FrontendActivityLog {
  id: string;
  event: string;
  page: string | null;
  detail: string | null;
  stableUid: string | null;
  username: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface FrontendActivityLogsResponse {
  logs: FrontendActivityLog[];
  total: number;
  page: number;
  limit: number;
}

export interface FrontendActivityStats {
  totalToday: number;
  uniqueUsersToday: number;
  eventBreakdown: Array<{ event: string; count: number }>;
  topPages: Array<{ page: string; count: number }>;
}

export interface AdminAllTodo extends AdminTodo {
  stableUid: string;
  username: string;
  archivedAt: string | null;
}

export interface AllTodosResponse {
  todos: AdminAllTodo[];
  total: number;
  page: number;
  limit: number;
}

export interface AdminAllReminder extends AdminReminder {
  className: string;
  archivedAt: string | null;
}

export interface AllRemindersResponse {
  reminders: AdminAllReminder[];
  total: number;
  page: number;
  limit: number;
}

// ── School year archive ───────────────────────────────────────────────────────

export interface SchoolYearMeta {
  id: string;
  label: string;
  startYear: number;
  rolledAt: string;
  note: string;
  createdAt: string;
}

export interface SchoolYearsResponse {
  current: { label: string; startYear: number };
  archived: SchoolYearMeta[];
}

export interface ArchivedUser {
  id: string;
  schoolYearId: string;
  stableUid: string;
  username: string;
  role: 'student' | 'parent';
  webuntisKlasseId: number;
  webuntisKlasseName: string;
  classId: string | null;
  classCode: string | null;
  className: string | null;
  createdAt: string;
}

export interface ArchivedUsersResponse {
  users: ArchivedUser[];
  total: number;
  page: number;
  limit: number;
}

export interface ArchivedClassMember {
  stableUid: string;
  username: string;
  role: string;
  joinedAt: string;
}

export interface ArchivedClass {
  id: string;
  originalId: string;
  name: string;
  code: string;
  webuntisKlasseId: number;
  createdBy: string;
  createdByName: string;
  memberCount: number;
  members: ArchivedClassMember[];
  createdAt: string;
}

export interface ArchivedTodo {
  id: string;
  originalId: string;
  stableUid: string;
  username: string;
  title: string;
  details: string;
  dueAt: string | null;
  done: boolean;
  doneAt: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface ArchivedTodosResponse {
  todos: ArchivedTodo[];
  total: number;
  page: number;
  limit: number;
}

export interface ArchivedComment {
  id: string;
  stableUid: string;
  username: string;
  body: string;
  createdAt: string;
}

export interface ArchivedReminder {
  id: string;
  originalId: string;
  classId: string;
  className: string;
  title: string;
  body: string;
  remindAt: string;
  createdBy: string;
  createdByName: string;
  createdByUsername: string;
  archivedAt: string | null;
  comments: ArchivedComment[];
  createdAt: string;
}

export interface ArchivedRemindersResponse {
  reminders: ArchivedReminder[];
  total: number;
  page: number;
  limit: number;
}

export interface RolloverResult {
  ok: boolean;
  label: string;
  usersArchived: number;
  classesArchived: number;
  todosArchived: number;
  remindersArchived: number;
}
