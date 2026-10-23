import { createContext, useContext, useMemo, useState } from 'react';
const Context = createContext(null);
const KEY = 'comboroute_react_cart_v2';
function load() {
    try {
        const d = JSON.parse(localStorage.getItem(KEY) || '{}');
        return { lines: Array.isArray(d.lines) ? d.lines.filter((x) => x.item && Number.isInteger(x.quantity) && x.quantity > 0) : [], addressId: [1, 2, 3].includes(d.addressId) ? d.addressId : 1 };
    }
    catch {
        return { lines: [], addressId: 1 };
    }
}
export function CartProvider({ children }) {
    const [initial] = useState(load);
    const [lines, setLines] = useState(initial.lines);
    const [addressId, setAddress] = useState(initial.addressId);
    const [error, setError] = useState('');
    function save(next, addr = addressId) { try {
        localStorage.setItem(KEY, JSON.stringify({ lines: next, addressId: addr }));
    }
    catch { /* private browsing still supports in-memory state */ } }
    function add(item) {
        setLines(previous => {
            const ids = new Set(previous.map(l => l.item.restaurant_id));
            if (!ids.has(item.restaurant_id) && ids.size >= 2) {
                setError('ComboRoute supports a maximum of two restaurants per basket.');
                return previous;
            }
            const prev = previous.find(l => l.item.id === item.id);
            const total = previous.reduce((n, l) => n + l.quantity, 0);
            if (total >= 12) {
                setError('A delivery partner can carry up to 12 portions.');
                return previous;
            }
            const next = prev ? previous.map(l => l.item.id === item.id ? { ...l, quantity: l.quantity + 1 } : l) : [...previous, { item, quantity: 1 }];
            save(next);
            setError('');
            return next;
        });
    }
    function remove(id) { setLines(p => { const next = p.flatMap(l => l.item.id === id ? (l.quantity > 1 ? [{ ...l, quantity: l.quantity - 1 }] : []) : [l]); save(next); return next; }); }
    function clear() { setLines([]); save([]); setError(''); }
    const value = useMemo(() => ({ lines, addressId, setAddressId(id) { setAddress(id); save(lines, id); }, add, remove, clear, count: lines.reduce((n, l) => n + l.quantity, 0), subtotal: lines.reduce((n, l) => n + l.item.price_paise * l.quantity, 0), items: lines.map(l => ({ menu_item_id: l.item.id, quantity: l.quantity })), restaurants: [...new Set(lines.map(l => l.item.restaurant_id))], quantity(id) { return lines.find(l => l.item.id === id)?.quantity ?? 0; }, error, clearError: () => setError('') }), [lines, addressId, error]);
    return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useCart = () => { const v = useContext(Context); if (!v)
    throw new Error('CartProvider missing'); return v; };
