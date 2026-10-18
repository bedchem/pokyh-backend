import type { AdminStats, AdminClass, AdminSession, UsersResponse, LogsResponse, UserLogsResponse, SetupStatus, RequestsChartPoint, TopEndpoint, AdminUserDetail, AdminTodo, AdminReminder, AdminClassTodo, AdminDish, AdminDishFull, AdminDishImportResult, AdminDishShiftResult, AdminDishRotateResult, AdminDishResetResult, AdminDishAnchorResult, DishPlan, AdminCommentsResponse, FileLogFile, FileLogResponse, FileLogEntry, FrontendActivityLogsResponse, FrontendActivityStats, AllTodosResponse, AllRemindersResponse, SchoolYearsResponse, ArchivedUsersResponse, ArchivedClass, ArchivedTodosResponse, ArchivedRemindersResponse, RolloverResult, RollbackResult, AdminApiKey, CreatedApiKey, LearnConfigValues, LearnAiConfigValues, LearnAiGrant, LearnAiTeamGrant, AdminLearnTeam, LearnTeamAssignableRole, AdminLearnCoursesResponse, AdminLearnCourseAccessResponse, AdminLearnCourse, AdminLearnCourseAccess, LearnCoursePermission, LearnCourseStatus, LearnCourseVisibility, AdminLearnCourseVocabularyResponse, AdminLearnVocabularyImportResponse, BackupsResponse, AdminPopup, PopupInput, ClusterStatus, ClusterInstall, CreatedClusterInstall, ClusterReach, ReachEntry, AdminAnalytics, AnalyticsRange, AnalyticsPeople, PeopleFilters, AnalyticsBreakdown, BreakdownKind, AnalyticsDishes, AnalyticsVisitors, AnalyticsVisitorIp, AnalyticsPersonDetail, VisitSource, ClusterUpdates, ClusterUpdateSettings, PopupTargetUser, PopupTargetClass, ClusterScope, WayTestResult, ReachKind, LoginResult, PasskeyChallenge, AdminSecurityStatus, TotpSetup, AdminPasskey, AccountRole } from './types';
import type { SearchKind, SearchResponse } from './types';
import type { AdminMe, AccessCatalog, AdminSchool, MensaMenu, AdminAccount, AdminGrantView, GrantInput, AuditEventsResponse, RequestScopeChoice, RequestsSummary, PerformanceReport, SystemHealth, SystemLogsResponse, ClientErrorGroup, ClientErrorOccurrence, PrivacyOverview, DishCommentGroupsResponse, DishCommentsResponse, ReminderCommentGroup, ReminderCommentItem } from './types';
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/browser';

const TOKEN_KEY = 'pokyh_admin_token';

// The school the panel is looking at (null: the global view of every school).
// Every request names it in X-Pokyh-School; the server checks the admin's
// rights in that school and limits what it answers to it. Set by access.tsx
// before any page renders.
let schoolContext: string | null = null;

export function setSchoolContext(schoolId: string | null): void {
  schoolContext = schoolId;
}

export function currentSchoolContext(): string | null {
  return schoolContext;
}

// The global view's Mensa pages work on one chosen menu; a school's view
// always on the school's own (the server ignores this there).
let menuContext: string | null = null;

export function setMenuContext(menuId: string | null): void {
  menuContext = menuId;
}

const MENU_PATHS = ['/api/admin/dishes', '/api/admin/dish-ratings', '/api/admin/comments/dishes'];

// The Analytics page can page back in time: its rolling periods then end on
// this day instead of today, for the page and everything it opens.
let analyticsEnd: string | null = null;

export function setAnalyticsEnd(end: string | null): void {
  analyticsEnd = end;
}

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (schoolContext) headers['X-Pokyh-School'] = schoolContext;

  if (menuContext && !schoolContext && MENU_PATHS.some((prefix) => path.startsWith(prefix))) {
    if (method === 'GET' || method === 'DELETE') {
      path += `${path.includes('?') ? '&' : '?'}menuId=${encodeURIComponent(menuContext)}`;
    } else if (body === undefined || (typeof body === 'object' && body !== null && !Array.isArray(body))) {
      body = { ...(body as Record<string, unknown> | undefined), menuId: menuContext };
    }
  }

  if (analyticsEnd && method === 'GET' && path.startsWith('/api/admin/analytics')) {
    path += `${path.includes('?') ? '&' : '?'}end=${analyticsEnd}`;
  }

  if (import.meta.env.DEV) {
    console.log(`[adminApi] ${method} ${path}`, body ?? '');
  }

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  if (res.status === 401) {
    clearToken();
    const loginPath = `${import.meta.env.BASE_URL}login`;
    if (window.location.pathname !== loginPath) window.location.assign(loginPath);
    throw new Error('Session expired');
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // ignore
    }
    throw new ApiError(message, res.status);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

// Login steps use raw fetch — the generic request() handler treats 401 as
// "session expired", which is wrong for the login form (it should show the
// server's message instead).
async function loginStep<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error === 'Invalid credentials' ? 'Benutzername oder Passwort falsch' : data.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function storeToken(data: { token: string }): string {
  setToken(data.token);
  return data.token;
}

