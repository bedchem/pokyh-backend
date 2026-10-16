// The route a logged request path belongs to, for per-endpoint figures:
// "/classes/5f3a…/reminders/9b2c…" and every other class's reminders are one
// endpoint, "/classes/:id/reminders/:id". Request logs keep the real path;
// this only groups them.

// Segments after these are a record's id or key — except the listed fixed
// sub-routes ("/users/me", "/dish-ratings/batch" …).
const PARAM_AFTER = new Map<string, ReadonlySet<string>>(Object.entries({
  users: new Set(['me', 'search']),
  classes: new Set(['mine', 'join']),
  reminders: new Set(),
  comments: new Set(['reminder', 'dish']),
  todos: new Set(),
  'dish-ratings': new Set(['batch']),
  'dish-comments': new Set(),
  'reminder-comments': new Set(),
  'subject-images': new Set(),
  dishes: new Set(['import-url', 'reset', 'cascade-shift', 'anchor-week', 'auto-rotate']),
  popups: new Set(['active', 'targets', 'render']),
  sessions: new Set(['inactive']),
  courses: new Set(),
  sections: new Set(),
  teams: new Set(),
  vocabulary: new Set(['import', 'export']),
  'school-years': new Set(['rollover']),
  'api-keys': new Set(),
  backups: new Set(['config', 'run', 'prune']),
  schools: new Set(),
  menus: new Set(),
  admins: new Set(),
  grants: new Set(),
  'file-logs': new Set(),
} satisfies Record<string, ReadonlySet<string>>));

const ID_LIKE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\d+|(?=.*\d)[\w.~-]{8,})$/i;

export function endpointOf(path: string): string {
  const clean = (path.split('?')[0] ?? '').replace(/\/+$/, '') || '/';
  const parts = clean.split('/');
  for (let i = 1; i < parts.length; i++) {
    const segment = parts[i]!;
    if (segment === '') continue;
    const parent = parts[i - 1] ?? '';
    const fixed = PARAM_AFTER.get(parent);
    if (ID_LIKE.test(segment) || (fixed && !fixed.has(segment) && !PARAM_AFTER.has(segment))) {
      parts[i] = ':id';
    }
  }
  return parts.join('/').slice(0, 200) || '/';
}
