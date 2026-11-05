import './env.js';
import mongoose from 'mongoose';
import './models/index.js';
import './models/operations.js';
import { startWorker } from './services/worker.js';
import { log } from './middleware/telemetry.js';

try {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
  const worker = startWorker();
  // A standalone worker needs a referenced timer to keep the process running.
  const keepAlive = setInterval(() => {}, 60000);
  log('info', 'worker.started');
  const shutdown = async () => { clearInterval(keepAlive); await worker.stop(); await mongoose.disconnect(); process.exit(0); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
} catch { log('error', 'worker.start_failed'); process.exitCode = 1; await mongoose.disconnect(); }
