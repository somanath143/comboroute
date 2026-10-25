import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Loading } from './UI';
export function RequireRole({ roles, children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading text="Checking your account…"/>;
  if (!user) return <Navigate to={'/login?next=' + encodeURIComponent(location.pathname)} replace/>;
  if (roles && !roles.includes(user.role)) return <div className="content-width py-24 text-center"><h1 className="text-3xl font-black">Access restricted</h1><p className="mt-3 text-muted">This area is only available to authorized {roles.join(' or ')} accounts.</p></div>;
  return children;
}
