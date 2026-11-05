import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load before importing the application: middleware reads configuration at import time.
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });
