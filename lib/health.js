// Background health pinger.
//
// The tools sit behind Authentik too, and this app's server has no Authentik
// session, so a request to a tool typically gets a redirect to a login page
// rather than the tool itself. We have no way to authenticate that request,
// so a redirect only tells us the gate in front of the tool answered — not
// whether the tool behind it is actually up. We still count that as
// "reachable" (the gate is a real, working part of the stack), but attach a
// note so the UI can flag that the real status behind it is unconfirmed. A
// genuine failure — no response at all (connection/DNS failure, timeout) or
// an explicit 4xx/5xx — still means down; those aren't ambiguous.

import { config } from './config.js';
import { readAll, patchHealth } from './store.js';

let timer = null;
let running = false;

const REDIRECT_NOTE =
  "Got redirected (likely to a login page) instead of a response from the tool itself, so its real online status can't be confirmed without authenticating past the gate.";

// Classify a manual-redirect fetch response into a health record.
function classify(res) {
  const checkedAt = new Date().toISOString();
  if (res.status >= 400) {
    return { status: 'down', httpStatus: res.status, checkedAt };
  }
  if (res.status >= 300) {
    return { status: 'up', httpStatus: res.status, reason: REDIRECT_NOTE, checkedAt };
  }
  return { status: 'up', httpStatus: res.status, checkedAt };
}

async function pingOne(tool) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.healthTimeoutMs);
  try {
    const res = await fetch(tool.url, {
      method: 'HEAD',
      redirect: 'manual', // don't follow — a redirect to a login page is the signal we want to see
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Toolbox/1.0 (+healthcheck)' },
    });
    return classify(res);
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
    return classify(res);
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
