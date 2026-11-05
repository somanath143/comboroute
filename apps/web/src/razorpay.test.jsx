import { afterEach, describe, it, expect, vi } from 'vitest';
afterEach(() => { vi.useRealTimers(); document.querySelectorAll('script').forEach(s => s.remove()); delete window.Razorpay; });
describe('Razorpay script loading', () => {
  it('times out and allows a later retry when the script is blocked', async () => {
    vi.resetModules(); vi.useFakeTimers();
    const { loadRazorpay } = await import('./razorpay');
    const first = expect(loadRazorpay()).rejects.toThrow('could not load');
    await vi.advanceTimersByTimeAsync(15000); await first;
    expect(document.querySelector('script')).toBeNull();
    const retry = loadRazorpay();
    window.Razorpay = function () {};
    document.querySelector('script').dispatchEvent(new Event('load'));
    await expect(retry).resolves.toBeUndefined();
  });
  it('rejects a loaded script that did not initialize Checkout', async () => {
    vi.resetModules();
    const { loadRazorpay } = await import('./razorpay');
    const result = expect(loadRazorpay()).rejects.toThrow('could not load');
    document.querySelector('script').dispatchEvent(new Event('load'));
    await result;
  });
});
