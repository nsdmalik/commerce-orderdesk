import pg from 'pg';
import { randomBytes, scryptSync } from 'node:crypto';
export const schema = `
CREATE TABLE IF NOT EXISTS accounts(id text PRIMARY KEY, name text NOT NULL, region text NOT NULL, currency text NOT NULL);
CREATE TABLE IF NOT EXISTS users(id text PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL, role text NOT NULL CHECK(role IN ('buyer','operations')), account_id text REFERENCES accounts, salt text NOT NULL, password_hash text NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS products(sku text PRIMARY KEY, name text NOT NULL, description text NOT NULL, pack_size integer NOT NULL CHECK(pack_size>0));
CREATE TABLE IF NOT EXISTS prices(sku text NOT NULL REFERENCES products, region text NOT NULL, cents integer NOT NULL CHECK(cents>0), PRIMARY KEY(sku,region));
CREATE TABLE IF NOT EXISTS campaign(id integer PRIMARY KEY CHECK(id=1), is_open boolean NOT NULL);
CREATE TABLE IF NOT EXISTS orders(id uuid PRIMARY KEY, account_id text NOT NULL UNIQUE REFERENCES accounts, currency text NOT NULL, version integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted')), total bigint NOT NULL DEFAULT 0, lines jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS events(id bigserial PRIMARY KEY, actor text NOT NULL REFERENCES users(id), account_id text REFERENCES accounts, order_id uuid REFERENCES orders, kind text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS events_account_time ON events(account_id,created_at);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);`;
export function createPool(url: string) {
  return new pg.Pool({ connectionString: url, max: 6 });
}
export async function migrate(pool: pg.Pool) {
  await pool.query(schema);
}
export async function seed(pool: pg.Pool) {
  await migrate(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO accounts VALUES ('north','North Studio Supply','CA','CAD'),('west','West Studio Supply','US','USD') ON CONFLICT DO NOTHING",
    );
    const people = [
      ['buyer-ca', 'buyer.ca@demo.invalid', 'Alex Chen', 'buyer', 'north'],
      ['buyer-us', 'buyer.us@demo.invalid', 'Jordan Lee', 'buyer', 'west'],
      ['ops', 'operations@demo.invalid', 'Morgan Blake', 'operations', null],
    ];
    for (const [id, email, name, role, account] of people) {
      const salt = randomBytes(16).toString('hex');
      const hash = scryptSync('orderdesk-demo', salt, 64).toString('hex');
      await client.query('INSERT INTO users VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [
        id,
        email,
        name,
        role,
        account,
        salt,
        hash,
      ]);
    }
    await client.query(
      `INSERT INTO products VALUES ('RIDGE','Ridge desk mat','A structured workspace essential.',6),('ORBIT','Orbit notebook','Everyday notes, neatly kept.',12),('FRAME','Frame storage case','Small objects, organized.',4) ON CONFLICT DO NOTHING`,
    );
    await client.query(
      "INSERT INTO prices VALUES ('RIDGE','CA',2400),('RIDGE','US',1800),('ORBIT','CA',1200),('ORBIT','US',900),('FRAME','CA',4800),('FRAME','US',3600) ON CONFLICT DO NOTHING",
    );
    await client.query('INSERT INTO campaign VALUES (1,true) ON CONFLICT DO NOTHING');
    await client.query(
      "INSERT INTO orders(id,account_id,currency) VALUES ('00000000-0000-4000-8000-000000000001','north','CAD'),('00000000-0000-4000-8000-000000000002','west','USD') ON CONFLICT DO NOTHING",
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
