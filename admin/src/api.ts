import type { AdminStats, AdminClass, AdminSession, UsersResponse, LogsResponse, UserLogsResponse, SetupStatus, RequestsChartPoint, TopEndpoint, AdminUserDetail, AdminTodo, AdminReminder, AdminClassTodo } from './types';

const TOKEN_KEY = 'pokyh_admin_token';

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (import.meta.env.DEV) {
    console.log(`[adminApi] ${method} ${path}`, body ?? '');
  }

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    clearToken();
    window.location.hash = '#/login';
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
    throw new Error(message);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

export const adminApi = {
  login: async (username: string, password: string): Promise<string> => {
    // Use raw fetch — the generic request() handler treats 401 as "session expired"
    // which is wrong for the login form (should show "Invalid credentials" instead).
    const res = await fetch('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    const data = await res.json() as { token: string };
    setToken(data.token);
    return data.token;
  },

  logout: (): void => {
    clearToken();
  },

  stats: (): Promise<AdminStats> =>
    request<AdminStats>('GET', '/api/admin/stats'),

  users: (search?: string, page = 1, limit = 20): Promise<UsersResponse> => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    params.set('page', String(page));
    params.set('limit', String(limit));
    return request<UsersResponse>('GET', `/api/admin/users?${params.toString()}`);
  },

  userDetail: (stableUid: string): Promise<AdminUserDetail> =>
    request<AdminUserDetail>('GET', `/api/admin/users/${stableUid}`),

  createUser: (data: { username: string; webuntisKlasseId?: number; webuntisKlasseName?: string }): Promise<import('./types').AdminUser> =>
    request<import('./types').AdminUser>('POST', '/api/admin/users', data),

  deleteUser: (stableUid: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/users/${stableUid}`),

  createTodo: (stableUid: string, data: { title: string; details?: string; dueAt?: string | null }): Promise<AdminTodo> =>
    request<AdminTodo>('POST', `/api/admin/users/${stableUid}/todos`, data),

  updateTodo: (stableUid: string, todoId: string, data: Partial<{ title: string; details: string; done: boolean; dueAt: string | null }>): Promise<AdminTodo> =>
    request<AdminTodo>('PATCH', `/api/admin/users/${stableUid}/todos/${todoId}`, data),

  deleteTodo: (stableUid: string, todoId: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/users/${stableUid}/todos/${todoId}`),

  removeFromClass: (stableUid: string, classId: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/users/${stableUid}/classes/${classId}`),

  grantAdmin: (stableUid: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('POST', `/api/admin/users/${stableUid}/grant-admin`),

  revokeAdmin: (stableUid: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/users/${stableUid}/revoke-admin`),

  classes: (): Promise<AdminClass[]> =>
    request<AdminClass[]>('GET', '/api/admin/classes'),

  sessions: (): Promise<AdminSession[]> =>
    request<AdminSession[]>('GET', '/api/admin/sessions'),

  revokeSession: (id: string): Promise<void> =>
    request<void>('DELETE', `/api/admin/sessions/${id}`),

  logs: (params?: {
    page?: number;
    limit?: number;
    method?: string;
    status?: number;
    path?: string;
    username?: string;
  }): Promise<LogsResponse> => {
    const p = new URLSearchParams();
    if (params?.page) p.set('page', String(params.page));
    if (params?.limit) p.set('limit', String(params.limit));
    if (params?.method) p.set('method', params.method);
    if (params?.status) p.set('status', String(params.status));
    if (params?.path) p.set('path', params.path);
    if (params?.username) p.set('username', params.username);
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

  addToClass: (classId: string, username: string): Promise<{ stableUid: string; username: string; joinedAt: string }> =>
    request('POST', `/api/admin/classes/${classId}/members`, { username }),

  classTodos: (classId: string): Promise<AdminClassTodo[]> =>
    request<AdminClassTodo[]>('GET', `/api/admin/classes/${classId}/todos`),

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

  // Returns an EventSource for streaming cloudflare login output
  loginStream: (token: string): EventSource =>
    new EventSource(`/api/setup/cloudflare/login-stream?token=${encodeURIComponent(token)}`),

  // Returns an EventSource for streaming tunnel creation output
  tunnelStream: (token: string, hostname: string): EventSource =>
    new EventSource(`/api/setup/cloudflare/tunnel-stream?token=${encodeURIComponent(token)}&hostname=${encodeURIComponent(hostname)}`),

  getToken,
};
