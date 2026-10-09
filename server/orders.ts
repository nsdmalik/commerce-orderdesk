import type pg from 'pg';
import { z } from 'zod';
import type { User, Order, Product, Workspace, Line } from '../shared/types.js';
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const saveSchema = z
  .object({
    version: z.number().int().nonnegative(),
    lines: z
      .array(
        z
          .object({ sku: z.string().min(1).max(40), quantity: z.number().int().min(1).max(10000) })
          .strict(),
      )
      .max(50),
  })
  .strict();
const versionSchema = z.object({ version: z.number().int().nonnegative() }).strict();
export function mapOrder(row: any): Order {
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name,
    currency: row.currency,
    version: row.version,
    status: row.status,
    total: Number(row.total),
    lines: row.lines,
    updatedAt: row.updated_at.toISOString(),
  };
}
export async function workspace(pool: pg.Pool, user: User): Promise<Workspace> {
  if (user.role === 'buyer' && !user.accountId)
    throw new AppError(403, 'account_required', 'A buyer account assignment is required.');
  const ordersResult = await pool.query(
    `SELECT o.*,a.name account_name FROM orders o JOIN accounts a ON a.id=o.account_id WHERE ($1::text IS NULL OR o.account_id=$1) ORDER BY a.name`,
    [user.role === 'operations' ? null : user.accountId],
  );
  const catalogResult = await pool.query(
    'SELECT p.*,r.cents FROM products p JOIN prices r ON r.sku=p.sku WHERE r.region=$1 ORDER BY p.name',
    [user.region || 'CA'],
  );
  const eventResult = await pool.query(
    `SELECT e.*,u.name actor_name FROM events e JOIN users u ON u.id=e.actor WHERE ($1::text IS NULL OR e.account_id=$1) ORDER BY e.id DESC LIMIT 12`,
    [user.role === 'operations' ? null : user.accountId],
  );
  const campaign = await pool.query('SELECT is_open FROM campaign WHERE id=1');
  const orders = ordersResult.rows.map(mapOrder);
  return {
    user,
    catalog: catalogResult.rows.map((r) => ({
      sku: r.sku,
      name: r.name,
      description: r.description,
      packSize: r.pack_size,
      cents: r.cents,
    })),
    order: user.role === 'buyer' ? orders[0] || null : null,
    orders: user.role === 'operations' ? orders : [],
    events: eventResult.rows.map((r) => ({
      id: Number(r.id),
      actor: r.actor_name,
      kind: r.kind,
      createdAt: r.created_at.toISOString(),
      orderId: r.order_id,
    })),
    campaignOpen: campaign.rows[0].is_open,
  };
}
async function transaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
async function lockOrder(client: pg.PoolClient, user: User, id: string, version: number) {
  if (user.role !== 'buyer')
    throw new AppError(403, 'forbidden', 'Only buyers can edit their orders.');
  const result = await client.query(
    'SELECT * FROM orders WHERE id=$1 AND account_id=$2 FOR UPDATE',
    [id, user.accountId],
  );
  const order = result.rows[0];
  if (!order) throw new AppError(404, 'not_found', 'Order not found.');
  if (order.version !== version)
    throw new AppError(
      409,
      'stale_version',
      'This order changed in another session. Reload the latest draft before saving.',
    );
  if (order.status !== 'draft')
    throw new AppError(409, 'submitted', 'Submitted orders are read-only.');
  const campaign = await client.query('SELECT is_open FROM campaign WHERE id=1 FOR SHARE');
  if (!campaign.rows[0].is_open)
    throw new AppError(409, 'campaign_closed', 'The ordering window is closed.');
  return order;
}
async function currentCatalog(client: pg.PoolClient, user: User): Promise<Product[]> {
  const r = await client.query(
    'SELECT p.*,r.cents FROM products p JOIN prices r ON r.sku=p.sku WHERE r.region=$1 FOR SHARE OF r',
    [user.region],
  );
  return r.rows.map((r) => ({
    sku: r.sku,
    name: r.name,
    description: r.description,
    packSize: r.pack_size,
    cents: r.cents,
  }));
}
function priceLines(input: { sku: string; quantity: number }[], catalog: Product[]): Line[] {
  if (new Set(input.map((l) => l.sku)).size !== input.length)
    throw new AppError(422, 'duplicate_sku', 'Each product can appear once.');
  return input.map((line) => {
    const product = catalog.find((p) => p.sku === line.sku);
    if (!product)
      throw new AppError(422, 'unknown_sku', 'A product is not available in this catalog.');
    if (line.quantity % product.packSize !== 0)
      throw new AppError(
        422,
        'pack_size',
        `${product.name} must be ordered in multiples of ${product.packSize}.`,
      );
    return { sku: line.sku, name: product.name, quantity: line.quantity, cents: product.cents };
  });
}
export async function saveOrder(pool: pg.Pool, user: User, id: string, body: unknown) {
  const input = saveSchema.parse(body);
  await transaction(pool, async (client) => {
    await lockOrder(client, user, id, input.version);
    const lines = priceLines(input.lines, await currentCatalog(client, user));
    const total = lines.reduce((sum, l) => sum + l.cents * l.quantity, 0);
    await client.query(
      'UPDATE orders SET lines=$1,total=$2,version=version+1,updated_at=now() WHERE id=$3',
      [JSON.stringify(lines), total, id],
    );
    await client.query(
      "INSERT INTO events(actor,account_id,order_id,kind) VALUES ($1,$2,$3,'draft.saved')",
      [user.id, user.accountId, id],
    );
  });
}
export async function submitOrder(pool: pg.Pool, user: User, id: string, body: unknown) {
  const { version } = versionSchema.parse(body);
  await transaction(pool, async (client) => {
    const order = await lockOrder(client, user, id, version);
    if (!order.lines.length)
      throw new AppError(
        422,
        'empty_order',
        'Add a product and save your draft before submitting.',
      );
    const lines = priceLines(order.lines, await currentCatalog(client, user));
    if (lines.some((line, i) => line.cents !== order.lines[i].cents))
      throw new AppError(
        409,
        'price_changed',
        'Catalog prices changed. Review and save the current prices before submitting.',
      );
    await client.query(
      "UPDATE orders SET status='submitted',version=version+1,updated_at=now() WHERE id=$1",
      [id],
    );
    await client.query(
      "INSERT INTO events(actor,account_id,order_id,kind) VALUES ($1,$2,$3,'order.submitted')",
      [user.id, user.accountId, id],
    );
  });
}
export async function setCampaign(pool: pg.Pool, user: User, body: unknown) {
  if (user.role !== 'operations')
    throw new AppError(403, 'forbidden', 'Operations access is required.');
  const input = z.object({ open: z.boolean() }).strict().parse(body);
  await transaction(pool, async (client) => {
    await client.query('UPDATE campaign SET is_open=$1 WHERE id=1', [input.open]);
    await client.query('INSERT INTO events(actor,kind) VALUES ($1,$2)', [
      user.id,
      input.open ? 'campaign.opened' : 'campaign.closed',
    ]);
  });
}
export async function changePrice(pool: pg.Pool, user: User, body: unknown) {
  if (user.role !== 'operations')
    throw new AppError(403, 'forbidden', 'Operations access is required.');
  const input = z
    .object({
      sku: z.string().min(1),
      region: z.enum(['CA', 'US']),
      cents: z.number().int().min(1).max(1000000),
    })
    .strict()
    .parse(body);
  await transaction(pool, async (client) => {
    const r = await client.query(
      'UPDATE prices SET cents=$1 WHERE sku=$2 AND region=$3 RETURNING sku',
      [input.cents, input.sku, input.region],
    );
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Regional price not found.');
    await client.query("INSERT INTO events(actor,kind) VALUES ($1,'price.updated')", [user.id]);
  });
}
