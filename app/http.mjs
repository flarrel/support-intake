import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTicket, getTicket, listTickets, reviewTicket } from './database.mjs';
import { HttpError, maxTextLength, parseReview, parseTicket, readJson } from './validation.mjs';

const publicDirectory = new URL('../public/', import.meta.url);
const contentTypes = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['svg', 'image/svg+xml'],
]);
const allowedStatus = new Set(['review', 'routed']);
const loopback = new Set(['127.0.0.1', 'localhost']);

function send(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

async function serveFile(response, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^[a-zA-Z0-9_-]+\.[a-z]+$/.test(file)) throw new HttpError(404, 'Not found.');
  const contentType = contentTypes.get(file.split('.').at(-1));
  if (!contentType) throw new HttpError(404, 'Not found.');
  let body;
  try {
    body = await readFile(new URL(file, publicDirectory));
  } catch (error) {
    if (error.code === 'ENOENT') throw new HttpError(404, 'Not found.');
    throw error;
  }
  response.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

async function infer(model, tempDirectory, input) {
  let directory;
  try {
    let payload = { text: input.text };
    if (input.source === 'image') {
      directory = await mkdtemp(join(tempDirectory, 'screenshot-'));
      const imagePath = join(directory, `upload.${input.extension}`);
      await writeFile(imagePath, input.image, { mode: 0o600 });
      payload = { imagePath };
    }
    let result;
    try {
      result = await model.predict(payload);
    } catch {
      throw new HttpError(503, 'Inference is unavailable. Please retry.');
    }
    if (result.error) {
      if (result.code === 'INVALID_IMAGE') {
        throw new HttpError(422, 'The screenshot could not be read.');
      }
      throw new HttpError(503, 'Inference failed. Please retry.');
    }
    if (typeof result.text !== 'string' || typeof result.needsReview !== 'boolean'
      || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) {
      throw new HttpError(503, 'Inference returned an invalid result.');
    }
    // The confidence cutoff is fitted on typed text. Screenshot predictions require confirmation.
    return {
      ...result,
      text: result.text.replaceAll('\0', '').slice(0, maxTextLength),
      source: input.source,
      needsReview: result.needsReview || input.source === 'image',
    };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export function createApp({ pool, model, intents, tempDirectory }) {
  const knownIntents = new Set(intents);
  return createServer({ requestTimeout: 60_000, headersTimeout: 15_000 }, async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const host = request.headers.host;
      if (!host || !/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host)) {
        throw new HttpError(403, 'Use the local application address.');
      }
      const origin = new URL(`http://${host}/`);
      if (!loopback.has(origin.hostname) || origin.username || origin.password
          || (request.headers.origin && request.headers.origin !== origin.origin)) {
        throw new HttpError(403, 'Use the local application address.');
      }
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new HttpError(400, 'Invalid path.');
      const url = new URL(request.url, origin);
      const { pathname } = url;
      if (request.method === 'GET' && pathname === '/health') {
        if (!model.available) throw new HttpError(503, 'Inference is unavailable.');
        await pool.query('SELECT 1');
        send(response, 200, { status: 'ok' });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/intents') {
        send(response, 200, { intents });
        return;
      }
      if (pathname === '/api/tickets') {
        if (request.method === 'GET') {
          const status = url.searchParams.get('status');
          if (status !== null && !allowedStatus.has(status)) throw new HttpError(400, 'Unknown status.');
          send(response, 200, { tickets: await listTickets(pool, status) });
          return;
        }
        if (request.method === 'POST') {
          const result = await infer(model, tempDirectory, parseTicket(await readJson(request)));
          if (!knownIntents.has(result.intent) && !(result.intent === null && result.needsReview)) {
            throw new HttpError(503, 'Inference returned an unknown intent.');
          }
          send(response, 201, { ticket: await createTicket(pool, result) });
          return;
        }
      }
      const match = /^\/api\/tickets\/([1-9]\d*)$/.exec(pathname);
      if (match) {
        const id = Number(match[1]);
        if (!Number.isInteger(id) || id > 2147483647) throw new HttpError(404, 'Ticket not found.');
        if (request.method === 'GET') {
          const result = await getTicket(pool, id);
          if (!result) throw new HttpError(404, 'Ticket not found.');
          send(response, 200, result);
          return;
        }
        if (request.method === 'PATCH') {
          const input = parseReview(await readJson(request), knownIntents);
          const result = await reviewTicket(pool, id, input);
          if (result.missing) throw new HttpError(404, 'Ticket not found.');
          if (result.conflict) throw new HttpError(409, 'This ticket changed. Reload it and try again.');
          send(response, 200, { ticket: result.ticket });
          return;
        }
      }
      if (request.method === 'GET' && !pathname.startsWith('/api/')) {
        await serveFile(response, pathname);
        return;
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('Request failed:', error.code ?? error.name);
      if (!response.headersSent && !response.destroyed) {
        send(response, error instanceof HttpError ? error.status : 500,
          { error: error instanceof HttpError ? error.message : 'Request failed.' });
      }
    }
  });
}
