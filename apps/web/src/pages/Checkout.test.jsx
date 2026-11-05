import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { CheckoutPage } from './Checkout';
const mocks = vi.hoisted(() => ({ api: vi.fn(), getQuote: vi.fn(), clear: vi.fn() }));
vi.mock('../lib', async original => ({ ...await original(), api: mocks.api, getQuote: mocks.getQuote,
  getAddresses: async () => [{ id: 1000, line: 'Demo address' }] }));
vi.mock('../context/CartContext', () => ({ useCart: () => ({ items: [{ menu_item_id: 1, quantity: 1 }], addressId: 1000, count: 1, restaurants: [1], clear: mocks.clear }) }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { name: 'Tester', email: 'test@example.test' } }) }));
const bill = { total_paise: 20000, delivery_paise: 2000, platform_paise: 900 };
let options, failure, dismiss;
beforeEach(() => {
  mocks.api.mockReset(); mocks.clear.mockReset(); mocks.getQuote.mockReset();
  mocks.getQuote.mockResolvedValue({ id: 'quote', expires_at: new Date(Date.now() + 60000).toISOString(),
    pricing: { separate: bill, combined: bill, food_paise: 16000, packaging_paise: 1000, tax_paise: 100 },
    routing: { eligible: true, baseline_minutes: 20, additional_delay_minutes: 0, selected_route: { delivery_minute: 20, pickups: [] } } });
  mocks.api.mockImplementation(async path => {
    if (path === '/config') return { payment_mode: 'razorpay_test' };
    if (path === '/payments/create-intent') return { id: 'intent', key_id: 'rzp_test_demo', razorpay_order_id: 'order_test', amount_paise: 20000 };
    if (path === '/payments/verify') return { order_id: 'confirmed' };
    throw new Error('Unexpected API call: ' + path);
  });
  window.Razorpay = vi.fn(function (input) {
    options = input; dismiss = input.modal.ondismiss;
    this.on = (_event, callback) => { failure = callback; }; this.open = vi.fn();
  });
});
afterEach(() => { cleanup(); delete window.Razorpay; });
const renderCheckout = () => render(<MemoryRouter initialEntries={['/checkout']}><Routes><Route path="/checkout" element={<CheckoutPage />}/><Route path="/tracking/:id" element={<p>Confirmed order tracking</p>}/></Routes></MemoryRouter>);
async function openCheckout() {
  renderCheckout();
  fireEvent.click(await screen.findByRole('button', { name: 'Pay securely (Razorpay TEST)' }));
  await waitFor(() => expect(window.Razorpay).toHaveBeenCalledTimes(1));
}
const response = { razorpay_order_id: 'order_test', razorpay_payment_id: 'pay_test', razorpay_signature: 'signature' };
describe('checkout failure and recovery', () => {
  it('blocks ordering when configuration cannot be loaded', async () => {
    mocks.api.mockRejectedValue(new Error('Configuration unavailable'));
    renderCheckout();
    expect(await screen.findByRole('alert')).toHaveTextContent('Configuration unavailable');
    expect(screen.getByRole('button', { name: 'Loading payment configuration…' })).toBeDisabled();
    expect(mocks.api.mock.calls.some(([path]) => path === '/orders')).toBe(false);
  });
  it('shows gateway diagnostics and keeps a single modal active until dismissal', async () => {
    await openCheckout();
    act(() => failure({ error: { description: 'Try another payment method', reason: 'payment_failed', code: 'BAD_REQUEST_ERROR', metadata: { payment_id: 'pay_failed' } } }));
    expect(screen.getByRole('alert')).toHaveTextContent('pay_failed');
    expect(screen.getByRole('button', { name: 'Processing checkout…' })).toBeDisabled();
    act(() => dismiss());
    expect(screen.getByRole('button', { name: 'Pay securely (Razorpay TEST)' })).toBeEnabled();
  });
  it('retries verification without charging again or clearing the cart prematurely', async () => {
    await openCheckout();
    mocks.api.mockRejectedValueOnce(new Error('Temporary verification failure'));
    await act(async () => options.handler(response));
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Do not pay again');
    fireEvent.click(screen.getByRole('button', { name: 'Retry payment verification' }));
    expect(await screen.findByText('Confirmed order tracking')).toBeVisible();
    expect(mocks.clear).toHaveBeenCalledOnce();
    expect(mocks.api.mock.calls.filter(([path]) => path === '/payments/create-intent')).toHaveLength(1);
    expect(mocks.api.mock.calls.filter(([path]) => path === '/payments/verify')).toHaveLength(2);
  });
  it('navigates to an existing paid order without opening a new payment modal', async () => {
    const implementation = mocks.api.getMockImplementation();
    mocks.api.mockImplementation(async (path, args) => path === '/payments/create-intent' ? { order_id: 'confirmed' } : implementation(path, args));
    renderCheckout();
    fireEvent.click(await screen.findByRole('button', { name: 'Pay securely (Razorpay TEST)' }));
    expect(await screen.findByText('Confirmed order tracking')).toBeVisible();
    expect(window.Razorpay).not.toHaveBeenCalled();
  });
});
