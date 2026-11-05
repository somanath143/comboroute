import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, checkoutKey } from './lib';
afterEach(() => vi.unstubAllGlobals());
describe('API response handling', () => {
  it('rejects HTML returned during proxy/cold-start errors even with status 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Starting service</html>', { status: 200 })));
    await expect(api('/restaurants')).rejects.toThrow('Unexpected response');
  });
  it('rejects null JSON instead of passing it into page renderers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 200 })));
    await expect(api('/restaurants')).rejects.toThrow('Unexpected response');
  });
  it('generates a valid UUID when randomUUID is unavailable in an HTTP LAN preview', () => {
    vi.stubGlobal('crypto', { getRandomValues: bytes => { bytes.fill(255); return bytes; } });
    expect(checkoutKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