export const adminApi = {
  /** The token, or — with a second factor set up — the ticket for step two. */
  login: async (username: string, password: string): Promise<LoginResult> => {
    const data = await loginStep<LoginResult>('/api/admin/auth/login', { username, password });
    if ('token' in data) return { token: storeToken(data) };
    return data;
  },

  /** After a one-time password: the admin's own password, then the next login step. */
  setupPassword: async (ticket: string, newPassword: string): Promise<LoginResult> => {
    const data = await loginStep<LoginResult>('/api/admin/auth/password-setup', { ticket, newPassword });
    if ('token' in data) return { token: storeToken(data) };
    return data;
  },

  changePassword: (currentPassword: string, newPassword: string): Promise<void> =>
    request<void>('POST', '/api/admin/account/password', { currentPassword, newPassword }),

  loginWithCode: async (ticket: string, code: string): Promise<string> =>
    storeToken(await loginStep<{ token: string }>('/api/admin/auth/2fa', { ticket, code })),

  secondFactorPasskeyOptions: (ticket: string): Promise<PasskeyChallenge<PublicKeyCredentialRequestOptionsJSON>> =>
    loginStep('/api/admin/auth/2fa/passkey/options', { ticket }),

  loginWithSecondFactorPasskey: async (ticket: string, challengeToken: string, response: AuthenticationResponseJSON): Promise<string> =>
    storeToken(await loginStep<{ token: string }>('/api/admin/auth/2fa/passkey', { ticket, challengeToken, response })),

  passkeyLoginOptions: (): Promise<PasskeyChallenge<PublicKeyCredentialRequestOptionsJSON>> =>
    loginStep('/api/admin/auth/passkey/options', {}),

  loginWithPasskey: async (challengeToken: string, response: AuthenticationResponseJSON): Promise<string> =>
    storeToken(await loginStep<{ token: string }>('/api/admin/auth/passkey', { challengeToken, response })),

  securityStatus: (): Promise<AdminSecurityStatus> =>
    request<AdminSecurityStatus>('GET', '/api/admin/account/security'),

  startTotpSetup: (): Promise<TotpSetup> =>
    request<TotpSetup>('POST', '/api/admin/account/totp/setup'),

  enableTotp: (code: string): Promise<{ recoveryCodes: string[] }> =>
    request('POST', '/api/admin/account/totp/enable', { code }),

  disableTotp: (code: string): Promise<void> =>
    request<void>('POST', '/api/admin/account/totp/disable', { code }),

  renewRecoveryCodes: (code: string): Promise<{ recoveryCodes: string[] }> =>
    request('POST', '/api/admin/account/recovery-codes', { code }),

  passkeyRegistrationOptions: (password: string): Promise<PasskeyChallenge<PublicKeyCredentialCreationOptionsJSON>> =>
    request('POST', '/api/admin/account/passkeys/options', { password }),

  addPasskey: (challengeToken: string, response: RegistrationResponseJSON, name: string): Promise<AdminPasskey> =>
    request<AdminPasskey>('POST', '/api/admin/account/passkeys', { challengeToken, response, name }),

  renamePasskey: (id: string, name: string): Promise<void> =>
    request<void>('PATCH', `/api/admin/account/passkeys/${encodeURIComponent(id)}`, { name }),

  deletePasskey: (id: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/account/passkeys/${encodeURIComponent(id)}`),

  logout: (): void => {
    clearToken();
  },

  stats: (): Promise<AdminStats> =>
    request<AdminStats>('GET', '/api/admin/stats'),

  users: (search?: string, page = 1, limit = 20, role?: AccountRole | 'admin', schoolId?: string): Promise<UsersResponse> => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (role) params.set('role', role);
    if (schoolId) params.set('schoolId', schoolId);
    params.set('page', String(page));
    params.set('limit', String(limit));
    return request<UsersResponse>('GET', `/api/admin/users?${params.toString()}`);
  },

  userDetail: (stableUid: string): Promise<AdminUserDetail> =>
    request<AdminUserDetail>('GET', `/api/admin/users/${stableUid}`),

  // isAdmin without a password (a WebUntis account) needs adminPassword, the one-time password.
  createUser: (data: { username: string; password?: string; webuntisKlasseId?: number; webuntisKlasseName?: string; role?: AccountRole; isAdmin?: boolean; adminPassword?: string; schoolId?: string; grant?: GrantInput }): Promise<import('./types').AdminUser> =>
    request<import('./types').AdminUser>('POST', '/api/admin/users', data),

  setUserRole: (stableUid: string, role: AccountRole): Promise<{ stableUid: string; role: string }> =>
    request<{ stableUid: string; role: string }>('PATCH', `/api/admin/users/${stableUid}/role`, { role }),

  // Full DB backup: requires the Bearer token, so we fetch as a blob and trigger
  // a client-side download (a plain <a href> can't send the Authorization header).
  exportDatabase: async (): Promise<void> => {
    const token = getToken();
    const res = await fetch('/api/admin/export', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Export fehlgeschlagen (HTTP ${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pokyh-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  importDatabase: (payload: unknown): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('POST', '/api/admin/import', payload),

  deleteUser: (stableUid: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/users/${stableUid}`),

  setUserPassword: (stableUid: string, password: string): Promise<void> =>
    request<void>('PATCH', `/api/admin/users/${stableUid}/password`, { password }),

  createTodo: (stableUid: string, data: { title: string; details?: string; dueAt?: string | null }): Promise<AdminTodo> =>
    request<AdminTodo>('POST', `/api/admin/users/${stableUid}/todos`, data),

  updateTodo: (stableUid: string, todoId: string, data: Partial<{ title: string; details: string; done: boolean; dueAt: string | null }>): Promise<AdminTodo> =>
    request<AdminTodo>('PATCH', `/api/admin/users/${stableUid}/todos/${todoId}`, data),

  deleteTodo: (stableUid: string, todoId: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/users/${stableUid}/todos/${todoId}`),

  removeFromClass: (stableUid: string, classId: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/users/${stableUid}/classes/${classId}`),

  // A WebUntis account needs `password`: its one-time password for the panel.
  grantAdmin: (stableUid: string, password?: string, grant?: GrantInput): Promise<{ ok: boolean; adminSetupExpiresAt: string | null; canViewOneTimePassword: boolean; serverTime: string }> =>
    request('POST', `/api/admin/users/${stableUid}/grant-admin`, { ...(password ? { password } : {}), ...(grant ? { grant } : {}) }),

  // The pending grant's one-time password again — only for the admin who granted it.
  oneTimePassword: (stableUid: string): Promise<{ password: string; adminSetupExpiresAt: string; serverTime: string }> =>
    request('GET', `/api/admin/users/${stableUid}/one-time-password`),

  revokeAdmin: (stableUid: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/users/${stableUid}/revoke-admin`),

  // ── Access, schools, menus ────────────────────────────────────────────────
  me: (): Promise<AdminMe> => request<AdminMe>('GET', '/api/admin/me'),

  accessCatalog: (): Promise<AccessCatalog> => request<AccessCatalog>('GET', '/api/admin/access/catalog'),

  schools: (): Promise<{ schools: AdminSchool[] }> => request('GET', '/api/admin/schools'),

  school: (id: string): Promise<{ school: AdminSchool }> => request('GET', `/api/admin/schools/${encodeURIComponent(id)}`),

  // Schools are never created here: each joins on its first WebUntis sign-in.
  updateSchool: (id: string, data: Partial<{ name: string; shortName: string; slug: string; active: boolean }>): Promise<{ school: AdminSchool }> =>
    request('PATCH', `/api/admin/schools/${encodeURIComponent(id)}`, data),

  assignMenu: (schoolId: string, menuId: string | null): Promise<{ schoolId: string; menuId: string | null }> =>
    request('PUT', `/api/admin/schools/${encodeURIComponent(schoolId)}/menu`, { menuId }),

  menus: (): Promise<{ menus: MensaMenu[] }> => request('GET', '/api/admin/menus'),

  createMenu: (name: string): Promise<{ menu: MensaMenu }> => request('POST', '/api/admin/menus', { name }),

  renameMenu: (id: string, name: string): Promise<{ menu: { id: string; name: string } }> =>
    request('PATCH', `/api/admin/menus/${encodeURIComponent(id)}`, { name }),

  deleteMenu: (id: string): Promise<void> => request<void>('DELETE', `/api/admin/menus/${encodeURIComponent(id)}`),

  // The schools a menu serves, set in one step (others it served show none).
  setMenuSchools: (id: string, schoolIds: string[]): Promise<{ menuId: string; schoolIds: string[]; added: string[]; removed: string[]; moved: string[] }> =>
    request('PUT', `/api/admin/menus/${encodeURIComponent(id)}/schools`, { schoolIds }),

  admins: (): Promise<{ admins: AdminAccount[] }> => request('GET', '/api/admin/admins'),

  setGrant: (username: string, scope: string, permissions: string[], preset?: string): Promise<{ grant: AdminGrantView | null }> =>
    request('PUT', `/api/admin/admins/${encodeURIComponent(username)}/grants/${encodeURIComponent(scope)}`, { permissions, preset }),

  // Whether an admin needs a second factor; null: back to ADMIN_REQUIRE_SECOND_FACTOR.
  setSecondFactorRequired: (username: string, required: boolean | null): Promise<{ required: boolean; source: 'account' | 'default'; setupPending: boolean }> =>
    request('PUT', `/api/admin/admins/${encodeURIComponent(username)}/second-factor`, { required }),

  removeGrant: (username: string, scope: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/admins/${encodeURIComponent(username)}/grants/${encodeURIComponent(scope)}`),

  auditEvents: (params: { page?: number; limit?: number; actor?: string; action?: string; from?: string; to?: string } = {}): Promise<AuditEventsResponse> => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
    return request('GET', `/api/admin/audit-events?${p.toString()}`);
  },

  // ── Requests, monitoring, logs ────────────────────────────────────────────
  requestsSummary: (day?: string, scope: RequestScopeChoice = 'app'): Promise<RequestsSummary> =>
    request('GET', `/api/admin/requests/summary?scope=${scope}${day ? `&day=${day}` : ''}`),

  performance: (hours = 24): Promise<PerformanceReport> => request('GET', `/api/admin/monitoring/performance?hours=${hours}`),

  health: (): Promise<SystemHealth> => request('GET', '/api/admin/monitoring/health'),

  systemLogs: (params: { level?: string; days?: number; search?: string; requestId?: string; page?: number; limit?: number } = {}): Promise<SystemLogsResponse> => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
    return request('GET', `/api/admin/system-logs?${p.toString()}`);
  },

  clientErrors: (params: { source?: string; level?: string; days?: number; search?: string } = {}): Promise<{ groups: ClientErrorGroup[]; days: number; retentionDays: number }> => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
    return request('GET', `/api/admin/client-errors?${p.toString()}`);
  },

  clientErrorOccurrences: (fingerprint: string, days = 30): Promise<{ occurrences: ClientErrorOccurrence[] }> =>
    request('GET', `/api/admin/client-errors?fingerprint=${fingerprint}&days=${days}`),

  // The panel reports its own errors; never throws, and only while signed
  // in (a report must never end a session or redirect).
  reportPanelError: (report: { message: string; name?: string; stack?: string; page?: string; release?: string }): void => {
    if (!getToken()) return;
    void request<void>('POST', '/api/admin/client-errors', report).catch(() => undefined);
  },

  privacyOverview: (): Promise<PrivacyOverview> => request('GET', '/api/admin/privacy/overview'),

  // Everything the admin may see, across all their schools (whatever the view).
  search: (q: string, kinds: SearchKind[] | null, signal?: AbortSignal): Promise<SearchResponse> => {
    const p = new URLSearchParams({ q });
    if (kinds && kinds.length > 0) p.set('types', kinds.join(','));
    return request('GET', `/api/admin/search?${p.toString()}`, undefined, signal);
  },

  // ── Comments grouped by dish ──────────────────────────────────────────────
  dishCommentGroups: (params: { page?: number; limit?: number; search?: string; sort?: 'latest' | 'comments' | 'rating' | 'name' } = {}): Promise<DishCommentGroupsResponse> => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
    return request('GET', `/api/admin/comments/dishes?${p.toString()}`);
  },

  dishComments: (dishId: string, sort: 'newest' | 'oldest' | 'rating-low' | 'rating-high' = 'newest'): Promise<DishCommentsResponse> =>
    request('GET', `/api/admin/comments/dishes/${encodeURIComponent(dishId)}?sort=${sort}&limit=200`),

  reminderCommentGroups: (params: { page?: number; limit?: number; search?: string } = {}): Promise<{ reminders: ReminderCommentGroup[]; total: number; page: number; limit: number }> => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
    return request('GET', `/api/admin/comments/reminders?${p.toString()}`);
  },

  reminderComments: (reminderId: string): Promise<{ reminder: { reminderId: string; title: string; classId: string }; comments: ReminderCommentItem[] }> =>
    request('GET', `/api/admin/comments/reminders/${encodeURIComponent(reminderId)}`),

  classes: (): Promise<AdminClass[]> =>
    request<AdminClass[]>('GET', '/api/admin/classes'),

  sessions: (): Promise<AdminSession[]> =>
    request<AdminSession[]>('GET', '/api/admin/sessions'),

  revokeSession: (id: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/sessions/${id}`),

  revokeAllSessions: (): Promise<void> =>
    request<void>('DELETE', '/api/admin/sessions'),

  deleteInactiveSessions: (): Promise<void> =>
    request<void>('DELETE', '/api/admin/sessions/inactive'),

  logs: (params?: {
    page?: number;
    limit?: number;
    method?: string;
    status?: number;
    path?: string;
    username?: string;
    from?: string;
    to?: string;
    scope?: 'learn' | 'core' | 'admin';
  }): Promise<LogsResponse> => {
    const p = new URLSearchParams();
    if (params?.page) p.set('page', String(params.page));
    if (params?.limit) p.set('limit', String(params.limit));
    if (params?.method) p.set('method', params.method);
    if (params?.status) p.set('status', String(params.status));
    if (params?.path) p.set('path', params.path);
    if (params?.username) p.set('username', params.username);
    if (params?.from) p.set('from', params.from);
    if (params?.to) p.set('to', params.to);
    if (params?.scope) p.set('scope', params.scope);
    return request<LogsResponse>('GET', `/api/admin/logs?${p.toString()}`);
  },

  userLogs: (stableUid: string, page = 1, limit = 50): Promise<UserLogsResponse> =>
    request<UserLogsResponse>('GET', `/api/admin/logs/users/${stableUid}?page=${page}&limit=${limit}`),

  requestsChart: (): Promise<RequestsChartPoint[]> =>
    request<RequestsChartPoint[]>('GET', '/api/admin/stats/requests-chart'),

  topEndpoints: (): Promise<TopEndpoint[]> =>
    request<TopEndpoint[]>('GET', '/api/admin/stats/top-endpoints'),

  createClass: (data: { name: string; code: string; webuntisKlasseId?: number }): Promise<AdminClass> =>
    request<AdminClass>('POST', '/api/admin/classes', data),

  deleteClass: (id: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/classes/${id}`),

  classReminders: (classId: string): Promise<AdminReminder[]> =>
    request<AdminReminder[]>('GET', `/api/admin/classes/${classId}/reminders`),

  createReminder: (classId: string, data: { title: string; body?: string; remindAt: string }): Promise<AdminReminder> =>
    request<AdminReminder>('POST', `/api/admin/classes/${classId}/reminders`, data),

  updateReminder: (id: string, data: Partial<{ title: string; body: string; remindAt: string }>): Promise<AdminReminder> =>
    request<AdminReminder>('PATCH', `/api/admin/reminders/${id}`, data),

  deleteReminder: (id: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/reminders/${id}`),

  addToClass: (classId: string, username: string): Promise<{ stableUid: string; username: string; joinedAt: string }> =>
    request('POST', `/api/admin/classes/${classId}/members`, { username }),

  classTodos: (classId: string): Promise<AdminClassTodo[]> =>
    request<AdminClassTodo[]>('GET', `/api/admin/classes/${classId}/todos`),

  dishRatings: (): Promise<AdminDish[]> =>
    request<AdminDish[]>('GET', '/api/admin/dish-ratings'),

  updateDishRating: (dishId: string, stableUid: string, stars: number): Promise<void> =>
    request<void>('PATCH', `/api/admin/dish-ratings/${encodeURIComponent(dishId)}/${stableUid}`, { stars }),

  deleteDishRating: (dishId: string, stableUid: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/dish-ratings/${encodeURIComponent(dishId)}/${stableUid}`),

  dishes: (plan?: DishPlan): Promise<AdminDishFull[]> => {
    const q = plan ? `?plan=${plan}` : '';
    return request<AdminDishFull[]>('GET', `/api/admin/dishes${q}`);
  },

  createDish: (data: Omit<AdminDishFull, 'id' | 'createdAt' | 'updatedAt'>): Promise<AdminDishFull> =>
    request<AdminDishFull>('POST', '/api/admin/dishes', data),

  updateDish: (id: string, data: Partial<Omit<AdminDishFull, 'id' | 'createdAt' | 'updatedAt'>>): Promise<AdminDishFull> =>
    request<AdminDishFull>('PATCH', `/api/admin/dishes/${id}`, data),

  deleteDish: (id: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/dishes/${id}`),

  importDishesFromUrl: (plan: DishPlan, url?: string): Promise<AdminDishImportResult> =>
    request<AdminDishImportResult>('POST', '/api/admin/dishes/import-url', url ? { url, plan } : { plan }),

  cascadeShiftDishes: (plan: DishPlan, fromWeek: string, offsetDays: number): Promise<AdminDishShiftResult> =>
    request<AdminDishShiftResult>('POST', '/api/admin/dishes/cascade-shift', { plan, fromWeek, offsetDays }),

  autoRotateDishes: (plan: DishPlan): Promise<AdminDishRotateResult> =>
    request<AdminDishRotateResult>('POST', '/api/admin/dishes/auto-rotate', { plan }),

  resetDishesFromUrl: (plan: DishPlan, url?: string): Promise<AdminDishResetResult> =>
    request<AdminDishResetResult>('POST', '/api/admin/dishes/reset', url ? { plan, url } : { plan }),

  anchorWeek: (plan: DishPlan, chosenWeek: string, targetMonday: string): Promise<AdminDishAnchorResult> =>
    request<AdminDishAnchorResult>('POST', '/api/admin/dishes/anchor-week', { plan, chosenWeek, targetMonday }),

  listSubjectImages: (): Promise<import('./types').AdminSubjectImage[]> =>
    request<import('./types').AdminSubjectImage[]>('GET', '/api/admin/subject-images'),

  uploadSubjectImage: (subject: string, data: string, mimeType: string, crop?: { left: number; top: number; width: number; height: number }): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('PUT', `/api/admin/subject-images/${encodeURIComponent(subject)}`, { data, mimeType, ...(crop ? { crop } : {}) }),

  deleteSubjectImage: (subject: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/subject-images/${encodeURIComponent(subject)}`),

  comments: (params?: { page?: number; limit?: number; type?: 'all' | 'reminder' | 'dish'; search?: string; sortBy?: 'createdAt' | 'username' | 'body'; sortOrder?: 'asc' | 'desc' }): Promise<AdminCommentsResponse> => {
    const p = new URLSearchParams();
    if (params?.page) p.set('page', String(params.page));
    if (params?.limit) p.set('limit', String(params.limit));
    if (params?.type) p.set('type', params.type);
    if (params?.search) p.set('search', params.search);
    if (params?.sortBy) p.set('sortBy', params.sortBy);
    if (params?.sortOrder) p.set('sortOrder', params.sortOrder);
    return request<AdminCommentsResponse>('GET', `/api/admin/comments?${p.toString()}`);
  },

  fileLogList: (): Promise<FileLogFile[]> =>
    request<FileLogFile[]>('GET', '/api/admin/file-logs'),

  fileLogEntries: (date: string, page = 1, limit = 100): Promise<FileLogResponse> =>
    request<FileLogResponse>('GET', `/api/admin/file-logs/${date}?page=${page}&limit=${limit}`),

  auditLog: (limit = 100): Promise<{ entries: FileLogEntry[]; total: number }> =>
    request<{ entries: FileLogEntry[]; total: number }>('GET', `/api/admin/audit-log?limit=${limit}`),

  deleteReminderComment: (id: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/comments/reminder/${id}`),

  deleteDishComment: (id: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/comments/dish/${id}`),

  activityLogs: (params?: {
    page?: number;
    limit?: number;
    event?: string;
    username?: string;
    from?: string;
    to?: string;
  }): Promise<FrontendActivityLogsResponse> => {
    const p = new URLSearchParams();
    if (params?.page)     p.set('page',     String(params.page));
    if (params?.limit)    p.set('limit',    String(params.limit));
    if (params?.event)    p.set('event',    params.event);
    if (params?.username) p.set('username', params.username);
    if (params?.from)     p.set('from',     params.from);
    if (params?.to)       p.set('to',       params.to);
    return request<FrontendActivityLogsResponse>('GET', `/api/admin/activity-logs?${p.toString()}`);
  },

  activityStats: (): Promise<FrontendActivityStats> =>
    request<FrontendActivityStats>('GET', '/api/admin/activity-logs/stats'),

  allTodos: (params?: { page?: number; limit?: number; search?: string; status?: 'all' | 'active' | 'done' | 'archived'; stableUid?: string }): Promise<AllTodosResponse> => {
    const p = new URLSearchParams();
    if (params?.page)     p.set('page',      String(params.page));
    if (params?.limit)    p.set('limit',     String(params.limit));
    if (params?.search)   p.set('search',    params.search);
    if (params?.status)   p.set('status',    params.status);
    if (params?.stableUid) p.set('stableUid', params.stableUid);
    return request<AllTodosResponse>('GET', `/api/admin/todos?${p.toString()}`);
  },

  allReminders: (params?: { page?: number; limit?: number; search?: string; status?: 'all' | 'active' | 'archived'; classId?: string }): Promise<AllRemindersResponse> => {
    const p = new URLSearchParams();
    if (params?.page)    p.set('page',    String(params.page));
    if (params?.limit)   p.set('limit',   String(params.limit));
    if (params?.search)  p.set('search',  params.search);
    if (params?.status)  p.set('status',  params.status);
    if (params?.classId) p.set('classId', params.classId);
    return request<AllRemindersResponse>('GET', `/api/admin/reminders?${p.toString()}`);
  },

  schoolYears: (): Promise<SchoolYearsResponse> =>
    request<SchoolYearsResponse>('GET', '/api/admin/school-years'),

  archivedUsers: (yearId: string, params?: { page?: number; limit?: number; search?: string; role?: string }): Promise<ArchivedUsersResponse> => {
    const p = new URLSearchParams();
    if (params?.page)   p.set('page',   String(params.page));
    if (params?.limit)  p.set('limit',  String(params.limit));
    if (params?.search) p.set('search', params.search);
    if (params?.role)   p.set('role',   params.role);
    return request<ArchivedUsersResponse>('GET', `/api/admin/school-years/${yearId}/users?${p.toString()}`);
  },

  archivedClasses: (yearId: string): Promise<ArchivedClass[]> =>
    request<ArchivedClass[]>('GET', `/api/admin/school-years/${yearId}/classes`),

  archivedTodos: (yearId: string, params?: { page?: number; limit?: number; search?: string; status?: string }): Promise<ArchivedTodosResponse> => {
    const p = new URLSearchParams();
    if (params?.page)   p.set('page',   String(params.page));
    if (params?.limit)  p.set('limit',  String(params.limit));
    if (params?.search) p.set('search', params.search);
    if (params?.status) p.set('status', params.status);
    return request<ArchivedTodosResponse>('GET', `/api/admin/school-years/${yearId}/todos?${p.toString()}`);
  },

  archivedReminders: (yearId: string, params?: { page?: number; limit?: number; search?: string; status?: string }): Promise<ArchivedRemindersResponse> => {
    const p = new URLSearchParams();
    if (params?.page)   p.set('page',   String(params.page));
    if (params?.limit)  p.set('limit',  String(params.limit));
    if (params?.search) p.set('search', params.search);
    if (params?.status) p.set('status', params.status);
    return request<ArchivedRemindersResponse>('GET', `/api/admin/school-years/${yearId}/reminders?${p.toString()}`);
  },

  rolloverSchoolYear: (note?: string): Promise<RolloverResult> =>
    request<RolloverResult>('POST', '/api/admin/school-years/rollover', { note }),

  rollbackSchoolYear: (yearId: string): Promise<RollbackResult> =>
    request<RollbackResult>('POST', `/api/admin/school-years/${yearId}/rollback`),

  // ── API keys ──────────────────────────────────────────────────────────────
  listApiKeys: (): Promise<{ apiKeys: AdminApiKey[] }> =>
    request<{ apiKeys: AdminApiKey[] }>('GET', '/api/admin/api-keys'),

  createApiKey: (data: { name: string; purpose?: string; platform?: string; scopes: string[]; expiresAt?: string }): Promise<CreatedApiKey> =>
    request<CreatedApiKey>('POST', '/api/admin/api-keys', data),

  revokeApiKey: (id: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('PATCH', `/api/admin/api-keys/${id}/revoke`),

  // ── Learn configuration ───────────────────────────────────────────────────
  getLearnConfig: (): Promise<LearnConfigValues> =>
    request<LearnConfigValues>('GET', '/api/admin/learn-config'),

  updateLearnConfig: (data: Partial<LearnConfigValues> & { webUntisAuthorizationReference?: string }): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('PATCH', '/api/admin/learn-config', data),

  // ── Learn AI vocabulary trainer ────────────────────────────────────────────────
  getLearnAiConfig: (): Promise<LearnAiConfigValues> =>
    request<LearnAiConfigValues>('GET', '/api/admin/learn-ai/config'),

  updateLearnAiConfig: (data: Partial<LearnAiConfigValues>): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('PATCH', '/api/admin/learn-ai/config', data),

  getLearnAiGrants: (): Promise<{ grants: LearnAiGrant[] }> =>
    request<{ grants: LearnAiGrant[] }>('GET', '/api/admin/learn-ai/grants'),

  grantLearnAi: (username: string, note?: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('POST', '/api/admin/learn-ai/grants', { username, note }),

  revokeLearnAi: (stableUid: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('DELETE', `/api/admin/learn-ai/grants/${stableUid}`),

  getLearnAiTeamGrants: (): Promise<{ grants: LearnAiTeamGrant[] }> =>
    request<{ grants: LearnAiTeamGrant[] }>('GET', '/api/admin/learn-ai/team-grants'),

  grantLearnAiTeam: (teamId: string, note?: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('POST', '/api/admin/learn-ai/team-grants', { teamId, note }),

  revokeLearnAiTeam: (teamId: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('DELETE', `/api/admin/learn-ai/team-grants/${teamId}`),

  // ── Learn groups and access ──────────────────────────────────────────────
  // Group administration remains in the canonical admin authority. The
  // response deliberately contains only group metadata, verified member
  // identity and aggregate course counts — never course contents or secrets.
  listLearnTeams: (): Promise<{ teams: AdminLearnTeam[] }> =>
    request<{ teams: AdminLearnTeam[] }>('GET', '/api/admin/learn/teams'),

  createLearnTeam: (data: { name: string; description?: string }): Promise<{ team: AdminLearnTeam }> =>
    request<{ team: AdminLearnTeam }>('POST', '/api/admin/learn/teams', data),

  updateLearnTeam: (teamId: string, data: { name?: string; description?: string }): Promise<{ team: AdminLearnTeam }> =>
    request<{ team: AdminLearnTeam }>('PATCH', `/api/admin/learn/teams/${teamId}`, data),

  saveLearnTeamMember: (teamId: string, data: { userId: string; role: LearnTeamAssignableRole }): Promise<{ member: { stableUid: string; username: string; role: LearnTeamAssignableRole; joinedAt: string } }> =>
    request<{ member: { stableUid: string; username: string; role: LearnTeamAssignableRole; joinedAt: string } }>('POST', `/api/admin/learn/teams/${teamId}/members`, data),

  removeLearnTeamMember: (teamId: string, stableUid: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/learn/teams/${teamId}/members/${encodeURIComponent(stableUid)}`),

  addLearnTeamOwner: (teamId: string, stableUid: string): Promise<{ ok: true }> =>
    request<{ ok: true }>('POST', `/api/admin/learn/teams/${teamId}/owner`, { stableUid }),

  seedLearnTeamVocabCourses: (teamId: string): Promise<{ created: number }> =>
    request<{ created: number }>('POST', `/api/admin/learn/teams/${teamId}/seed-vocab-courses`),

  deleteLearnTeam: (teamId: string, confirmName: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/learn/teams/${teamId}`, { confirmName }),

  // ── Learn course lifecycle and direct access ─────────────────────────────
  // Metadata/grant operations are deliberately separate from authored Learn
  // content. The browser never receives learner answers through this client.
  listLearnCourses: (params?: {
    page?: number;
    limit?: number;
    q?: string;
    status?: LearnCourseStatus;
    visibility?: LearnCourseVisibility;
    teamId?: string;
  }): Promise<AdminLearnCoursesResponse> => {
    const query = new URLSearchParams();
    if (params?.page) query.set('page', String(params.page));
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.q) query.set('q', params.q);
    if (params?.status) query.set('status', params.status);
    if (params?.visibility) query.set('visibility', params.visibility);
    if (params?.teamId) query.set('teamId', params.teamId);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return request<AdminLearnCoursesResponse>('GET', `/api/admin/learn/courses${suffix}`);
  },

  getLearnCourseAccess: (courseId: string, page = 1, limit = 50): Promise<AdminLearnCourseAccessResponse> =>
    request<AdminLearnCourseAccessResponse>('GET', `/api/admin/learn/courses/${courseId}/access?page=${page}&limit=${limit}`),

  updateLearnCourseLifecycle: (courseId: string, status: LearnCourseStatus): Promise<{ course: AdminLearnCourse }> =>
    request<{ course: AdminLearnCourse }>('PATCH', `/api/admin/learn/courses/${courseId}/lifecycle`, { status }),

  saveLearnCourseAccess: (courseId: string, data: { userId: string; permission: LearnCoursePermission }): Promise<{ access: AdminLearnCourseAccess }> =>
    request<{ access: AdminLearnCourseAccess }>('POST', `/api/admin/learn/courses/${courseId}/access`, data),

  revokeLearnCourseAccess: (courseId: string, stableUid: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/learn/courses/${courseId}/access/${encodeURIComponent(stableUid)}`),

  deleteLearnCourse: (courseId: string, confirmation: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/learn/courses/${courseId}`, { confirmation }),

  // ── Learn vocabulary list administration ─────────────────────────────────
  // A "vocabulary list" is a Learn course's vocabulary entries.
  getLearnCourseVocabulary: (courseId: string, params?: { page?: number; limit?: number; q?: string }): Promise<AdminLearnCourseVocabularyResponse> => {
    const query = new URLSearchParams();
    if (params?.page) query.set('page', String(params.page));
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.q) query.set('q', params.q);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return request<AdminLearnCourseVocabularyResponse>('GET', `/api/admin/learn/courses/${courseId}/vocabulary${suffix}`);
  },

  // Requires the Bearer token, so fetch as a blob and trigger a client-side
  // download, same pattern as exportDatabase() above.
  exportLearnCourseVocabulary: async (courseId: string, courseSlug: string): Promise<void> => {
    const token = getToken();
    const res = await fetch(`/api/admin/learn/courses/${courseId}/vocabulary/export`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Export fehlgeschlagen (HTTP ${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pokyh-learn-vocab-${courseSlug}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  importLearnCourseVocabulary: (courseId: string, payload: unknown): Promise<AdminLearnVocabularyImportResponse> =>
    request<AdminLearnVocabularyImportResponse>('POST', `/api/admin/learn/courses/${courseId}/vocabulary/import`, payload),

  // ── Database backups ──────────────────────────────────────────────────────
  getBackups: (): Promise<BackupsResponse> =>
    request<BackupsResponse>('GET', '/api/admin/backups'),

  updateBackupConfig: (data: Partial<{ enabled: boolean; scheduleHour: number; retentionDays: number }>): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('PATCH', '/api/admin/backups/config', data),

  runBackupNow: (): Promise<{ filename: string; sizeBytes: number }> =>
    request<{ filename: string; sizeBytes: number }>('POST', '/api/admin/backups/run'),

  deleteBackup: (filename: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/backups/${encodeURIComponent(filename)}`),

  restoreBackup: (filename: string, confirmation: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('POST', `/api/admin/backups/${encodeURIComponent(filename)}/restore`, { confirmation }),

  // A backup download needs the Bearer token, so fetch as a blob and trigger
  // a client-side save (a plain <a href> can't send the Authorization header)
  // — same pattern as exportDatabase().
  downloadBackup: async (filename: string): Promise<void> => {
    const token = getToken();
    const res = await fetch(`/api/admin/backups/${encodeURIComponent(filename)}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Download fehlgeschlagen (HTTP ${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  // ── Popups ────────────────────────────────────────────────────────────────
  getPopups: (): Promise<{ popups: AdminPopup[] }> =>
    request<{ popups: AdminPopup[] }>('GET', '/api/admin/popups'),

  createPopup: (data: PopupInput): Promise<{ popup: AdminPopup }> =>
    request<{ popup: AdminPopup }>('POST', '/api/admin/popups', data),

  updatePopup: (id: string, data: PopupInput): Promise<{ popup: AdminPopup }> =>
    request<{ popup: AdminPopup }>('PUT', `/api/admin/popups/${id}`, data),

  setPopupEnabled: (id: string, enabled: boolean): Promise<{ popup: AdminPopup }> =>
    request<{ popup: AdminPopup }>('PATCH', `/api/admin/popups/${id}/enabled`, { enabled }),

  deletePopup: (id: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/popups/${id}`),

  renderPopup: (content: string): Promise<{ html: string }> =>
    request<{ html: string }>('POST', '/api/admin/popups/render', { content }),

  // Who a popup can be meant for: users by name, and every known class.
  getPopupTargets: (q: string): Promise<{ users: PopupTargetUser[]; classes: PopupTargetClass[] }> =>
    request<{ users: PopupTargetUser[]; classes: PopupTargetClass[] }>('GET', `/api/admin/popups/targets?q=${encodeURIComponent(q)}`),

  // ── Cluster ───────────────────────────────────────────────────────────────
  getCluster: (): Promise<ClusterStatus> =>
    request<ClusterStatus>('GET', '/api/admin/cluster'),

  // The code is shown once and never stored in the panel.
  createClusterInvite: (ownAddress: string): Promise<{ id: string; code: string; expiresAt: string }> =>
    request<{ id: string; code: string; expiresAt: string }>('POST', '/api/admin/cluster/invites', { ownAddress }),

  joinCluster: (code: string, ownAddress: string): Promise<{ id: string }> =>
    request<{ id: string }>('POST', '/api/admin/cluster/join', { code, ownAddress }),

  updateClusterPeer: (id: string, data: { address?: string; name?: string; enabled?: boolean }): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('PATCH', `/api/admin/cluster/peers/${id}`, data),

  resyncClusterPeer: (id: string, acceptStale = false): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('POST', `/api/admin/cluster/peers/${id}/resync`, { acceptStale }),

  verifyClusterPeer: (id: string): Promise<{ repaired: number }> =>
    request<{ repaired: number }>('POST', `/api/admin/cluster/peers/${id}/verify`),

  removeClusterPeer: (id: string): Promise<{ deleted: boolean }> =>
    request<{ deleted: boolean }>('DELETE', `/api/admin/cluster/peers/${id}`),

  rebuildCluster: (): Promise<{ rows: number }> =>
    request<{ rows: number }>('POST', '/api/admin/cluster/rebuild', { confirmation: 'REBUILD' }),

  renameClusterNode: (name: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('PATCH', '/api/admin/cluster/node', { name }),

  // One-line node install: the command is returned once and never again.
  createClusterInstall: (data: {
    name: string; address?: string; withAi?: boolean; acmeEmail?: string; origin: string;
    web?: 'none' | 'domain' | 'proxy'; apiPort?: number; apiBind?: string; apiFrom?: string;
    clusterPort?: number; clusterBind?: string; clusterFrom?: string;
  }): Promise<CreatedClusterInstall> =>
    request<CreatedClusterInstall>('POST', '/api/admin/cluster/node-installs', data),

  getClusterInstalls: (): Promise<{ installs: ClusterInstall[] }> =>
    request<{ installs: ClusterInstall[] }>('GET', '/api/admin/cluster/node-installs'),

  revokeClusterInstall: (id: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('DELETE', `/api/admin/cluster/node-installs/${id}`),

  rotateClusterCertificate: (): Promise<{ pin: string; peers: number }> =>
    request<{ pin: string; peers: number }>('POST', '/api/admin/cluster/certificate/rotate'),

  // How this node is reached (several ways), relays
  getClusterReach: (): Promise<ClusterReach> =>
    request<ClusterReach>('GET', '/api/admin/cluster/reach'),

  saveClusterReach: (entries: Array<Pick<ReachEntry, 'kind' | 'endpoint' | 'enabled' | 'backend'> & { id?: string }>): Promise<ClusterReach> =>
    request<ClusterReach>('PUT', '/api/admin/cluster/reach', { entries }),

  addClusterRelay: (key: string): Promise<{ id: string; name: string }> =>
    request<{ id: string; name: string }>('POST', '/api/admin/cluster/relays', { key }),

  updateClusterRelay: (id: string, data: { enabled?: boolean; usePorts?: boolean; useSni?: boolean; name?: string }): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('PATCH', `/api/admin/cluster/relays/${id}`, data),

  removeClusterRelay: (id: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('DELETE', `/api/admin/cluster/relays/${id}`),

  createRelayCommand: (data: { origin: string; host: string; port: number; publicPort: boolean; domain: string; name: string }): Promise<{ command: string; sha256: string; expiresAt: string }> =>
    request<{ command: string; sha256: string; expiresAt: string }>('POST', '/api/admin/cluster/relay-command', data),

  // `fresh` skips the server's short response cache (the refresh button).
  analytics: (range: AnalyticsRange, fresh = false): Promise<AdminAnalytics> =>
    request<AdminAnalytics>('GET', `/api/admin/analytics?range=${range}${fresh ? '&fresh=1' : ''}`),

  analyticsPeople: (range: AnalyticsRange, filters: PeopleFilters): Promise<AnalyticsPeople> => {
    const p = new URLSearchParams({ range });
    if (filters.platform) p.set('platform', filters.platform);
    if (filters.day) p.set('day', filters.day);
    if (filters.hours?.length) p.set('hours', filters.hours.join(','));
    if (filters.weekdays?.length) p.set('weekdays', filters.weekdays.join(','));
    if (filters.klasse) p.set('klasse', filters.klasse);
    if (filters.segment) p.set('segment', filters.segment);
    if (filters.page) p.set('page', filters.page);
    if (filters.created) p.set('created', filters.created);
    if (filters.band !== undefined) p.set('band', String(filters.band));
    return request<AnalyticsPeople>('GET', `/api/admin/analytics/people?${p.toString()}`);
  },

  analyticsBreakdown: (kind: BreakdownKind, range: AnalyticsRange): Promise<AnalyticsBreakdown> =>
    request<AnalyticsBreakdown>('GET', `/api/admin/analytics/breakdown?kind=${kind}&range=${range}`),

  analyticsDishes: (): Promise<AnalyticsDishes> =>
    request<AnalyticsDishes>('GET', '/api/admin/analytics/dishes'),

  analyticsVisitors: (range: AnalyticsRange, source: VisitSource = 'all', fresh = false): Promise<AnalyticsVisitors> =>
    request<AnalyticsVisitors>('GET', `/api/admin/analytics/visitors?range=${range}&source=${source}${fresh ? '&fresh=1' : ''}`),

  analyticsPerson: (uid: string, range: AnalyticsRange): Promise<AnalyticsPersonDetail> =>
    request<AnalyticsPersonDetail>('GET', `/api/admin/analytics/person?${new URLSearchParams({ uid, range }).toString()}`),

  analyticsVisitorIp: (ip: string, range: AnalyticsRange): Promise<AnalyticsVisitorIp> =>
    request<AnalyticsVisitorIp>('GET', `/api/admin/analytics/visitors/ip?${new URLSearchParams({ ip, range }).toString()}`),

  // Updates: settings are cluster-wide, retry and roll back act on this node.
  getClusterUpdates: (): Promise<ClusterUpdates> =>
    request<ClusterUpdates>('GET', '/api/admin/cluster/updates'),

  saveClusterUpdateSettings: (data: { repo: string; branch: string; auto: boolean; requireCi: boolean }): Promise<ClusterUpdateSettings> =>
    request<ClusterUpdateSettings>('PUT', '/api/admin/cluster/updates/settings', data),

  checkClusterUpdates: (): Promise<ClusterUpdates> =>
    request<ClusterUpdates>('POST', '/api/admin/cluster/updates/check'),

  releaseClusterUpdate: (commit: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('POST', '/api/admin/cluster/updates/release', { commit }),

  retryClusterUpdate: (): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('POST', '/api/admin/cluster/updates/retry'),

  rollBackClusterNode: (): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('POST', '/api/admin/cluster/updates/rollback'),

  // What the cluster exchanges (Pokyh Learn yes/no) — the same on every node.
  setClusterScope: (learn: boolean): Promise<ClusterScope> =>
    request<ClusterScope>('PUT', '/api/admin/cluster/scope', { learn }),

  // Does this way arrive at this node? (through proxy, relay, VPN …)
  testClusterWay: (kind: ReachKind, endpoint: string): Promise<WayTestResult> =>
    request<WayTestResult>('POST', '/api/admin/cluster/reach/test', { kind, endpoint }),

  getToken,
};

export const setupApi = {
  status: (): Promise<SetupStatus> =>
    fetch('/api/setup/status').then(r => r.json() as Promise<SetupStatus>),

  setPassword: async (username: string, password: string): Promise<string> => {
    const res = await fetch('/api/setup/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const data = await res.json() as { error?: string };
      throw new Error(data.error ?? 'Failed to set password');
    }
    const data = await res.json() as { token: string };
    setToken(data.token);
    return data.token;
  },

  getToken,
};
