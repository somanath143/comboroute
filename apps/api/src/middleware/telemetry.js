import { randomUUID } from 'node:crypto';
const buckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 15];
const counts = new Map();
const failures = new Map();
export const log = (level, event, fields = {}) => {
  if (process.env.NODE_ENV !== 'test') console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields }));
};
export function telemetry(req, res, next) {
  // Generate IDs internally; untrusted headers cannot inject log fields.
  req.requestId = randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  const start = process.hrtime.bigint();
  res.once('finish', () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path ?? 'unmatched';
    const key = JSON.stringify({ method: req.method, route, status: res.statusCode });
    const row = counts.get(key) ?? { count: 0, sum: 0, buckets: buckets.map(() => 0) };
    row.count++; row.sum += seconds; buckets.forEach((limit, i) => { if (seconds <= limit) row.buckets[i]++; }); counts.set(key, row);
    log('info', 'http.request', { request_id: req.requestId, method: req.method, route, status: res.statusCode, duration_ms: Math.round(seconds * 1000) });
  });
  next();
}
export function countFailure(name) { failures.set(name, (failures.get(name) ?? 0) + 1); }
export function prometheusMetrics() {
  const lines = ['# HELP comboroute_http_request_duration_seconds HTTP request duration', '# TYPE comboroute_http_request_duration_seconds histogram'];
  for (const [key, row] of counts) {
    const labels = Object.entries(JSON.parse(key)).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join(',');
    buckets.forEach((le, i) => lines.push(`comboroute_http_request_duration_seconds_bucket{${labels},le="${le}"} ${row.buckets[i]}`));
    lines.push(`comboroute_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${row.count}`,
      `comboroute_http_request_duration_seconds_count{${labels}} ${row.count}`, `comboroute_http_request_duration_seconds_sum{${labels}} ${row.sum}`);
  }
  lines.push('# TYPE comboroute_failures_total counter');
  for (const [kind, count] of failures) lines.push(`comboroute_failures_total{kind=${JSON.stringify(kind)}} ${count}`);
  return lines.join('\n') + '\n';
}
