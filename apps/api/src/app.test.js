import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { app } from './app.js';

afterEach(() => vi.unstubAllEnvs());
describe('HTTP configuration and error handling', () => {
  it('preserves cross-origin payment popups', async () => {
    const response = await request(app).get('/api/config');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
  });
  it('fails closed for an invalid payment mode', async () => {
    vi.stubEnv('PAYMENT_MODE', 'razorpay_typo');
    const response = await request(app).get('/api/config');
    expect(response.status).toBe(503); expect(response.body.error).toContain('PAYMENT_MODE');
  });
  it('reports malformed JSON and oversized bodies as client errors', async () => {
    expect((await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{')).status).toBe(400);
    expect((await request(app).post('/api/auth/login').send({ data: 'x'.repeat(50000) })).status).toBe(413);
  });
  it('returns JSON 404s for unknown API paths and methods instead of the frontend HTML', async () => {
    for (const response of [await request(app).get('/api'), await request(app).get('/api/missing'), await request(app).post('/api/missing').send({})]) {
      expect(response.status).toBe(404); expect(response.body.error).toBe('API endpoint not found');
    }
  });
  it('keeps per-IP request protection and returns a readable JSON 429 response', async () => {
    for (let n = 0; n < 150; n++) expect((await request(app).get('/api/config').set('X-Forwarded-For', '192.0.2.150')).status).toBe(200);
    const limited = await request(app).get('/api/config').set('X-Forwarded-For', '192.0.2.150');
    expect(limited.status).toBe(429); expect(limited.body.error).toContain('Too many requests');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await request(app).get('/api/config').set('X-Forwarded-For', '192.0.2.151')).status).toBe(200);
  });
});
