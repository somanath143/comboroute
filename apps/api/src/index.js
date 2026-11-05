import './env.js';
import mongoose from 'mongoose';
import { app } from './app.js';
import { seedDatabase } from './db/seed.js';
import { bootstrapStaff } from './db/bootstrap-users.js';
import { startWorker } from './services/worker.js';
import { migrateBackendData } from './db/migrate-backend.js';
import { drainHttpServer } from './services/shutdown.js';
const uri = process.env.MONGODB_URI;
if (!uri) {
    console.error('Missing MONGODB_URI. Create .env from .env.example or run Docker Compose.');
    process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
    const topology = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!topology.setName && topology.msg !== 'isdbgrid') throw new Error('MongoDB transactions require a replica set or sharded cluster. Use Atlas or the supplied Docker Compose replica set.');
    // Unique idempotency/payment indexes must exist before accepting requests.
    await Promise.all(Object.values(mongoose.models).map(model => model.init()));
    const seeded = await seedDatabase();
    await migrateBackendData();
    await bootstrapStaff();
    const worker = process.env.WORKER_ENABLED === 'false' ? null : startWorker();
    console.log(`[ComboRoute] Connected to MongoDB; seeded up to ${seeded.restaurants} restaurants, ${seeded.items} dishes`);
    const server = app.listen(port, '0.0.0.0', () => console.log(`[ComboRoute] http://localhost:${port}`));
    let stopping = false;
    const shutdown = async () => {
        if (stopping) return; stopping = true;
        const deadline = setTimeout(() => process.exit(1), 25000); deadline.unref();
        try {
            await drainHttpServer(server);
            await worker?.stop();
            await mongoose.disconnect();
            clearTimeout(deadline); process.exit(0);
        } catch { console.error('Application shutdown did not complete cleanly'); process.exit(1); }
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
}
catch (e) {
    console.error('Could not initialize application:', e);
    process.exit(1);
}
