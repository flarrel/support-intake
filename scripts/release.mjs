import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const runtime = resolve(process.env.SUPPORT_RUNTIME ?? join(repo, '../runtime'));
const modelRuntime = resolve(process.env.SUPPORT_MODEL_RUNTIME ?? runtime);
const python = resolve(process.env.SUPPORT_PYTHON ?? join(modelRuntime, 'venv', 'bin', 'python'));
const releaseRoot = join(runtime, 'releases');
const pointer = join(releaseRoot, 'active.json');
const port = process.env.SUPPORT_RELEASE_PORT ?? '4318';
const dbPort = process.env.SUPPORT_RELEASE_DB_PORT ?? '54328';
const url = `http://127.0.0.1:${port}`;
const injectFailure = process.argv.includes('--inject-smoke-failure');
const modelFiles = ['model.pt', 'model-metadata.json'];
const toolEnvironment = {
  ...process.env, LC_ALL: 'C', COPYFILE_DISABLE: '1', TMPDIR: join(runtime, 'tmp'),
  npm_config_cache: process.env.npm_config_cache ?? join(runtime, 'cache/npm'),
};

function run(binary, args, { cwd = repo, env = process.env, capture = false } = {}) {
  const result = spawnSync(binary, args, {
    cwd, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${binary} ${args.join(' ')} failed`);
  return result.stdout;
}

function releaseOptions(directory) {
  const app = join(directory, 'package');
  return {
    app,
    env: {
      ...process.env,
      SUPPORT_RUNTIME: join(directory, 'state'),
      SUPPORT_MODEL_RUNTIME: join(directory, 'model'),
      SUPPORT_PYTHON: python,
      SUPPORT_PORT: port,
      SUPPORT_DB_PORT: dbPort,
      TMPDIR: join(runtime, 'tmp'),
    },
  };
}

async function get(path) {
  const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(3_000) });
  assert.ok(response.ok, `GET ${path} failed with ${response.status}`);
  return response.json();
}

async function withRelease(directory, check) {
  const { app, env } = releaseOptions(directory);
  const child = spawn(process.execPath, ['app/start.mjs'], {
    cwd: app, env, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const output = createInterface({ input: child.stdout });
  let listening = false;
  output.on('line', (line) => {
    console.log(line);
    // A service already on this port must not satisfy this candidate's smoke check.
    if (line === `Support Intake listening at ${url}`) listening = true;
  });
  const done = new Promise((resolveExit) => {
    child.once('error', (error) => resolveExit(error));
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  try {
    const deadline = Date.now() + 60_000;
    let health;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
        throw new Error(`Release process exited before it was ready: ${JSON.stringify(await done)}`);
      }
      if (listening) {
        try {
          health = await get('/health');
          break;
        } catch {
          // The candidate may be starting its first connection.
        }
      }
      await delay(250);
    }
    assert.equal(health?.status, 'ok', 'Packaged app did not become ready');
    await check();
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const exited = await Promise.race([done, delay(10_000, undefined, { ref: false })]);
    if (exited === undefined) {
      child.kill('SIGKILL');
      await done;
      throw new Error('Release process did not shut down normally');
    }
  }
}

async function smoke({ inject = false } = {}) {
  const homepage = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  assert.ok(homepage.ok, 'Packaged homepage response failed');
  assert.match(await homepage.text(), /Support Intake/i);
  const catalog = await get('/api/intents');
  assert.equal(catalog.intents.length, 77);
  const response = await fetch(`${url}/api/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'I lost my card and need a replacement.' }),
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, inject ? 418 : 201,
    inject ? 'Injected smoke-test failure' : 'Packaged ticket intake failed');
  const { ticket } = await response.json();
  assert.ok(catalog.intents.includes(ticket.intent));
  const saved = await get(`/api/tickets/${ticket.id}`);
  assert.deepEqual(saved.ticket, ticket);
}

async function readActive() {
  try {
    return JSON.parse(await readFile(pointer, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function main() {
  await mkdir(releaseRoot, { recursive: true });
  await mkdir(join(runtime, 'tmp'), { recursive: true });
  const previous = await readActive();
  assert.ok(!injectFailure || previous, 'Promote a successful release before injecting a failure');

  const stage = await mkdtemp(join(releaseRoot, 'release-'));
  const version = stage.slice(releaseRoot.length + 1);
  let promoted = false;
  try {
    const npm = join(dirname(await realpath(process.execPath)), '../lib/node_modules/npm/bin/npm-cli.js');
    run(process.execPath, ['--test', 'test/validation.test.mjs']);
    const packed = run(process.execPath, [npm, 'pack', '--json', '--pack-destination', stage], {
      env: toolEnvironment,
      capture: true,
    });
    const [{ filename }] = JSON.parse(packed);
    const archive = join(stage, filename);
    run('tar', ['-xzf', archive, '-C', stage], { env: toolEnvironment });

    const { app, env } = releaseOptions(stage);
    // npm pack excludes package-lock.json. Include it in the release archive
    // before installing a pinned, candidate-local set of production dependencies.
    await copyFile(join(repo, 'package-lock.json'), join(app, 'package-lock.json'));
    run('tar', ['-czf', archive, '-C', stage, 'package'], { env: toolEnvironment });
    const digest = await sha256(archive);
    run(process.execPath, [npm, 'ci', '--offline', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: app, env: toolEnvironment,
    });
    const stageModel = env.SUPPORT_MODEL_RUNTIME;
    await mkdir(stageModel);
    const models = {};
    for (const file of modelFiles) {
      const target = join(stageModel, file);
      await copyFile(join(modelRuntime, file), target);
      models[file] = await sha256(target);
    }
    run(process.execPath, ['app/start.mjs', '--migrate-only'], { cwd: app, env });
    await withRelease(stage, () => smoke({ inject: injectFailure }));

    const nextPointer = join(stage, 'active.json');
    await writeFile(nextPointer, JSON.stringify({ version, filename, sha256: digest, models }) + '\n');
    await rename(nextPointer, pointer);
    promoted = true;
    console.log(`Promoted ${version} (${filename}, SHA-256 ${digest})`);
  } catch (error) {
    if (previous && !promoted) {
      assert.deepEqual(await readActive(), previous, 'Failed release changed the active pointer');
      await withRelease(join(releaseRoot, previous.version), smoke);
      console.error(`Previous release ${previous.version} is still active and passed smoke checks.`);
    }
    throw error;
  } finally {
    if (!promoted) await rm(stage, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
