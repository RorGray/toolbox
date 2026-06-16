// JSON-file backed store. Human-readable on purpose: you can hand-edit
// /data/tools.json and the app will pick it up on next read. Writes are
// atomic (temp file + rename) and serialised through a tiny promise queue
// so the web UI and a stray editor don't corrupt each other.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

let writeChain = Promise.resolve();

const newId = () => crypto.randomBytes(8).toString('hex');

async function ensureFile() {
  await fs.mkdir(path.dirname(config.dataFile), { recursive: true });
  try {
    await fs.access(config.dataFile);
  } catch {
    await atomicWrite({ tools: [] });
  }
}

async function atomicWrite(data) {
  const tmp = `${config.dataFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  const RETRIES = 4;
  for (let i = 0; i < RETRIES; i++) {
    try {
      await fs.rename(tmp, config.dataFile);
      return;
    } catch (err) {
      const transient = err.code === 'EPERM' || err.code === 'EBUSY';
      if (!transient || i === RETRIES - 1) {
        await fs.unlink(tmp).catch(() => {});
        throw err;
      }
      await new Promise((r) => setTimeout(r, 25 * 2 ** i)); // 25 50 100 200 ms
    }
  }
}

export async function readAll() {
  await ensureFile();
  const raw = await fs.readFile(config.dataFile, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`tools.json is not valid JSON: ${err.message}`);
  }
  const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
  return tools;
}

// Run a mutation against the whole list under the write lock. The mutator
// receives the current array and returns the new array (or a value to return
// alongside it via { tools, result }).
function mutate(fn) {
  const run = async () => {
    const current = await readAll();
    const out = await fn(current);
    const nextTools = Array.isArray(out) ? out : out.tools;
    await atomicWrite({ tools: nextTools });
    return Array.isArray(out) ? undefined : out.result;
  };
  // Chain so writes never overlap. Errors don't break the chain for the next caller.
  const next = writeChain.then(run, run);
  writeChain = next.catch(() => {});
  return next;
}

const ALLOWED = ['name', 'url', 'description', 'category', 'tags', 'iconFile'];

function clean(input) {
  const out = {};
  for (const key of ALLOWED) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  if (typeof out.name === 'string') out.name = out.name.trim();
  if (typeof out.url === 'string') out.url = out.url.trim();
  if (typeof out.category === 'string') out.category = out.category.trim();
  if (typeof out.tags === 'string') {
    out.tags = out.tags.split(',').map((t) => t.trim()).filter(Boolean);
  }
  return out;
}

export async function createTool(input) {
  const fields = clean(input);
  if (!fields.name) throw httpError(400, 'A name is required.');
  if (!fields.url) throw httpError(400, 'A URL is required.');
  const tool = {
    id: newId(),
    name: fields.name,
    url: fields.url,
    description: fields.description || '',
    category: fields.category || 'Uncategorised',
    tags: fields.tags || [],
    iconFile: fields.iconFile || null,
    health: { status: 'unknown', httpStatus: null, checkedAt: null },
    createdAt: new Date().toISOString(),
  };
  await mutate((tools) => [...tools, tool]);
  return tool;
}

export async function updateTool(id, input) {
  const fields = clean(input);
  return mutate((tools) => {
    const idx = tools.findIndex((t) => t.id === id);
    if (idx === -1) throw httpError(404, 'No tool with that id.');
    const updated = { ...tools[idx], ...fields, id };
    const next = [...tools];
    next[idx] = updated;
    return { tools: next, result: updated };
  });
}

export async function deleteTool(id) {
  return mutate((tools) => {
    const tool = tools.find((t) => t.id === id);
    if (!tool) throw httpError(404, 'No tool with that id.');
    return { tools: tools.filter((t) => t.id !== id), result: tool };
  });
}

// Used by the health pinger to persist results without racing the UI.
export async function patchHealth(id, health) {
  return mutate((tools) => {
    const idx = tools.findIndex((t) => t.id === id);
    if (idx === -1) return tools; // tool deleted mid-check; ignore
    const next = [...tools];
    next[idx] = { ...next[idx], health };
    return next;
  });
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
