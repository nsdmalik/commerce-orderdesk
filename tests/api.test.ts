import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createPool, migrate, seed } from '../server/db';
import { createApp } from '../server/app';
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/orderdesk_test')
  throw new Error('TEST_DATABASE_URL must target the dedicated orderdesk_test database.');
const pool = createPool(url);
const origin = 'http://127.0.0.1:5177';
let app: ReturnType<typeof createApp>;
const north = '00000000-0000-4000-8000-000000000001';
const west = '00000000-0000-4000-8000-000000000002';
const body = (version = 0, quantity = 6) => ({ version, lines: [{ sku: 'RIDGE', quantity }] });
async function login(email = 'buyer.ca@demo.invalid') {
  const agent = request.agent(app);
  await agent
    .post('/api/login')
    .set('Origin', origin)
    .send({ email, password: 'orderdesk-demo' })
    .expect(200);
  return agent;
}
beforeAll(async () => {
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE sessions, events, orders, prices, products, users, accounts, campaign RESTART IDENTITY CASCADE',
  );
  await seed(pool);
  app = createApp(pool);
});
afterAll(async () => {
  await pool.end();
});
describe('HTTP boundaries and session identity', () => {
  it('requires a session to read the workspace', async () => {
    await request(app).get('/api/workspace').expect(401);
  });
  it('uses HttpOnly same-site cookies and never returns credentials', async () => {
    const response = await request(app)
      .post('/api/login')
      .set('Origin', origin)
      .send({ email: 'buyer.ca@demo.invalid', password: 'orderdesk-demo' })
      .expect(200);
    expect(response.body).toEqual({ ok: true });
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(response.headers['set-cookie'][0]).toContain('SameSite=Strict');
    const session = await pool.query('SELECT token_hash FROM sessions');
    expect(response.headers['set-cookie'][0]).not.toContain(session.rows[0].token_hash);
  });
  it('rejects wrong passwords and cross-origin writes', async () => {
    await request(app)
      .post('/api/login')
      .set('Origin', origin)
      .send({ email: 'buyer.ca@demo.invalid', password: 'wrong' })
      .expect(401);
    await request(app)
      .post('/api/login')
      .set('Origin', 'https://other.invalid')
      .send({ email: 'buyer.ca@demo.invalid', password: 'orderdesk-demo' })
      .expect(403);
  });
  it('invalidates logout and expired sessions', async () => {
    const a = await login();
    await a.get('/api/workspace').expect(200);
    await a.post('/api/logout').set('Origin', origin).send({}).expect(200);
    await a.get('/api/workspace').expect(401);
    const b = await login();
    await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second'");
    await b.get('/api/workspace').expect(401);
  });
  it('scopes regional prices, orders and activity to the signed-in account', async () => {
    const ca = await login();
    await ca
      .put('/api/orders/' + north)
      .set('Origin', origin)
      .send(body())
      .expect(200);
    const us = await login('buyer.us@demo.invalid');
    const response = await us.get('/api/workspace').expect(200);
    expect(response.body.order.id).toBe(west);
    expect(response.body.user.currency).toBe('USD');
    expect(response.body.catalog.find((p: any) => p.sku === 'RIDGE').cents).toBe(1800);
    expect(response.body.orders).toEqual([]);
    expect(response.body.events).toEqual([]);
    expect(response.headers['cache-control']).toBe('no-store');
    await us
      .put('/api/orders/' + north)
      .set('Origin', origin)
      .send(body(1))
      .expect(404);
  });
  it('denies operations controls to buyers', async () => {
    const a = await login();
    await a.put('/api/campaign').set('Origin', origin).send({ open: false }).expect(403);
    await a
      .put('/api/prices')
      .set('Origin', origin)
      .send({ sku: 'RIDGE', region: 'CA', cents: 1 })
      .expect(403);
  });
});
describe('Defensive request handling', () => {
  it('rejects an unassigned buyer instead of widening account scope', async () => {
    await pool.query("UPDATE users SET account_id=NULL WHERE id='buyer-ca'");
    const a = await login();
    const response = await a.get('/api/workspace').expect(403);
    expect(response.body.code).toBe('account_required');
  });
  it('rejects oversized JSON requests with a client error', async () => {
    const a = await login();
    await a
      .put('/api/orders/' + north)
      .set('Origin', origin)
      .send({ padding: 'a'.repeat(40000) })
      .expect(413);
  });
  it('rejects malformed JSON without exposing server details', async () => {
    await request(app)
      .post('/api/login')
      .set('Origin', origin)
      .set('Content-Type', 'application/json')
      .send('{broken')
      .expect(400);
  });
});

