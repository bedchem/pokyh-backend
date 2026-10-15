import { useState, useEffect, useCallback } from 'react';
import { adminApi } from '../api';
import type { LoginResult } from '../types';

const TOKEN_KEY = 'pokyh_admin_token';

interface JwtPayloadBasic {
  exp?: number;
  role?: string;
  sub?: string;
  username?: string;
}

function decodeJwt(token: string): JwtPayloadBasic | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(payload) as JwtPayloadBasic;
  } catch {
    return null;
  }
}

function isTokenValid(token: string): boolean {
  const payload = decodeJwt(token);
  if (!payload) return false;
  if (!payload.exp) return false;
  // Check expiry (exp is seconds)
  return payload.exp * 1000 > Date.now();
}

interface UseAuthReturn {
  isAuthenticated: boolean;
  token: string | null;
  username: string;
  /** Resolves with the ticket for step two when a second factor is set up. */
  login: (username: string, password: string) => Promise<LoginResult>;
  /** Takes the token a finished login step returned. */
  acceptToken: (token: string) => void;
  logout: () => void;
}

export function useAuth(): UseAuthReturn {
  const [token, setToken] = useState<string | null>(() => {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored && isTokenValid(stored)) return stored;
    if (stored) localStorage.removeItem(TOKEN_KEY);
    return null;
  });

  useEffect(() => {
    // Re-check on storage changes (other tabs)
    const handler = () => {
      const stored = localStorage.getItem(TOKEN_KEY);
      if (stored && isTokenValid(stored)) {
        setToken(stored);
      } else {
        setToken(null);
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await adminApi.login(username, password);
    if ('token' in result) setToken(result.token);
    return result;
  }, []);

  const acceptToken = useCallback((newToken: string) => {
    setToken(newToken);
  }, []);

  const logout = useCallback(() => {
    adminApi.logout();
    setToken(null);
  }, []);

  const username = token ? (decodeJwt(token)?.username ?? 'admin') : 'admin';

  return {
    isAuthenticated: token !== null,
    token,
    username,
    login,
    acceptToken,
    logout,
  };
}
