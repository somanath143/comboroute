import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { OrderModel } from '../apps/api/src/models/index.js';
if (!process.env.BENCHMARK_MONGODB_URI) throw new Error('Set BENCHMARK_MONGODB_URI to a disposable local replica set');
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):/.test(process.env.BENCHMARK_MONGODB_URI)) throw new Error('Benchmark requires a local disposable database');
const dbName = 'comboroute_benchmark_' + randomUUID().replaceAll('-', '');
const count = Number(process.env.BENCHMARK_ROWS ?? 10000);
if (!Number.isInteger(count) || count < 1000 || count > 100000) throw new Error('BENCHMARK_ROWS must be 1000–100000');
try {
  await mongoose.connect(process.env.BENCHMARK_MONGODB_URI, { dbName, serverSelectionTimeoutMS: 5000 });
  await OrderModel.init();
  for (let offset = 0; offset < count; offset += 1000) {
    const rows = Array.from({ length: Math.min(1000, count - offset) }, (_, n) => {
      const id = String(offset + n).padStart(8, '0');
      return { id, customer_id: (offset + n) % 100, idempotency_key: id, mode: 'separate', status: 'confirmed', createdAt: new Date(1700000000000 + offset + n) };
    });
    await OrderModel.collection.insertMany(rows);
  }
  const query = () => OrderModel.find({ customer_id: 42 }).sort({ createdAt: -1, id: -1 }).limit(25).lean();
  const baseline = await query().hint({ $natural: 1 }).explain('executionStats');
  const indexed = await query().hint({ customer_id: 1, createdAt: -1, id: -1 }).explain('executionStats');
  const compact = result => ({ returned: result.executionStats.nReturned, documents_examined: result.executionStats.totalDocsExamined, keys_examined: result.executionStats.totalKeysExamined, execution_ms: result.executionStats.executionTimeMillis, winning_plan: result.queryPlanner.winningPlan });
  const result = { timestamp: new Date().toISOString(), rows: count, database: dbName, baseline: compact(baseline), indexed: compact(indexed), scope: 'Single explain execution per plan; timings are diagnostic, not statistically significant latency measurements' };
  await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/database-benchmark.json', JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result, null, 2));
  if (result.indexed.documents_examined >= result.baseline.documents_examined) throw new Error('Index did not reduce documents examined');
} finally { if (mongoose.connection.readyState === 1 && mongoose.connection.name === dbName) await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