describe('Server-owned order rules', () => {
  it('prices an order on the server and records its version and event', async () => {
    const a = await login();
    const response = await a
      .put('/api/orders/' + north)
      .set('Origin', origin)
      .send(body())
      .expect(200);
    expect(response.body.order.total).toBe(14400);
    expect(response.body.order.version).toBe(1);
    expect(response.body.order.lines[0].cents).toBe(2400);
    expect(response.body.events[0].kind).toBe('draft.saved');
  });
  it('rejects client-supplied prices', async () => {
    const a = await login();
    await a
      .put('/api/orders/' + north)
      .set('Origin', origin)
      .send({ version: 0, lines: [{ sku: 'RIDGE', quantity: 6, cents: 1 }] })
      .expect(422);
    const result = await pool.query('SELECT version,total FROM orders WHERE id=$1', [north]);
    expect(result.rows[0].version).toBe(0);
    expect(Number(result.rows[0].total)).toBe(0);
  });
  it.each([-6, 6.5, 10001])('rejects invalid quantity %s', async (quantity) => {
    const a = await login();
    await a
      .put('/api/orders/' + north)
      .set('Origin', origin)
      .send(body(0, quantity))
      .expect(422);
  });
  it('enforces pack sizes, known SKUs and unique lines', async () => {
    const a = await login();
    await a
      .put('/api/orders/' + north)
      .set('Origin', origin)
      .send(body(0, 7))
      .expect(422);
    await a
      .put('/api/orders/' + north)
      .set('Origin', origin)
      .send({ version: 0, lines: [{ sku: 'UNKNOWN', quantity: 6 }] })
      .expect(422);
    await a
      .put('/api/orders/' + north)
      .set('Origin', origin)
      .send({
        version: 0,
        lines: [
          { sku: 'RIDGE', quantity: 6 },
          { sku: 'RIDGE', quantity: 6 },
        ],
      })
      .expect(422);
  });
  it('allows clearing a draft but rejects an empty submission', async () => {
    const a = await login();
    await a
      .put('/api/orders/' + north)
      .set('Origin', origin)
      .send(body())
      .expect(200);
    const response = await a
      .put('/api/orders/' + north)
      .set('Origin', origin)
      .send({ version: 1, lines: [] })
      .expect(200);
    expect(response.body.order.total).toBe(0);
    await a
      .post('/api/orders/' + north + '/submit')
      .set('Origin', origin)
      .send({ version: 2 })
      .expect(422);
  });
  it('allows only one of two simultaneous writes using the same version', async () => {
    const a = await login();
    const responses = await Promise.all([
      a
        .put('/api/orders/' + north)
        .set('Origin', origin)
        .send(body(0, 6)),
      a
        .put('/api/orders/' + north)
        .set('Origin', origin)
        .send(body(0, 12)),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const rows = await pool.query('SELECT version,total FROM orders WHERE id=$1', [north]);
    expect(rows.rows[0].version).toBe(1);
    expect([14400, 28800]).toContain(Number(rows.rows[0].total));
    expect((await pool.query('SELECT * FROM events')).rowCount).toBe(1);
  });
  it('rolls back the order change if its event cannot be written', async () => {
    const a = await login();
    await pool.query(
      "ALTER TABLE events ADD CONSTRAINT reject_saved_event CHECK (kind <> 'draft.saved')",
    );
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await a
        .put('/api/orders/' + north)
        .set('Origin', origin)
        .send(body())
        .expect(500);
      expect(result.body.error).toBe('The request could not be completed.');
      const rows = await pool.query('SELECT version,total,lines FROM orders WHERE id=$1', [north]);
      expect(rows.rows[0].version).toBe(0);
      expect(Number(rows.rows[0].total)).toBe(0);
      expect(rows.rows[0].lines).toEqual([]);
    } finally {
      await pool.query('ALTER TABLE events DROP CONSTRAINT reject_saved_event');
      quiet.mockRestore();
    }
  });
});
describe('Campaign and historical prices', () => {
  it('enforces a closed window on the server and preserves existing drafts', async () => {
    const ops = await login('operations@demo.invalid');
    await ops.put('/api/campaign').set('Origin', origin).send({ open: false }).expect(200);
    const a = await login();
    await a
      .put('/api/orders/' + north)
      .set('Origin', origin)
      .send(body())
      .expect(409);
    expect((await a.get('/api/workspace')).body.order.version).toBe(0);
    await ops.put('/api/campaign').set('Origin', origin).send({ open: true }).expect(200);
    await a
      .put('/api/orders/' + north)
      .set('Origin', origin)
      .send(body())
      .expect(200);
  });
  it('requires acknowledging changed prices and retains submitted terms', async () => {
    const a = await login();
    const ops = await login('operations@demo.invalid');
    await a
      .put('/api/orders/' + north)
      .set('Origin', origin)
      .send(body())
      .expect(200);
    await ops
      .put('/api/prices')
      .set('Origin', origin)
      .send({ sku: 'RIDGE', region: 'CA', cents: 2500 })
      .expect(200);
    const conflict = await a
      .post('/api/orders/' + north + '/submit')
      .set('Origin', origin)
      .send({ version: 1 })
      .expect(409);
    expect(conflict.body.code).toBe('price_changed');
    await a
      .put('/api/orders/' + north)
      .set('Origin', origin)
      .send(body(1))
      .expect(200);
    const submitted = await a
      .post('/api/orders/' + north + '/submit')
      .set('Origin', origin)
      .send({ version: 2 })
      .expect(200);
    expect(submitted.body.order.total).toBe(15000);
    expect(submitted.body.order.status).toBe('submitted');
    await ops
      .put('/api/prices')
      .set('Origin', origin)
      .send({ sku: 'RIDGE', region: 'CA', cents: 3000 })
      .expect(200);
    const latest = await a.get('/api/workspace');
    expect(latest.body.order.total).toBe(15000);
    expect(latest.body.order.lines[0].cents).toBe(2500);
    await a
      .put('/api/orders/' + north)
      .set('Origin', origin)
      .send(body(3))
      .expect(409);
  });
  it('keeps currencies separate in the operations workspace', async () => {
    const a = await login();
    const b = await login('buyer.us@demo.invalid');
    const ops = await login('operations@demo.invalid');
    await a
      .put('/api/orders/' + north)
      .set('Origin', origin)
      .send(body())
      .expect(200);
    await b
      .put('/api/orders/' + west)
      .set('Origin', origin)
      .send(body())
      .expect(200);
    const response = await ops.get('/api/workspace');
    expect(response.body.orders.map((o: any) => [o.currency, o.total]).sort()).toEqual([
      ['CAD', 14400],
      ['USD', 10800],
    ]);
    expect(response.body.events).toHaveLength(2);
  });
});
