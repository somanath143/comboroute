import { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../lib';
const AuthContext = createContext(null);
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { let active = true; api('/auth/me').then(result => { if (active) setUser(result.user); }).catch(() => { if (active) setUser(null); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  async function login(email, password) { const result = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); setUser(result.user); return result.user; }
  async function register(name, email, password) { const result = await api('/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password }) }); setUser(result.user); return result.user; }
  async function logout() { await api('/auth/logout', { method: 'POST' }); setUser(null); }
  return <AuthContext.Provider value={{ user, loading, login, register, logout }}>{children}</AuthContext.Provider>;
}
export function useAuth() { const value = useContext(AuthContext); if (!value) throw new Error('AuthProvider missing'); return value; }
