import { useState } from 'react';
import { api } from '../lib';
import { useLoad } from '../hooks/useLoad';

export function BackendPanel() {
  const [jobState, setJobState] = useState('');
  const { data: stats, error, reload } = useLoad(() => api('/admin/backend'), []);
  const { data: jobs, reload: reloadJobs } = useLoad(() => api('/admin/jobs?limit=20' + (jobState ? '&state=' + jobState : '')), [jobState]);
  const { data: audit, reload: reloadAudit } = useLoad(() => api('/admin/audit?limit=20'), []);
  const { data: stock, reload: reloadStock } = useLoad(() => api('/inventory'), []);
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  async function action(path, body, method = 'POST') {
    setBusy(true); setMessage('');
    try { await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }); setMessage('Update accepted. Background work may take a few seconds.'); reload(); reloadJobs(); reloadAudit(); reloadStock(); }
    catch (e) { setMessage(e.message); } finally { setBusy(false); }
  }
  return <section className="panel p-6 mt-7"><div className="flex justify-between gap-4"><h2 className="text-xl font-bold">Backend operations</h2><button className="btn-secondary" onClick={() => { reload(); reloadJobs(); reloadAudit(); reloadStock(); }}>Refresh operations</button></div>
    {(error || message) && <p role="alert" className="bg-amber-50 p-3 mt-3">{error || message}</p>}
    <p className="text-sm mt-4">Active workers: {stats?.active_workers ?? '…'} · Available portions: {stats?.inventory ?? '…'}</p>
    <div className="flex flex-wrap gap-3 mt-3">{stats?.jobs?.map(j => <span className="bg-light p-2 rounded-lg text-sm" key={j._id}>{j._id}: {j.count}</span>)}</div>
    <h3 className="font-bold mt-6">Background jobs</h3><p className="text-xs text-muted">Failed jobs remain inspectable. Retry an exhausted job after resolving its cause.</p><select className="field max-w-48 mt-3" aria-label="Job state" value={jobState} onChange={e => setJobState(e.target.value)}><option value="">All jobs</option>{['dead','waiting','running','completed'].map(state => <option key={state} value={state}>{state}</option>)}</select>
    <div className="overflow-auto mt-3"><table className="w-full text-sm text-left"><thead><tr><th>Type</th><th>State</th><th>Attempts</th><th>Result</th><th/></tr></thead><tbody>{jobs?.items?.map(j => <tr className="border-t" key={j.id}><td className="py-2">{j.type}</td><td>{j.state}</td><td>{j.attempts}/{j.max_attempts}</td><td>{j.last_error ?? '—'}</td><td>{j.state === 'dead' && <button disabled={busy} className="btn-secondary" onClick={() => action(`/admin/jobs/${j.id}/retry`)}>Retry job</button>}</td></tr>)}</tbody></table></div>
    <h3 className="font-bold mt-6">Inventory</h3><p className="text-xs text-muted">These are unreserved, sellable portions. Existing reservations are tracked separately.</p>
    <div className="max-h-80 overflow-auto mt-3">{stock?.map(item => <form key={`${item.id}:${item.stock_available}`} className="flex gap-3 items-center border-t py-2" onSubmit={e => { e.preventDefault(); action(`/menu/${item.id}`, { stock_available: Number(new FormData(e.currentTarget).get('stock')) }, 'PATCH'); }}><span className="flex-1 text-sm">{item.name}</span><input className="field max-w-24" aria-label={`Available portions for ${item.name}`} type="number" min="0" max="100000" name="stock" required defaultValue={item.stock_available}/><button disabled={busy} className="btn-secondary">Save stock</button></form>)}</div>
    <h3 className="font-bold mt-6">Audit history</h3><div className="mt-3 max-h-64 overflow-auto text-xs">{audit?.items?.map(a => <div key={a.id} className="border-t py-2"><strong>{a.action}</strong> · {a.actor_role} · {new Date(a.createdAt).toLocaleString()}<p className="text-muted">Resource {a.resource_id} · Request {a.request_id ?? 'background'}</p></div>)}</div>
    <p className="text-xs text-muted mt-4">Authenticated admin endpoints: <a className="underline" href="/api/metrics" target="_blank" rel="noreferrer">Prometheus metrics</a> · <a className="underline" href="/api/openapi.json" target="_blank" rel="noreferrer">API contract</a></p>
  </section>;
}
