import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import os from 'node:os';
const base = process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:3108';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('This script only load-tests a local server');
const requests = Number(process.env.LOAD_REQUESTS ?? 100), concurrency = Number(process.env.LOAD_CONCURRENCY ?? 10);
if (!Number.isInteger(requests) || requests < 1 || requests > 10000 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) throw new Error('Invalid load parameters');
const paths = ['/api/restaurants?q=biryani', '/api/restaurants/1', '/api/health'];
for (const path of paths) { const response = await fetch(base + path); if (!response.ok) throw new Error('Warmup failed: ' + response.status); await response.arrayBuffer(); }
let next = 0, errors = 0, cacheHits = 0; const samples = []; const statuses = {};
const start = performance.now();
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < requests) {
    const index = next++; const began = performance.now();
    try {
      const response = await fetch(base + paths[index % paths.length], { signal: AbortSignal.timeout(15000) });
      await response.arrayBuffer(); statuses[response.status] = (statuses[response.status] ?? 0) + 1;
      if (!response.ok) errors++; if (response.headers.get('X-Catalog-Cache') === 'HIT') cacheHits++;
    } catch { errors++; }
    samples.push(performance.now() - began);
  }
}));
const duration = (performance.now() - start) / 1000; samples.sort((a, b) => a - b);
const percentile = p => Math.round(samples[Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1)] * 100) / 100;
const result = { timestamp: new Date().toISOString(), node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model, memory_gb: Math.round(os.totalmem() / 1024 ** 3), base,
  requests, concurrency, duration_seconds: duration, requests_per_second: requests / duration, p50_ms: percentile(.5), p95_ms: percentile(.95), p99_ms: percentile(.99), errors, statuses, cache_hits: cacheHits,
  scope: 'Read-only HTTP catalog/detail/health smoke load; not a payment or capacity benchmark' };
await mkdir(resolve('artifacts'), { recursive: true }); await writeFile(resolve('artifacts/load-results.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2)); if (errors) process.exitCode = 1;
