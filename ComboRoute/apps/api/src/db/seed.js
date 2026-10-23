import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { config as loadEnv } from 'dotenv';
import { AddressModel, RestaurantModel, MenuModel, CustomerModel } from '../models/index.js';
const dirnameHere = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(dirnameHere, '../../../../.env') });
// JSON lives alongside copied server JavaScript or in the source tree during development.
const seedPaths = [resolve(dirnameHere, 'seed-data.json'), resolve(process.cwd(), 'apps/api/src/db/seed-data.json'), resolve(process.cwd(), 'src/db/seed-data.json')];
async function data() { for (const path of seedPaths)
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch { } throw new Error('Seed data JSON not found'); }
export async function seedDatabase() {
    const d = await data();
    // Upsert only immutable seed identities. Existing operational changes and menu prices stay intact.
    await CustomerModel.updateOne({ id: 1 }, { $setOnInsert: { id: 1, name: 'Demo Foodie', email: 'demo@comboroute.local' } }, { upsert: true });
    for (const a of d.addresses)
        await AddressModel.updateOne({ id: a.id }, { $setOnInsert: a }, { upsert: true });
    for (const r of d.restaurants)
        await RestaurantModel.updateOne({ id: r.id }, { $setOnInsert: r }, { upsert: true });
    for (const m of d.menu)
        await MenuModel.updateOne({ id: m.id }, { $setOnInsert: m }, { upsert: true });
    return { restaurants: d.restaurants.length, items: d.menu.length, addresses: d.addresses.length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const uri = process.env.MONGODB_URI;
    if (!uri)
        throw new Error('MONGODB_URI must be set');
    mongoose.connect(uri).then(seedDatabase).then(console.log).finally(() => mongoose.disconnect()).catch(e => { console.error(e); process.exitCode = 1; });
}
