import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dir, '../../..', '.env');
const result = dotenv.config({ path: envPath });
if (result.error) {
  console.warn(`[load-env] could not read ${envPath}: ${result.error.message}`);
}
