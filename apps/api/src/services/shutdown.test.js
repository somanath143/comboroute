import { afterEach, describe, expect, it, vi } from 'vitest';
import { drainHttpServer } from './shutdown.js';
afterEach(() => vi.useRealTimers());
describe('HTTP shutdown', () => {
  it('waits for in-flight requests before allowing database teardown', async () => {
    let finish;
    const server = { close: callback => { finish = callback; }, closeAllConnections: vi.fn() };
    let drained = false;
    const pending = drainHttpServer(server).then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    finish(); await pending; expect(drained).toBe(true); expect(server.closeAllConnections).not.toHaveBeenCalled();
  });
  it('closes long-lived streams after the shutdown deadline', async () => {
    vi.useFakeTimers(); let finish;
    const server = { close: callback => { finish = callback; }, closeAllConnections: vi.fn(() => finish()) };
    const pending = drainHttpServer(server, 100);
    await vi.advanceTimersByTimeAsync(100); await pending;
    expect(server.closeAllConnections).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});
