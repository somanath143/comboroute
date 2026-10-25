import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, ChefHat, Clock3, RefreshCw, Save, Store, Utensils } from 'lucide-react';
import { api, getRestaurant } from '../lib';
import { useLoad } from '../hooks/useLoad';
import { Loading, ErrorView } from '../components/UI';
export function ConsolePage() {
    const { data: restaurants, loading, error, reload } = useLoad(() => api('/restaurant/mine'), []);
    const [selected, setSelected] = useState(1), [items, setItems] = useState([]), [orders, setOrders] = useState([]), [busy, setBusy] = useState(false), [actionError, setActionError] = useState(''), [ready, setReady] = useState(false), [prices, setPrices] = useState({});
    const current = restaurants?.find(r => r.id === selected);
    useEffect(() => { if (restaurants?.length && !restaurants.some(r => r.id === selected)) { setSelected(restaurants[0].id); } }, [restaurants, selected]);
    async function refresh(id = selected) { setActionError(''); setBusy(true); try {
        const [d, orders] = await Promise.all([getRestaurant(id), api('/restaurant/orders?restaurant_id=' + id)]);
        setItems(d.menu);
        setPrices(Object.fromEntries(d.menu.map(i => [i.id, (i.price_paise / 100).toString()])));
        setOrders(orders);
        setReady(true);
    }
    catch (e) {
        setActionError(e.message);
    }
    finally {
        setBusy(false);
    } }
    useEffect(() => { if (restaurants?.some(r => r.id === selected)) refresh(selected); }, [selected, restaurants?.length]);
    async function pick(id) { setSelected(id); await refresh(id); }
    async function patchRestaurant(data) { try {
        setBusy(true);
        await api(`/restaurants/${selected}`, { method: 'PATCH', body: JSON.stringify(data) });
        reload();
        await refresh(selected);
    }
    catch (e) {
        setActionError(e.message);
    }
    finally {
        setBusy(false);
    } }
    async function patchItem(item) { try {
        await api(`/menu/${item.id}`, { method: 'PATCH', body: JSON.stringify({ is_available: !item.is_available }) });
        await refresh();
    }
    catch (e) {
        setActionError(e.message);
    } }
    async function changePrice(item) { const amount = Number(prices[item.id]); if (!Number.isFinite(amount) || amount < 1 || amount > 2000) {
        setActionError('Price must be between ₹1 and ₹2,000.');
        return;
    } try {
        setBusy(true);
        await api(`/menu/${item.id}`, { method: 'PATCH', body: JSON.stringify({ price_paise: Math.round(amount * 100) }) });
        await refresh();
    }
    catch (e) {
        setActionError(e.message);
    }
    finally {
        setBusy(false);
    } }
    async function actionLeg(id, status) { try {
        setBusy(true);
        await api(`/restaurant/orders/${id}/${selected}`, { method: 'PATCH', body: JSON.stringify({ status }) });
        await refresh();
    }
    catch (e) {
        setActionError(e.message);
    }
    finally {
        setBusy(false);
    } }
    if (loading)
        return <Loading />;
    if (error)
        return <div className="content-width mt-8"><ErrorView message={error} onRetry={reload}/></div>;
    return <div className="content-width"><div className="page-heading"><div><p className="eyebrow">BACK OF HOUSE · SIMULATED</p><h1 className="font-outfit text-4xl font-black mt-2">Restaurant operations</h1><p className="text-sm text-muted mt-2">Restaurant availability, menu controls and mock fulfilment. Fictional businesses only.</p></div><button onClick={() => refresh()} className="btn-secondary"><RefreshCw size={17}/> Refresh data</button></div>
 <div className="bg-[#FFF6EA] border border-[#FFEDCE] p-4 rounded-xl flex items-center gap-3 text-sm mt-7"><AlertTriangle size={19} className="text-amber-800 shrink-0"/><p>Role-protected restaurant operations. You can edit only kitchens assigned to your account. All fulfilment remains simulated.</p></div>
 <div className="grid lg:grid-cols-[260px_1fr] mt-7 gap-6"><aside className="panel p-4 self-start"><h2 className="font-bold text-sm uppercase tracking-wide text-muted px-2 mb-3">Choose a kitchen</h2><div className="space-y-1">{restaurants?.map(r => <button key={r.id} onClick={() => pick(r.id)} className={'w-full text-left flex items-center gap-3 px-3 py-3 rounded-xl ' + (selected === r.id ? 'bg-peach text-coral font-bold' : 'hover:bg-light')}><Store size={17}/><span className="text-sm">{r.name}</span></button>)}</div></aside>
 <div className="space-y-6"><div className="panel p-6"><div className="flex flex-wrap justify-between gap-3 items-start"><div><p className="eyebrow">KITCHEN SETTINGS</p><h2 className="font-outfit font-bold text-2xl mt-2">{current?.name}</h2><p className="text-muted text-sm mt-1">{current?.cuisine}</p></div><span className={'text-xs font-bold px-3 py-1 rounded-lg ' + (current?.is_open ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700')}>{current?.is_open ? '● Open' : '● Closed'}</span></div><div className="flex gap-4 mt-6 flex-wrap items-end"><button className="btn-secondary" disabled={busy} onClick={() => patchRestaurant({ is_open: !current?.is_open })}>{current?.is_open ? 'Close kitchen' : 'Open kitchen'}</button><label className="flex items-center gap-2 text-sm font-semibold"><Clock3 size={17}/> Prep estimate <select aria-label="Preparation minutes" className="field w-auto" disabled={busy} value={current?.prep_minutes ?? 20} onChange={e => patchRestaurant({ prep_minutes: Number(e.target.value) })}>{[10, 13, 15, 19, 20, 22, 24, 29, 35, 45, 50, 60, 90].map(n => <option key={n} value={n}>{n} min</option>)}</select></label></div></div>
 {!ready ? <div className="panel p-10 text-center"><ChefHat className="mx-auto text-coral" size={32}/><h2 className="font-bold text-lg mt-3">Load this kitchen's operational data</h2><p className="text-muted text-sm mt-2">Inspect menu availability and process mock incoming orders.</p><button onClick={() => refresh()} className="btn-primary mt-5">Open kitchen workspace <ArrowRight size={16}/></button></div> : <><section className="panel p-6"><div className="flex justify-between items-center"><h2 className="font-outfit font-extrabold text-xl">Menu availability <span className="text-muted text-sm">({items.length})</span></h2><Utensils size={19} className="text-coral"/></div><div className="grid sm:grid-cols-2 gap-x-5 mt-5">{items.map(item => <div className="flex items-center justify-between py-3 border-b gap-3" key={item.id}><div className="min-w-0"><p className="font-bold text-sm truncate">{item.name}</p><form className="flex items-center gap-1 mt-1" onSubmit={e => { e.preventDefault(); void changePrice(item); }}><span className="text-xs text-muted">₹</span><input className="w-16 border rounded px-1 text-xs py-1" aria-label={`Price for ${item.name} in rupees`} type="number" min="1" max="2000" step="0.01" value={prices[item.id] ?? String(item.price_paise / 100)} onChange={e => setPrices(p => ({ ...p, [item.id]: e.target.value }))}/><button aria-label={`Save price for ${item.name}`} title="Save price" className="text-coral p-1" disabled={busy}><Save size={13}/></button></form></div><button disabled={busy} onClick={() => patchItem(item)} className={'px-3 py-2 rounded-lg border text-xs font-bold whitespace-nowrap ' + (item.is_available ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800')}>{item.is_available ? 'Available' : 'Sold out'}</button></div>)}</div></section>
 <section className="panel p-6"><div className="flex justify-between items-center"><h2 className="font-outfit font-extrabold text-xl">Incoming orders <span className="text-muted text-sm">({orders.length})</span></h2><button onClick={() => refresh()} className="text-coral text-sm font-bold">Refresh</button></div>{!orders.length ? <p className="text-muted text-sm mt-5">No demo orders for this kitchen yet. Place an order from the customer application first.</p> : orders.map(o => { const leg = o.legs.find(l => l.restaurant_id === selected); const next = { pending: 'accepted', accepted: 'preparing', preparing: 'ready' }; return <div key={o.id} className="border rounded-xl p-4 mt-4"><div className="flex justify-between items-start gap-3"><div><Link to={'/tracking/' + o.id} className="font-bold hover:text-coral">{o.short_code} →</Link><p className="text-muted text-xs mt-1">{o.items.filter(i => i.restaurant_id === selected).map(i => `${i.quantity}× ${i.name}`).join(' · ')}</p></div><span className="rounded-md bg-light px-2 py-1 text-xs font-bold">{leg?.status}</span></div><div className="flex flex-wrap gap-2 mt-4">{leg && next[leg.status] && <button disabled={busy} className="btn-dark text-xs" onClick={() => legAction(leg.status, next[leg.status], o.id)}>Mark {next[leg.status]}</button>}{leg?.status === 'ready' && <span className="text-xs text-muted">Awaiting assigned delivery partner pickup</span>}{leg && ['pending', 'accepted', 'preparing'].includes(leg.status) && <button disabled={busy} className="btn-secondary text-xs" onClick={() => actionLeg(o.id, 'rejected')}>Reject</button>}</div></div>; })}</section></>}{actionError && <p role="alert" className="text-red-800 rounded-xl bg-red-50 p-4">{actionError}</p>}</div></div></div>;
    function legAction(_old, status, orderId) { void actionLeg(orderId, status); }
}
