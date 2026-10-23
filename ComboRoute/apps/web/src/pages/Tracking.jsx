import { useParams, Link } from 'react-router-dom';
import { useState } from 'react';
import { ArrowLeft, ArrowRight, Bike, CheckCircle2, RefreshCw, MapPin, XCircle } from 'lucide-react';
import { useLoad } from '../hooks/useLoad';
import { getOrder, advance, cancel, money } from '../lib';
import { Loading, ErrorView } from '../components/UI';
const stages = ['confirmed', 'preparing', 'ready_for_pickup', 'picked_up', 'in_transit', 'delivered'];
export function TrackingPage() {
    const { id } = useParams(), { data, loading, error, reload } = useLoad(() => getOrder(id), [id]), [busy, setBusy] = useState(false), [actionError, setActionError] = useState('');
    async function act(type) { if (!id)
        return; setBusy(true); setActionError(''); try {
        await (type === 'advance' ? advance(id) : cancel(id));
        reload();
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
    if (!data)
        return null;
    const terminal = ['cancelled', 'failed', 'delivered'].includes(data.status), step = stages.indexOf(data.status), canCancel = ['created', 'confirmed', 'preparing', 'ready_for_pickup'].includes(data.status);
    return <div className="content-width"><Link className="inline-flex gap-2 mt-8 text-muted text-sm font-semibold" to="/orders"><ArrowLeft size={16}/> All orders</Link><div className="page-heading"><div><p className="eyebrow">DELIVERY TRACKING · SIMULATED</p><h1 className="font-outfit text-4xl font-black mt-2">Order {data.short_code}</h1><p className="text-muted mt-2">{new Date(data.created_at).toLocaleString('en-IN')} · {data.legs.length} kitchens · {data.mode} delivery</p></div><span className={'font-bold px-4 py-2 rounded-full text-sm ' + (terminal ? 'bg-gray-100' : 'bg-green-100 text-green-800')}>{data.status.replaceAll('_', ' ')}</span></div>
 <div className="grid lg:grid-cols-[1fr_340px] mt-8 gap-6 items-start"><div className="space-y-6"><section className="panel p-6"><div className="flex gap-4 items-start"><div className="rounded-2xl bg-peach p-3 text-coral"><Bike size={28}/></div><div><h2 className="text-xl font-outfit font-extrabold">{data.status === 'delivered' ? 'Delivery complete!' : data.status === 'failed' ? 'A kitchen or route became unavailable' : data.status === 'cancelled' ? 'Order cancelled' : 'Your order is in progress'}</h2><p className="text-sm text-muted mt-2">{data.failure_reason ?? 'This is a simulated fulfilment flow. No driver is being dispatched.'}</p></div></div>{!['failed', 'cancelled'].includes(data.status) && <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-8">{stages.map((s, i) => <div key={s} className="text-center"><div className={'mx-auto w-8 h-8 rounded-full grid place-items-center ' + (i <= step ? 'bg-coral text-white' : 'bg-light text-muted')}>{i < step ? <CheckCircle2 size={18}/> : i + 1}</div><p className="mt-2 capitalize text-[10px] leading-tight text-muted">{s.replaceAll('_', ' ')}</p></div>)}</div>}{actionError && <p role="alert" className="bg-red-50 p-3 rounded-xl text-sm text-red-800 mt-4">{actionError}</p>}<div className="flex gap-3 flex-wrap mt-6">{!terminal && <button className="btn-primary" disabled={busy} onClick={() => act('advance')}><RefreshCw size={16}/> Advance demo status</button>}{canCancel && <button className="btn-secondary" disabled={busy} onClick={() => act('cancel')}><XCircle size={16}/> Cancel order</button>}<button className="btn-secondary" onClick={reload}><RefreshCw size={16}/> Refresh</button></div></section>
 <section className="panel p-6"><h2 className="font-outfit text-xl font-extrabold">Kitchen fulfilment</h2><div className="space-y-4 mt-5">{data.legs.map(l => <div key={l.restaurant_id} className="p-4 rounded-xl border flex items-center justify-between gap-3"><div><p className="font-bold text-sm">{l.restaurant_name}</p><p className="text-xs text-muted mt-1">Estimated prep {l.eta_minutes} min</p></div><span className="text-xs text-coral bg-peach p-2 rounded-lg font-bold">{l.status}</span></div>)}</div></section>
 <section className="panel p-6"><h2 className="font-outfit text-xl font-extrabold">Status timeline</h2><div className="space-y-0 mt-5 border-l-2 border-peach ml-2">{data.events.slice().reverse().map((ev, index) => <div className="relative ml-5 pb-5" key={index}><span className="absolute rounded-full bg-coral w-3 h-3 -left-[27px] top-1"/><div className="font-bold text-sm capitalize">{ev.status.replaceAll('_', ' ')}</div><p className="text-muted text-sm mt-1">{ev.message}</p><p className="text-muted text-[11px] mt-1">{new Date(ev.timestamp).toLocaleTimeString('en-IN')}</p></div>)}</div></section></div>
 <aside className="panel p-6"><p className="eyebrow">ORDER DETAILS</p><div className="flex gap-2 items-center mt-4 text-sm"><MapPin size={17} className="text-coral"/><div><strong>{data.address.label}</strong><p className="text-xs text-muted mt-1">{data.address.line}</p></div></div><hr className="my-6"/><h3 className="font-bold mb-4">What's in the bag</h3>{data.items.map(i => <div key={i.menu_item_id} className="flex justify-between text-sm gap-3 mb-3"><span>{i.quantity}× {i.name}</span><strong className="shrink-0">{money(i.quantity * i.price_paise)}</strong></div>)}<hr className="my-5"/><div className="flex justify-between font-black text-lg"><span>Total</span><span>{money(data.total_paise)}</span></div><p className="text-xs text-muted mt-4">All charges were verified by the server. No payment was collected.</p><Link to="/" className="btn-dark w-full justify-between mt-6">Order more food <ArrowRight size={15}/></Link></aside></div></div>;
}
