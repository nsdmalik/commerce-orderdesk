import 'dotenv/config';
import express from 'express';
import { resolve } from 'node:path';
import { createPool, migrate } from './db.js';
import { createApp } from './app.js';
if (!process.env.DATABASE_URL)
  throw new Error('Set DATABASE_URL before starting. See .env.example.');
const pool = createPool(process.env.DATABASE_URL);
await migrate(pool);
const port = Number(process.env.PORT || 8084);
const app = createApp(pool, [
  process.env.APP_ORIGIN || 'http://127.0.0.1:5177',
  `http://127.0.0.1:${port}`,
]);
app.use(express.static(resolve('dist')));
const server = app.listen(port, '127.0.0.1', () =>
  console.log(`Orderdesk API: http://127.0.0.1:${port}`),
);
async function stop() {
  server.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
