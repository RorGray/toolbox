import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';

import { config } from './lib/config.js';
import { identity, requireProxy, requireAdmin } from './lib/auth.js';
import {
  readAll,
  createTool,
  updateTool,
  deleteTool,
  httpError,
} from './lib/store.js';
import {
  autoFetchFavicon,
  iconFromUrl,
  iconFromDataUrl,
  removeIcons,
} from './lib/icons.js';
import { startHealthChecks, checkNow } from './lib/health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: Math.ceil(config.maxIconBytes * 1.5) + 1024 }));

// Identity is attached for every request; the proxy gate runs on everything
// except the container's own healthcheck endpoint.
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(identity);
app.use(requireProxy);

// --- who am I (lets the UI show/hide edit controls) ---
app.get('/api/me', (req, res) => {
  res.json({ user: req.identity.user, isAdmin: req.identity.isAdmin });
});

// --- list ---
app.get('/api/tools', async (req, res, next) => {
  try {
    res.json({ tools: await readAll() });
  } catch (err) {
    next(err);
  }
});

// Resolve an icon for a freshly-saved tool based on the chosen mode.
async function applyIcon(tool, body) {
  const mode = body.iconMode || 'auto';
  if (mode === 'none') {
    await removeIcons(tool.id);
    return { iconFile: null };
  }
  if (mode === 'url' && body.iconUrl) {
    const r = await iconFromUrl(tool.id, body.iconUrl);
    if (!r.ok) throw httpError(400, r.error);
    return { iconFile: r.file };
  }
  if (mode === 'upload' && body.iconData) {
    const r = await iconFromDataUrl(tool.id, body.iconData);
    if (!r.ok) throw httpError(400, r.error);
    return { iconFile: r.file };
  }
  if (mode === 'keep') {
    return {}; // leave existing iconFile untouched
  }
  // auto (best-effort; may quietly fail behind the proxy)
  const file = await autoFetchFavicon(tool.id, tool.url);
  return { iconFile: file };
}

// --- create ---
app.post('/api/tools', requireAdmin, async (req, res, next) => {
  try {
    const tool = await createTool(req.body);
    const iconPatch = await applyIcon(tool, req.body);
    const finalTool = iconPatch.iconFile !== undefined
      ? await updateTool(tool.id, { iconFile: iconPatch.iconFile })
      : tool;
    res.status(201).json(finalTool);
  } catch (err) {
    next(err);
  }
});

// --- update ---
app.put('/api/tools/:id', requireAdmin, async (req, res, next) => {
  try {
    const updated = await updateTool(req.params.id, req.body);
    const iconPatch = await applyIcon(updated, req.body);
    const finalTool = iconPatch.iconFile !== undefined
      ? await updateTool(updated.id, { iconFile: iconPatch.iconFile })
      : updated;
    res.json(finalTool);
  } catch (err) {
    next(err);
  }
});

// --- delete ---
app.delete('/api/tools/:id', requireAdmin, async (req, res, next) => {
  try {
    const removed = await deleteTool(req.params.id);
    await removeIcons(removed.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- force a health re-check (admin only) ---
app.post('/api/health/check', requireAdmin, async (req, res, next) => {
  try {
    await checkNow();
    res.json({ tools: await readAll() });
  } catch (err) {
    next(err);
  }
});

// --- cached icons ---
app.get('/icons/:file', async (req, res) => {
  const file = path.basename(req.params.file); // prevent traversal
  const full = path.join(config.iconDir, file);
  try {
    await fs.access(full);
    res.set('Cache-Control', 'public, max-age=60');
    res.sendFile(full);
  } catch {
    res.status(404).end();
  }
});

// --- static UI ---
app.use(express.static(path.join(__dirname, 'public')));

// --- error handler ---
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal error' });
});

app.listen(config.port, () => {
  console.log(`Toolbox listening on :${config.port}`);
  console.log(`  data:  ${config.dataFile}`);
  console.log(`  icons: ${config.iconDir}`);
  console.log(
    `  admin group: ${config.adminGroup || '(any authenticated user)'} | require proxy header: ${config.requireAuthHeader}`
  );
  startHealthChecks();
});
