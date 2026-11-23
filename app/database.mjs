import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const database = 'support_intake';
const host = '127.0.0.1';

export async function openDatabase(runtime, port) {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const dataDir = join(runtime, 'pgdata');
  const passwordPath = join(runtime, 'db-password');
  try {
    await writeFile(passwordPath, randomBytes(24).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const password = (await readFile(passwordPath, 'utf8')).trim();
  const server = new EmbeddedPostgres({
    databaseDir: dataDir, user: database, password, port, persistent: true,
    authMethod: 'scram-sha-256',
    initdbFlags: ['--locale=C', '--encoding=UTF8'],
    postgresFlags: ['-h', host, '-k', ''],
    onLog: () => {},
    onError: (message) => console.error(message),
  });
  try {
    await readFile(join(dataDir, 'PG_VERSION'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await server.initialise();
  }
  await server.start();
  const options = { host, port, user: database, password, connectionTimeoutMillis: 5000 };
  const maintenance = new pg.Client({ ...options, database: 'postgres' });
  try {
    await maintenance.connect();
    if (!(await maintenance.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rowCount) {
      await maintenance.query('CREATE DATABASE support_intake');
    }
  } catch (error) {
    await server.stop();
    throw error;
  } finally {
    await maintenance.end();
  }
  const pool = new pg.Pool({ ...options, database, max: 6 });
  pool.on('error', (error) => console.error('Database connection error:', error.message));
  return {
    pool,
    async close() {
      await pool.end();
      await server.stop();
    },
  };
}

export async function migrate(pool) {
  const path = new URL('./migrations/', import.meta.url);
  const migrations = (await readdir(path)).filter((file) => /^\d+_[a-z_]+\.sql$/.test(file)).sort();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(431754327)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const name of migrations) {
      const sql = await readFile(new URL(name, path), 'utf8');
      const digest = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query('SELECT digest FROM schema_migrations WHERE name = $1', [name]);
      if (existing.rowCount) {
        if (existing.rows[0].digest !== digest) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, digest) VALUES ($1, $2)', [name, digest]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const ticketFields = `id, text, source, intent, confidence, status, version,
                      created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function listTickets(pool, status) {
  const filter = status ? 'WHERE status = $1' : '';
  const { rows } = await pool.query(`SELECT ${ticketFields} FROM tickets ${filter}
                                   ORDER BY created_at DESC, id DESC LIMIT 50`, status ? [status] : []);
  return rows;
}

export async function getTicket(pool, id) {
  const { rows } = await pool.query(
    `SELECT row_to_json(ticket) AS ticket, (
      SELECT COALESCE(json_agg(json_build_object(
        'fromIntent', from_intent, 'toIntent', to_intent, 'note', note,
        'createdAt', created_at
      ) ORDER BY id DESC), '[]'::json)
      FROM ticket_reviews WHERE ticket_id = ticket.id
    ) AS history FROM (SELECT ${ticketFields} FROM tickets WHERE id = $1) AS ticket`,
    [id],
  );
  const snapshot = rows[0];
  if (!snapshot) return null;
  const { ticket, history } = snapshot;
  ticket.createdAt = new Date(ticket.createdAt);
  ticket.updatedAt = new Date(ticket.updatedAt);
  for (const event of history) event.createdAt = new Date(event.createdAt);
  return snapshot;
}

export async function createTicket(pool, { text, source, intent, confidence, needsReview }) {
  const { rows } = await pool.query(`INSERT INTO tickets (text, source, intent, confidence, status)
    VALUES ($1, $2, $3, $4, $5) RETURNING ${ticketFields}`,
  [text, source, intent, confidence, needsReview ? 'review' : 'routed']);
  return rows[0];
}

export async function reviewTicket(pool, id, { intent, version, note }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [current] } = await client.query('SELECT intent, version FROM tickets WHERE id = $1 FOR UPDATE', [id]);
    if (!current || current.version !== version) {
      await client.query('ROLLBACK');
      return { missing: !current, conflict: Boolean(current) };
    }
    const { rows: [ticket] } = await client.query(`UPDATE tickets
      SET intent = $2, status = 'routed', updated_at = now(), version = version + 1
      WHERE id = $1 RETURNING ${ticketFields}`, [id, intent]);
    await client.query(`INSERT INTO ticket_reviews (ticket_id, from_intent, to_intent, note)
      VALUES ($1, $2, $3, $4)`, [id, current.intent, intent, note]);
    await client.query('COMMIT');
    return { ticket };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
