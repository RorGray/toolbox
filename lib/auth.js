// Authentik forward-auth integration.
//
// We do NOT implement OIDC. Authentik's proxy outpost authenticates the
// request and injects identity headers before it reaches us, so the app just
// reads those headers and trusts them — the network guarantees nothing else
// can reach the container (see requireAuthHeader).

import { config } from './config.js';

function splitGroups(value) {
  if (!value) return [];
  // Authentik separates groups with "|" by default; also tolerate "," and ";".
  return value
    .split(/[|,;]/)
    .map((g) => g.trim())
    .filter(Boolean);
}

function log(req, msg) {
  const ts = new Date().toISOString();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '-';
  console.log(`[auth] ${ts} ${req.method} ${req.path} ip=${ip} ${msg}`);
}

// Attaches req.identity = { user, groups, isAdmin }.
export function identity(req, res, next) {
  const rawUser   = req.headers[config.authHeaderUser];
  const rawGroups = req.headers[config.authHeaderGroups];
  let user   = rawUser || null;
  let groups = splitGroups(rawGroups);

  // Local-dev fallback: with no proxy in front (requireAuthHeader off) the
  // browser can't send the Authentik headers, so act as DEV_USER/DEV_GROUPS.
  // This branch can never fire in production, where requireAuthHeader is true.
  const usingDevFallback = !user && !config.requireAuthHeader && Boolean(config.devUser);
  if (usingDevFallback) {
    user   = config.devUser;
    groups = splitGroups(config.devGroups);
  }

  // Empty adminGroup means "any authenticated user may edit".
  const isAdmin = config.adminGroup === '' ? Boolean(user) : groups.includes(config.adminGroup);
  req.identity = { user, groups, isAdmin };

  log(req, [
    `header[${config.authHeaderUser}]=${JSON.stringify(rawUser ?? '(absent)')}`,
    `header[${config.authHeaderGroups}]=${JSON.stringify(rawGroups ?? '(absent)')}`,
    usingDevFallback ? `dev-fallback=true user=${user}` : `user=${user ?? '(none)'}`,
    `groups=[${groups.join(', ')}]`,
    `adminGroup=${JSON.stringify(config.adminGroup || '(any)')}`,
    `isAdmin=${isAdmin}`,
  ].join(' '));

  next();
}

// Defense in depth: block requests that never went through the proxy.
export function requireProxy(req, res, next) {
  if (config.requireAuthHeader && !req.identity.user) {
    log(req, 'BLOCKED no-proxy: Authentik user header absent');
    return res.status(403).json({
      error:
        'Missing authentication header. This app must be reached through the Authentik proxy.',
    });
  }
  next();
}

// Gate for mutating endpoints.
export function requireAdmin(req, res, next) {
  if (!req.identity.isAdmin) {
    log(req, `BLOCKED not-admin: user=${req.identity.user} groups=[${req.identity.groups.join(', ')}] required=${JSON.stringify(config.adminGroup || '(any)')}`);
    return res.status(403).json({
      error: config.adminGroup
        ? `Editing requires membership in the "${config.adminGroup}" group.`
        : 'Editing requires authentication.',
    });
  }
  next();
}
