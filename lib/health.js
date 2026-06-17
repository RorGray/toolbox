// Background health pinger.
//
// The tools sit behind Authentik too, and this app's server has no Authentik
// session. So a request to a tool typically gets a 302 redirect to the login
// page rather than the tool itself. We therefore define "up" as a successful
// or redirect response (status < 400). A connection failure, DNS failure,
// timeout, or 4xx/5xx response counts as down.

import { config } from './config.js';
import { readAll, patchHealth } from './store.js';

let timer = null;
let running = false;

async function pingOne(tool) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.healthTimeoutMs);
  try {
    const res = await fetch(tool.url, {
      method: 'HEAD',
      redirect: 'manual', // a 302 to Authentik is still "reachable"
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Toolbox/1.0 (+healthcheck)' },
    });
    if (res.status >= 400) {
      return { status: 'down', httpStatus: res.status, checkedAt: new Date().toISOString() };
    }
    return { status: 'up', httpStatus: res.status, checkedAt: new Date().toISOString() };
  } catch (err) {
    // Some servers reject HEAD; retry once with GET before declaring down.
    if (err?.name !== 'AbortError') {
      const retry = await tryGet(tool.url);
      if (retry) return retry;
    }
    return { status: 'down', httpStatus: null, checkedAt: new Date().toISOString() };
  } finally {
    clearTimeout(t);
  }
}

async function tryGet(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.healthTimeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Toolbox/1.0 (+healthcheck)' },
    });
    const status = res.status >= 400 ? 'down' : 'up';
    return { status, httpStatus: res.status, checkedAt: new Date().toISOString() };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function sweep() {
  if (running) return;
  running = true;
  try {
    const tools = await readAll();
    // Check concurrently but in modest batches to avoid hammering.
    const batchSize = 8;
    for (let i = 0; i < tools.length; i += batchSize) {
      const batch = tools.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (tool) => ({ id: tool.id, health: await pingOne(tool) }))
      );
      for (const { id, health } of results) {
        await patchHealth(id, health);
      }
    }
  } catch (err) {
    console.error('[health] sweep failed:', err.message);
  } finally {
    running = false;
  }
}

export function startHealthChecks() {
  if (timer) return;
  // First sweep shortly after boot, then on the configured interval.
  setTimeout(sweep, 3000);
  timer = setInterval(sweep, config.healthIntervalMs);
  console.log(`[health] pinging every ${config.healthIntervalMs}ms`);
}

// Exposed so an admin can force an immediate re-check from the UI.
export async function checkNow() {
  await sweep();
}
