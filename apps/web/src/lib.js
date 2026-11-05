export const money = (paise) => '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
// randomUUID requires HTTPS in browsers; local LAN previews may use HTTP.
export function checkoutKey() {
    if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const image = (key) => `/assets/${encodeURIComponent(key || 'biryani')}.webp`;
export async function api(path, options = {}) {
    let response;
    try {
        response = await fetch('/api' + path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    }
    catch {
        throw new Error('Cannot connect to ComboRoute API. Check the backend server.');
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error('Unexpected response from server. Please retry once the service is ready.'); }
    if (data === null || typeof data !== 'object') throw new Error('Unexpected response from server. Please retry.');
    if (!response.ok)
        throw new Error(data.error ?? `Request failed (${response.status})`);
    return data;
}
export const getAddresses = () => api('/addresses');
export const listRestaurants = (query = '') => api('/restaurants' + query);
export const getRestaurant = (id) => api(`/restaurants/${id}`);
export const getCandidates = (id, addressId) => api(`/combos/candidates?primary_id=${id}&address_id=${addressId}`);
export const getQuote = (items, address_id) => api('/quotes', { method: 'POST', body: JSON.stringify({ address_id, items }) });
export const listOrders = () => api('/orders');
export const getOrder = (id) => api(`/orders/${id}`);
export const advance = (id) => api(`/orders/${id}/advance`, { method: 'POST' });
export const cancel = (id) => api(`/orders/${id}/cancel`, { method: 'POST' });
