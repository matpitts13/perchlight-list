// Runs tasks with at most `maxParallel` in flight, starting at most
// `requestsPerSecond` per second, until they're done, `deadline` passes, or
// shouldStop() says so. A task that throws is reported to onError and never
// stops the others. Returns how many tasks were started.

/**
 * @param {Array<() => Promise<void>>} tasks
 * @param {{ maxParallel: number, requestsPerSecond: number, deadline: number,
 *           shouldStop: () => boolean, onError: (err: unknown) => void }} opts
 */
export async function runPaced(tasks, { maxParallel, requestsPerSecond, deadline, shouldStop, onError }) {
  const gap = 1000 / requestsPerSecond;
  const running = new Set();
  let started = 0;
  let nextStart = Date.now();

  for (const task of tasks) {
    if (shouldStop() || Date.now() >= deadline) break;
    while (running.size >= maxParallel) await Promise.race(running);
    if (shouldStop()) break;
    const wait = nextStart - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (shouldStop() || Date.now() >= deadline) break;
    nextStart = Date.now() + gap;

    const p = Promise.resolve()
      .then(task)
      .catch(onError)
      .finally(() => running.delete(p));
    running.add(p);
    started++;
  }
  await Promise.all(running);
  return started;
}
