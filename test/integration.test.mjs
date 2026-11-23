import assert from 'node:assert/strict';
import { test } from 'node:test';

const baseUrl = process.env.SUPPORT_BASE_URL ?? 'http://127.0.0.1:4317';

async function request(path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method: options.method,
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json() };
}

test('health and catalog expose a ready service', async () => {
  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');

  const catalog = await request('/api/intents');
  assert.equal(catalog.status, 200);
  const { intents } = catalog.body;
  assert.equal(intents.length, 77);
  assert.equal(new Set(intents).size, intents.length);
});

test('rejects malformed tickets and handles a missing ticket', async () => {
  const invalid = await request('/api/tickets', {
    method: 'POST',
    body: { text: '   ' },
  });
  assert.equal(invalid.status, 400);
  assert.equal(typeof invalid.body.error, 'string');

  const invalidImage = await request('/api/tickets', {
    method: 'POST',
    body: { image: Buffer.from('not a PNG').toString('base64'), mime: 'image/png' },
  });
  assert.equal(invalidImage.status, 400);
  assert.equal(typeof invalidImage.body.error, 'string');

  const truncatedImage = await request('/api/tickets', {
    method: 'POST',
    body: { image: 'iVBORw0KGgo=', mime: 'image/png' },
  });
  assert.equal(truncatedImage.status, 422);

  const missing = await request('/api/tickets/2147483647');
  assert.equal(missing.status, 404);
});

test('reviews an uncertain ticket exactly once across concurrent stale versions', async () => {
  const created = await request('/api/tickets', {
    method: 'POST',
    body: { text: 'zqxv blorf qqqzx fffjqp' },
  });
  assert.equal(created.status, 201);
  const { ticket } = created.body;
  assert.equal(ticket.source, 'text');
  assert.equal(ticket.status, 'review');

  const queue = await request('/api/tickets?status=review');
  assert.equal(queue.status, 200);
  assert.ok(queue.body.tickets.some((candidate) => candidate.id === ticket.id));

  const catalog = await request('/api/intents');
  const intent = catalog.body.intents.find((item) => item !== ticket.intent);
  const note = 'Reviewed the original support request.';
  const correction = {
    method: 'PATCH',
    body: { intent, version: ticket.version, note },
  };
  const attempts = await Promise.all([
    request(`/api/tickets/${ticket.id}`, correction),
    request(`/api/tickets/${ticket.id}`, correction),
  ]);
  assert.deepEqual(attempts.map(({ status }) => status).sort(), [200, 409]);

  const detail = await request(`/api/tickets/${ticket.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.ticket.status, 'routed');
  assert.equal(detail.body.ticket.intent, intent);
  assert.equal(detail.body.ticket.version, ticket.version + 1);
  assert.equal(detail.body.history.length, 1);
  assert.equal(detail.body.history[0].fromIntent, ticket.intent);
  assert.equal(detail.body.history[0].toIntent, intent);
  assert.equal(detail.body.history[0].note, note);
});

test('rolls back a ticket update when its review history insert fails', async () => {
  const { readFile } = await import('node:fs/promises');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { Client } = (await import('pg')).default;
  const runtime = process.env.SUPPORT_RUNTIME
    ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../runtime');
  const client = new Client({
    host: '127.0.0.1',
    port: Number(process.env.SUPPORT_DB_PORT ?? 54327),
    database: 'support_intake',
    user: 'support_intake',
    password: (await readFile(resolve(runtime, 'db-password'), 'utf8')).trim(),
  });
  const trigger = `support_test_history_failure_${process.pid}`;
  const note = `integration failure injection ${process.pid}`;
  await client.connect();
  try {
    await client.query(`
      CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.note = '${note}' THEN
          RAISE EXCEPTION 'integration test history write rejected';
        END IF;
        RETURN NEW;
      END
      $$;
    `);
    await client.query(`
      CREATE TRIGGER ${trigger}
      BEFORE INSERT ON ticket_reviews FOR EACH ROW
      EXECUTE FUNCTION ${trigger}();
    `);
    const created = await request('/api/tickets', {
      method: 'POST',
      body: { text: 'zqxv blorf qqqzx rollback' },
    });
    assert.equal(created.status, 201);
    const { ticket } = created.body;
    const { body: { intents } } = await request('/api/intents');
    const intent = intents.find((item) => item !== ticket.intent);
    const rejected = await request(`/api/tickets/${ticket.id}`, {
      method: 'PATCH',
      body: { intent, note, version: ticket.version },
    });
    assert.equal(rejected.status, 500);
    const unchanged = await request(`/api/tickets/${ticket.id}`);
    assert.deepEqual(unchanged.body, { ticket, history: [] });

    // A test database is small enough that its planner may prefer a sequential scan.
    // Check index eligibility explicitly without claiming it won the cost comparison.
    await client.query('SET enable_seqscan = off');
    const plan = await client.query(`
      EXPLAIN (FORMAT JSON)
      SELECT id FROM tickets
      WHERE status = 'review' ORDER BY created_at DESC, id DESC LIMIT 50
    `);
    assert.match(JSON.stringify(plan.rows), /tickets_review_queue/);
  } finally {
    try {
      await client.query(`DROP TRIGGER IF EXISTS ${trigger} ON ticket_reviews`);
      await client.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
    } finally {
      await client.end();
    }
  }
});
