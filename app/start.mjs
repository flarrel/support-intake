import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, migrate } from './database.mjs';
import { createApp } from './http.mjs';
import { openModel } from './model.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = resolve(process.env.SUPPORT_RUNTIME ?? join(root, '..', 'runtime'));
const modelRuntime = resolve(process.env.SUPPORT_MODEL_RUNTIME ?? runtime);
const python = process.env.SUPPORT_PYTHON ?? join(modelRuntime, 'venv', 'bin', 'python');

function port(variable, defaultValue) {
  const value = Number(process.env[variable] ?? defaultValue);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid ${variable}.`);
  return value;
}

const appPort = port('SUPPORT_PORT', 4317);
const dbPort = port('SUPPORT_DB_PORT', 54327);
const tempDirectory = join(runtime, 'tmp');
await mkdir(tempDirectory, { recursive: true, mode: 0o700 });
process.env.TMPDIR = tempDirectory;

const database = await openDatabase(runtime, dbPort);
let model;
let server;
let shutdown;

function close() {
  shutdown ??= (async () => {
    model?.close();
    if (server?.listening) {
      await new Promise((resolveClose) => {
        server.close(resolveClose);
        server.closeAllConnections();
      });
    }
    await database.close();
  })();
  return shutdown;
}

try {
  await migrate(database.pool);
  if (process.argv.includes('--migrate-only')) {
    console.log('Migrations applied.');
    await close();
  } else {
    model = openModel({ python, root, runtime, modelRuntime });
    const intents = await model.ready;
    server = createApp({ pool: database.pool, model, intents, tempDirectory });
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(appPort, '127.0.0.1', resolveListen);
    });
    console.log(`Support Intake listening at http://127.0.0.1:${appPort}`);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        close().catch((error) => {
          console.error('Shutdown failed:', error.message);
          process.exitCode = 1;
        });
      });
    }
  }
} catch (error) {
  await close();
  throw error;
}
