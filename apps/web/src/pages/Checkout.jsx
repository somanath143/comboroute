import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Clock3, Info, MapPin, ShieldCheck, Truck, Route as RouteIcon } from 'lucide-react';
import { useCart } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';
import { api, getAddresses, getQuote, money } from '../lib';
import { Loading, ErrorView, Empty } from '../components/UI';
let razorpayScriptPromise;
function loadRazorpay() {
    if (window.Razorpay) return Promise.resolve();
    if (!razorpayScriptPromise) razorpayScriptPromise = new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://checkout.razorpay.com/v1/checkout.js'; script.onload = resolve; script.onerror = () => { razorpayScriptPromise = null; reject(new Error('Razorpay Checkout could not load. Check your connection.')); }; document.head.appendChild(script); });
    return razorpayScriptPromise;
}
export function CheckoutPage() {
    const cart = useCart(), navigate = useNavigate(), { user } = useAuth();
    const [paymentMode, setPaymentMode] = useState('demo');
    useEffect(() => { api('/config').then(c => setPaymentMode(c.payment_mode)).catch(() => {}); }, []);
    const [quote, setQuote] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [mode, setMode] = useState('separate'), [accepted, setAccepted] = useState(false), [note, setNote] = useState(''), [processing, setProcessing] = useState(false);
    const [addressLine, setAddressLine] = useState('');
    const key = useRef(crypto.randomUUID());
    const fingerprint = JSON.stringify({ items: cart.items, address: cart.addressId });
    useEffect(() => {
        let active = true;
        if (!cart.count) {
            setLoading(false);
            return;
        }
        setLoading(true);
        setError('');
        setQuote(null);
        setAccepted(false);
        key.current = crypto.randomUUID();
        getQuote(cart.items, cart.addressId).then(q => { if (active) {
            setQuote(q);
            setMode(cart.restaurants.length === 2 && q.routing.eligible ? 'combined' : 'separate');
        } }).catch(e => { if (active)
            setError(e.message); }).finally(() => { if (active)
            setLoading(false); });
        return () => { active = false; };
    }, [fingerprint]);
    useEffect(() => { getAddresses().then(a => setAddressLine(a.find(x => x.id === cart.addressId)?.line ?? '')).catch(() => { }); }, [cart.addressId]);
    async function submit() {
        if (!quote)
            return;
        if (mode === 'combined' && cart.restaurants.length > 1 && !accepted) {
            setError('Please accept the combined delivery estimate before checkout.');
            return;
        }
        setProcessing(true);
        setError('');
        let modalOpen = false;
        try {
            const checkout = { address_id: cart.addressId, items: cart.items, quote_id: quote.id, idempotency_key: key.current, mode, accepted_combo: accepted, note };
            if (paymentMode === 'razorpay_test') {
                const intent = await api('/payments/create-intent', { method: 'POST', body: JSON.stringify(checkout) });
                await loadRazorpay();
                const instance = new window.Razorpay({
                    key: intent.key_id, amount: intent.amount_paise, currency: 'INR', order_id: intent.razorpay_order_id,
                    name: 'ComboRoute TEST', description: 'Fictional food delivery · Test payment only',
                    prefill: { name: user?.name, email: user?.email },
                    theme: { color: '#f26d42' },
                    handler: async response => {
                        try {
                            const verified = await api('/payments/verify', { method: 'POST', body: JSON.stringify({ payment_intent_id: intent.id, ...response }) });
                            cart.clear(); navigate('/tracking/' + verified.order_id);
                        } catch (e) { setError(e.message + ' If payment was captured, do not retry until it is reconciled.'); }
                        finally { setProcessing(false); }
                    },
                    modal: { ondismiss: () => setProcessing(false) }
                });
                instance.on('payment.failed', response => { setError(response.error?.description ?? 'Test payment failed'); setProcessing(false); });
                instance.open();
                modalOpen = true;
                return;
            }
            const order = await api('/orders', { method: 'POST', body: JSON.stringify(checkout) });
            cart.clear(); navigate('/tracking/' + order.id);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            if (!modalOpen) setProcessing(false);
        }
    }
    if (!cart.count)
        return <div className="content-width"><Empty title="Nothing to check out yet" description="Add something delicious before comparing delivery options." action={<Link className="btn-primary" to="/">Explore restaurants <ArrowRight size={16}/></Link>}/></div>;
    return <div className="content-width"><Link to="/cart" className="inline-flex mt-8 gap-2 text-sm text-muted font-semibold"><ArrowLeft size={16}/> Back to cart</Link><div className="page-heading"><div><p className="eyebrow">THE SMARTER LAST STEP</p><h1 className="font-outfit text-4xl font-black mt-2">Compare your delivery</h1><p className="text-muted mt-2">Transparent timing and price before you confirm.</p></div></div>
 {loading ? <Loading text="Checking pickup sequences and calculating fees…"/> : error && !quote ? <ErrorView message={error} onRetry={() => window.location.reload()}/> : quote && <div className="grid lg:grid-cols-[1fr_365px] gap-7 mt-7 items-start"><div className="space-y-6"><div className="panel p-6"><div className="flex gap-3 items-center"><MapPin size={20} className="text-coral"/><div><h2 className="font-bold">Delivery to your saved address</h2><p className="text-sm text-muted mt-1">{addressLine}</p></div></div></div>
 <section className="panel p-6"><h2 className="font-outfit text-xl font-extrabold">Choose your delivery method</h2><p className="text-sm text-muted mt-1">Both options include identical food, packaging and illustrative taxes.</p><div className="grid sm:grid-cols-2 gap-4 mt-5"><button onClick={() => { setMode('separate'); setAccepted(false); }} className={'choice-card ' + (mode === 'separate' ? 'selected' : '')}><div className="flex justify-between items-center"><Truck size={22}/><span className="choice-radio">{mode === 'separate' ? '●' : '○'}</span></div><div className="text-lg font-extrabold mt-4">Separate deliveries</div><p className="text-xs text-muted mt-1">Each kitchen sends its own driver</p><div className="text-2xl font-black mt-4">{money(quote.pricing.separate.total_paise)}</div></button><button disabled={!quote.routing.eligible || cart.restaurants.length < 2} onClick={() => setMode('combined')} className={'choice-card ' + (mode === 'combined' ? 'selected' : '') + ' ' + (!quote.routing.eligible || cart.restaurants.length < 2 ? 'opacity-55 cursor-not-allowed' : '')}><div className="flex justify-between items-center"><RouteIcon size={22}/><span className="choice-radio">{mode === 'combined' ? '●' : '○'}</span></div><div className="text-lg font-extrabold mt-4">ComboRoute delivery</div><p className="text-xs text-muted mt-1">One driver · two kitchen pickups</p><div className="text-2xl font-black mt-4">{money(quote.pricing.combined.total_paise)}</div></button></div>
 {cart.restaurants.length > 1 && <div className={'mt-4 p-4 rounded-xl text-sm ' + (quote.routing.eligible ? 'bg-green-50 text-green-900' : 'bg-amber-50 text-amber-900')}><strong>{quote.routing.eligible ? '✓ Combination passes operational checks' : '⚠ Combination unavailable'}</strong><p className="mt-1">{quote.routing.eligible ? `Preferred pickup: ${quote.routing.selected_route.sequence_names.join(' → ')}. Extra delay: about ${quote.routing.additional_delay_minutes} min.` : quote.routing.reasons.join('. ')}</p></div>}
 {quote.routing.eligible && cart.restaurants.length > 1 && <div className="mt-4 text-sm font-semibold">{quote.pricing.savings_paise > 0 ? <p className="text-green-700">Combined delivery saves {money(quote.pricing.savings_paise)} in this demo.</p> : quote.pricing.savings_paise < 0 ? <p className="text-amber-800">Combined delivery costs {money(Math.abs(quote.pricing.savings_paise))} more. Choose freely.</p> : <p>No difference in total price.</p>}</div>}</section>
 <section className="panel p-6"><h2 className="font-outfit text-xl font-extrabold flex gap-2 items-center"><Clock3 className="text-coral"/> Pickup & freshness estimate</h2><div className="mt-4 flex justify-between text-sm"><span className="text-muted">Original single-kitchen delivery</span><strong>~{quote.routing.baseline_minutes} min</strong></div><div className="mt-3 flex justify-between text-sm"><span className="text-muted">Selected route delivery</span><strong>~{quote.routing.selected_route.delivery_minute} min</strong></div><div className="mt-3 flex justify-between text-sm"><span className="text-muted">Additional delay to first order</span><strong>+{quote.routing.additional_delay_minutes} min</strong></div><ol className="space-y-3 border-l-2 border-dashed border-coral/30 ml-2 mt-6">{quote.routing.selected_route.pickups.map(p => <li className="ml-5 relative text-sm" key={p.restaurant_id}><span className="absolute rounded-full bg-coral h-2.5 w-2.5 -left-[26px] top-1.5"/><strong>{p.name}</strong><div className="text-muted">Pickup at ~{p.pickup_minute} min · {p.wait_minutes} min wait · {p.holding_minutes} min estimated holding</div></li>)}</ol><p className="text-muted text-xs mt-5 bg-light rounded-xl p-3"><Info size={13} className="inline mr-1"/> Coordinates and travel are calculated with a local estimator, not live traffic or navigation. These times are simulation estimates.</p></section>
 <section className="panel p-6"><label htmlFor="note" className="font-bold text-sm">Notes for the kitchens (optional)</label><textarea id="note" className="field mt-3 min-h-20" maxLength={400} value={note} onChange={e => setNote(e.target.value)} placeholder="Less spicy, please…"/></section></div>
 <aside className="panel p-6 lg:sticky lg:top-28"><p className="eyebrow">PRICE BREAKDOWN</p><h2 className="font-outfit text-2xl font-bold mt-3">Your final bill</h2><div className="mt-5 space-y-3 text-sm"><div className="bill-row"><span>Food ({cart.count} items)</span><strong>{money(quote.pricing.food_paise)}</strong></div><div className="bill-row"><span>Packaging</span><strong>{money(quote.pricing.packaging_paise)}</strong></div><div className="bill-row"><span>Illustrative food tax</span><strong>{money(quote.pricing.tax_paise)}</strong></div><div className="bill-row"><span>Delivery</span><strong>{money(quote.pricing[mode].delivery_paise)}</strong></div><div className="bill-row"><span>Platform fee</span><strong>{money(quote.pricing[mode].platform_paise)}</strong></div><div className="bill-row border-t pt-4 text-base text-ink"><span className="font-extrabold">Grand total</span><strong className="text-xl">{money(quote.pricing[mode].total_paise)}</strong></div></div>
 {mode === 'combined' && cart.restaurants.length > 1 && <label className="block mt-6 p-3 bg-peach rounded-xl text-sm"><input type="checkbox" className="accent-coral mr-2" checked={accepted} onChange={e => setAccepted(e.target.checked)}/> I accept the estimated combined pickup route and added delay.</label>}
 {error && <div role="alert" className="bg-red-50 text-red-800 rounded-xl p-3 mt-4 text-sm">{error}</div>}
 <button disabled={processing || mode === 'combined' && cart.restaurants.length > 1 && !accepted} className="btn-primary w-full justify-between mt-6" onClick={submit}>{processing ? 'Processing checkout…' : paymentMode === 'razorpay_test' ? 'Pay securely (Razorpay TEST)' : 'Place demo order'} <ArrowRight size={18}/></button><p className="text-center text-xs text-muted mt-3"><ShieldCheck size={13} className="inline mr-1"/> {paymentMode === 'razorpay_test' ? 'Razorpay TEST keys only · no real money' : 'Demo order · no payment collected'}</p><p className="text-xs text-muted mt-5">Quote valid until {new Date(quote.expires_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}. Price or kitchen changes require a new quote.</p></aside></div>}</div>;
}
