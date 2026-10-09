import express, { type Request, type Response, type NextFunction } from 'express';
import type pg from 'pg';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { User } from '../shared/types.js';
import { AppError, workspace, saveOrder, submitOrder, setCampaign, changePrice } from './orders.js';
export function createApp(
  pool: pg.Pool,
  origins = ['http://127.0.0.1:5177', 'http://127.0.0.1:8084'],
) {
  const app = express();
  app.disable('x-powered-by');
  const secure = process.env.NODE_ENV === 'production';
  const cookie = (token: string, age: number) =>
    `orderdesk_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const fingerprint = (token: string) => createHash('sha256').update(token).digest('hex');
  const attempts = new Map<string, { count: number; until: number }>();
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use('/api', (req, res, next) => {
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      (!origins.includes(req.get('origin') || '') || !req.is('application/json'))
    )
      return res
        .status(403)
        .json({ error: 'A same-origin JSON request is required.', code: 'request_origin' });
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  const auth = async (req: Request, res: Response, next: NextFunction) => {
    const token = req
      .get('cookie')
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('orderdesk_session='))
      ?.split('=')[1];
    if (!token || !/^[a-f0-9]{64}$/.test(token))
      throw new AppError(401, 'unauthorized', 'Please sign in.');
    const r = await pool.query(
      `SELECT u.id,u.name,u.role,u.account_id,a.name account_name,a.region,a.currency FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN accounts a ON a.id=u.account_id WHERE s.token_hash=$1 AND s.expires_at>now()`,
      [fingerprint(token)],
    );
    if (!r.rows[0])
      throw new AppError(401, 'unauthorized', 'Your session expired. Please sign in.');
    const u = r.rows[0];
    res.locals.user = {
      id: u.id,
      name: u.name,
      role: u.role,
      accountId: u.account_id,
      accountName: u.account_name,
      region: u.region,
      currency: u.currency,
    } satisfies User;
    res.locals.tokenHash = fingerprint(token);
    next();
  };
  app.post('/api/login', async (req, res) => {
    const input = z
      .object({ email: z.string().email().max(200), password: z.string().min(1).max(200) })
      .strict()
      .parse(req.body);
    const key = req.ip || 'local';
    const now = Date.now();
    for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
    const attempt = attempts.get(key) || { count: 0, until: now + 60000 };
    attempt.count++;
    attempts.set(key, attempt);
    if (attempt.count > 20)
      throw new AppError(429, 'rate_limit', 'Too many sign-in attempts. Try again in a minute.');
    const result = await pool.query('SELECT * FROM users WHERE email=$1', [
      input.email.toLowerCase(),
    ]);
    const user = result.rows[0];
    const digest = scryptSync(input.password, user?.salt || 'missing-account-salt', 64);
    if (!user || !timingSafeEqual(digest, Buffer.from(user.password_hash, 'hex')))
      throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect.');
    const token = randomBytes(32).toString('hex');
    await pool.query('DELETE FROM sessions WHERE expires_at<=now()');
    await pool.query("INSERT INTO sessions VALUES ($1,$2,now()+interval '8 hours')", [
      fingerprint(token),
      user.id,
    ]);
    res.setHeader('Set-Cookie', cookie(token, 8 * 60 * 60));
    res.json({ ok: true });
  });
  app.use('/api', auth);
  app.get('/api/workspace', async (_req, res) => res.json(await workspace(pool, res.locals.user)));
  app.post('/api/logout', async (_req, res) => {
    await pool.query('DELETE FROM sessions WHERE token_hash=$1', [res.locals.tokenHash]);
    res.setHeader('Set-Cookie', cookie('', 0));
    res.json({ ok: true });
  });
  app.put('/api/orders/:id', async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success)
      throw new AppError(404, 'not_found', 'Order not found.');
    await saveOrder(pool, res.locals.user, req.params.id as string, req.body);
    res.json(await workspace(pool, res.locals.user));
  });
  app.post('/api/orders/:id/submit', async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success)
      throw new AppError(404, 'not_found', 'Order not found.');
    await submitOrder(pool, res.locals.user, req.params.id as string, req.body);
    res.json(await workspace(pool, res.locals.user));
  });
  app.put('/api/campaign', async (req, res) => {
    await setCampaign(pool, res.locals.user, req.body);
    res.json(await workspace(pool, res.locals.user));
  });
  app.put('/api/prices', async (req, res) => {
    await changePrice(pool, res.locals.user, req.body);
    res.json(await workspace(pool, res.locals.user));
  });
  app.use('/api', (_req, res) =>
    res.status(404).json({ error: 'Route not found.', code: 'not_found' }),
  );
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError)
      return res
        .status(422)
        .json({ error: 'Check the request fields, quantities, and version.', code: 'validation' });
    if (error instanceof AppError)
      return res.status(error.status).json({ error: error.message, code: error.code });
    if (error && typeof error === 'object' && 'status' in error && error.status === 413)
      return res.status(413).json({ error: 'The request is too large.', code: 'request_size' });
    if (error instanceof SyntaxError)
      return res.status(400).json({ error: 'Invalid JSON request.', code: 'invalid_json' });
    console.error(error);
    res.status(500).json({ error: 'The request could not be completed.', code: 'server_error' });
  });
  return app;
}
