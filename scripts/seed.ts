import 'dotenv/config';
import { createPool, seed } from '../server/db.js';
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL first.');
if (process.env.NODE_ENV === 'production')
  throw new Error('Fictional demo seed is disabled in production.');
const pool = createPool(process.env.DATABASE_URL);
try {
  await seed(pool);
  console.log(
    'Fictional accounts, products, and empty drafts are ready. Existing edits were preserved.',
  );
} finally {
  await pool.end();
}
