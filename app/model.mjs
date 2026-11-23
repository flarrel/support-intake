import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function openModel({ python, root, runtime, modelRuntime }) {
  const child = spawn(python, ['-m', 'ml.worker'], {
    cwd: root,
    env: {
      ...process.env,
      SUPPORT_RUNTIME: runtime,
      SUPPORT_MODEL_RUNTIME: modelRuntime,
      PYTHONPYCACHEPREFIX: modelRuntime + '/pycache',
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = [];
  let failure;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const readyTimer = setTimeout(() => stop(new Error('Inference process did not start within 60 seconds.')), 60_000);

  function stop(error) {
    if (failure) return;
    failure = error;
    clearTimeout(readyTimer);
    rejectReady(error);
    for (const job of pending.splice(0)) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    child.kill();
  }

  child.on('error', stop);
  child.on('exit', (code) => stop(new Error(`Inference process exited (${code}).`)));
  child.stdin.on('error', stop);
  lines.on('line', (line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      stop(new Error('Invalid inference response.'));
      return;
    }
    if (value.ready === true && Array.isArray(value.labels)) {
      clearTimeout(readyTimer);
      resolveReady(value.labels);
      return;
    }
    const job = pending.shift();
    if (!job) {
      stop(new Error('Unexpected inference response.'));
      return;
    }
    clearTimeout(job.timer);
    job.resolve(value);
  });

  return {
    ready,
    get available() { return !failure; },
    predict(input) {
      if (failure) return Promise.reject(failure);
      if (pending.length >= 12) return Promise.reject(new Error('Inference queue is full.'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => stop(new Error('Inference exceeded its time limit.')), 45_000);
        pending.push({ resolve, reject, timer });
        child.stdin.write(JSON.stringify(input) + '\n');
      });
    },
    close() { stop(new Error('Inference process closed.')); },
  };
}
