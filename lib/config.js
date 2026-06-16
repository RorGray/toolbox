// Central configuration, all overridable via environment variables.
// Sensible defaults are tuned for a docker-compose deploy with a /data volume.

const bool = (v, fallback) =>
  v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const int = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: int(process.env.PORT, 3000),

  // Persistence (mount a volume at /data so these survive container restarts).
  dataFile: process.env.DATA_FILE || '/data/tools.json',
  iconDir: process.env.ICON_DIR || '/data/icons',

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

  // Background health pinger.
  healthIntervalMs: int(process.env.HEALTH_INTERVAL_MS, 60000),
  healthTimeoutMs: int(process.env.HEALTH_TIMEOUT_MS, 5000),

  // Max size for a pasted/uploaded icon (base64 inflates ~33%).
  maxIconBytes: int(process.env.MAX_ICON_BYTES, 512 * 1024),
};
