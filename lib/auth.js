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

// Attaches req.identity = { user, groups, isAdmin }.
export function identity(req, res, next) {
  let user = req.headers[config.authHeaderUser] || null;
  let groups = splitGroups(req.headers[config.authHeaderGroups]);
  // Local-dev fallback: with no proxy in front (requireAuthHeader off) the
  // browser can't send the Authentik headers, so act as DEV_USER/DEV_GROUPS.
  // This branch can never fire in production, where requireAuthHeader is true.
  if (!user && !config.requireAuthHeader && config.devUser) {
    user = config.devUser;
    groups = splitGroups(config.devGroups);
  }
  // Empty adminGroup means "any authenticated user may edit".
  const isAdmin = config.adminGroup === '' ? Boolean(user) : groups.includes(config.adminGroup);
  req.identity = { user, groups, isAdmin };
  next();
}

// Defense in depth: block requests that never went through the proxy.
export function requireProxy(req, res, next) {
  if (config.requireAuthHeader && !req.identity.user) {
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
    return res.status(403).json({
      error: config.adminGroup
        ? `Editing requires membership in the "${config.adminGroup}" group.`
        : 'Editing requires authentication.',
    });
  }
  next();
}
