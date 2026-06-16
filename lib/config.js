// Central configuration, all overridable via environment variables.
// Sensible defaults are tuned for a docker-compose deploy with a /data volume.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bool = (v, fallback) =>
  v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const int = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

// Resolve path-valued config to an absolute path so it never depends on the
// process's working directory. A relative value (handy for local dev, e.g.
// ./icons) is taken relative to the app root; absolute values (the /data
// defaults under Docker) pass through unchanged. This also matters because
// res.sendFile() requires an absolute path.
const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const resolvePath = (p) => (path.isAbsolute(p) ? p : path.resolve(appRoot, p));

export const config = {
  port: int(process.env.PORT, 3000),

  // Persistence (mount a volume at /data so these survive container restarts).
  dataFile: resolvePath(process.env.DATA_FILE || '/data/tools.json'),
  iconDir: resolvePath(process.env.ICON_DIR || '/data/icons'),

  // Authentik forward-auth integration.
  // The proxy outpost injects these headers; names are configurable in case
  // you customise the header mapping in the Authentik provider.
  authHeaderUser: (process.env.AUTH_HEADER_USER || 'x-authentik-username').toLowerCase(),
  authHeaderGroups: (process.env.AUTH_HEADER_GROUPS || 'x-authentik-groups').toLowerCase(),

  // Group whose members may add / edit / delete entries. Everyone past the
  // proxy can view. Set ADMIN_GROUP empty to let any authenticated user edit.
  adminGroup: process.env.ADMIN_GROUP ?? 'toolbox-admins',

  // Defense in depth: reject any request that arrives without the Authentik
  // user header. This blocks direct hits that bypass the proxy on the docker
  // network. Turn off only if you front the app a different way.
  requireAuthHeader: bool(process.env.REQUIRE_AUTH_HEADER, true),

  // Local-development fallback identity. ONLY honoured when REQUIRE_AUTH_HEADER
  // is false (i.e. there is no Authentik proxy in front). Lets the browser —
  // which cannot inject the Authentik headers — act as a user/groups so you can
  // add and edit entries while poking the UI locally. Empty = disabled.
  devUser: process.env.DEV_USER || '',
  devGroups: process.env.DEV_GROUPS || '',

  // Background health pinger.
  healthIntervalMs: int(process.env.HEALTH_INTERVAL_MS, 60000),
  healthTimeoutMs: int(process.env.HEALTH_TIMEOUT_MS, 5000),

  // Max size for a pasted/uploaded icon (base64 inflates ~33%).
  maxIconBytes: int(process.env.MAX_ICON_BYTES, 512 * 1024),
};
