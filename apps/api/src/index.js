import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });
import mongoose from 'mongoose';
import { app } from './app.js';
import { seedDatabase } from './db/seed.js';
const uri = process.env.MONGODB_URI;
if (!uri) {
    console.error('Missing MONGODB_URI. Create .env from .env.example or run Docker Compose.');
    process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
    const seeded = await seedDatabase();
    console.log(`[ComboRoute] Connected to MongoDB; seeded up to ${seeded.restaurants} restaurants, ${seeded.items} dishes`);
    const server = app.listen(port, '0.0.0.0', () => console.log(`[ComboRoute] http://localhost:${port}`));
    const shutdown = async () => { server.close(); await mongoose.disconnect(); process.exit(0); };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
}
catch (e) {
    console.error('Could not initialize application:', e);
    process.exit(1);
}
