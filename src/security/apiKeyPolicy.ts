/**
 * Capabilities for administrator-issued integration keys. Static API_KEY
 * remains an emergency/bootstrap key with full access; issued keys should be
 * least-privilege and are checked before a request reaches a route.
 */
export const issuedApiKeyScopes = [
  'core:read',
  'core:write',
  'auth:session',
  'learn:catalog',
  'learn:read',
  'learn:write',
] as const;

export type IssuedApiKeyScope = (typeof issuedApiKeyScopes)[number];

export function parseApiKeyScopes(value: string | null | undefined): string[] {
  const requested = (value ?? '*')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  return requested.length ? requested : ['*'];
}

export function serializeApiKeyScopes(scopes: readonly string[]): string {
  return [...new Set(scopes)].sort().join(',');
}

export function requiredApiKeyScope(method: string, path: string): IssuedApiKeyScope {
  const readOnly = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  if (path.startsWith('/learn/catalog')) return 'learn:catalog';
  if (path.startsWith('/learn')) return readOnly ? 'learn:read' : 'learn:write';
  if (path.startsWith('/auth/')) return 'auth:session';
  return readOnly ? 'core:read' : 'core:write';
}

export function hasApiKeyScope(stored: string | null | undefined, required: IssuedApiKeyScope): boolean {
  const scopes = new Set(parseApiKeyScopes(stored));
  return scopes.has('*') || scopes.has(required);
}
