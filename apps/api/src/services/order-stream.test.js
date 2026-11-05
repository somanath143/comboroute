import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamOrderEvents } from './order-stream.js';
afterEach(() => vi.restoreAllMocks());
describe('SSE lifecycle', () => {
  it('does not start a stream for a connection already closed during route authorization', async () => {
    const loadUser = vi.fn(), res = Object.assign(new EventEmitter(), { destroyed: true });
    await streamOrderEvents({}, res, { loadUser, ownedOrder: vi.fn() });
    expect(loadUser).not.toHaveBeenCalled(); expect(res.listenerCount('close')).toBe(0);
  });
  it('does not allocate timers or write after disconnect during the first lookup', async () => {
    let resolve;
    const lookup = new Promise(r => { resolve = r; });
    const res = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), writableEnded: false });
    const interval = vi.spyOn(globalThis, 'setInterval');
    const running = streamOrderEvents({}, res, { loadUser: () => lookup, ownedOrder: vi.fn() });
    res.emit('close'); resolve({ id: 'user' }); await running;
    expect(interval).not.toHaveBeenCalled(); expect(res.write).not.toHaveBeenCalled();
  });
});
