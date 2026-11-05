import { useState } from 'react';
import { api } from '../lib';
import { useLoad } from '../hooks/useLoad';
export function Notifications() {
  const { data, error, reload } = useLoad(() => api('/notifications?limit=10'), []);
  const [message, setMessage] = useState('');
  async function markRead(id) { try { await api(`/notifications/${id}/read`, { method: 'POST' }); reload(); } catch(e) { setMessage(e.message); } }
  return <section className="panel p-6 mt-6"><div className="flex justify-between gap-3"><h2 className="font-bold text-xl">Order notifications</h2><button className="btn-secondary" onClick={reload}>Refresh notifications</button></div>
    {(error || message) && <p role="alert">{error || message}</p>}
    {!data?.items?.length && <p className="text-sm text-muted mt-4">No order updates yet.</p>}
    {data?.items?.map(n => <div data-testid="order-notification" className="border-t pt-3 mt-3 flex justify-between gap-4 text-sm" key={n._id}><div><p>{n.message}</p><p className="text-xs text-muted">{new Date(n.createdAt).toLocaleString()}</p></div>{!n.read_at && <button className="btn-secondary" onClick={() => markRead(n._id)}>Mark read</button>}</div>)}
  </section>;
}
