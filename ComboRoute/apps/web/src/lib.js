export const money = (paise) => '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
export const image = (key) => `/assets/${encodeURIComponent(key || 'biryani')}.webp`;
export async function api(path, options = {}) {
    let response;
    try {
        response = await fetch('/api' + path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    }
    catch {
        throw new Error('Cannot connect to ComboRoute API. Check the backend server.');
    }
    const data = await response.json().catch(() => ({ error: 'Unexpected response from server' }));
    if (!response.ok)
        throw new Error(data.error ?? `Request failed (${response.status})`);
    return data;
}
export const getAddresses = () => api('/addresses');
export const listRestaurants = (query = '') => api('/restaurants' + query);
export const getRestaurant = (id) => api(`/restaurants/${id}`);
export const getCandidates = (id, addressId) => api(`/combos/candidates?primary_id=${id}&address_id=${addressId}`);
export const getQuote = (items, address_id) => api('/quotes', { method: 'POST', body: JSON.stringify({ customer_id: 1, address_id, items }) });
export const listOrders = () => api('/orders');
export const getOrder = (id) => api(`/orders/${id}`);
export const advance = (id) => api(`/orders/${id}/advance`, { method: 'POST' });
export const cancel = (id) => api(`/orders/${id}/cancel`, { method: 'POST' });
