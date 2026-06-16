// Icon handling. Everything ends up as a file in config.iconDir, served from
// Toolbox's own origin (GET /icons/:file). This is the only approach that
// survives the Authentik proxy: a stored remote URL like
// pdf.tools.example.com/favicon.ico would make the browser hit Authentik and
// get the login page back instead of an image.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const EXT_BY_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/avif': 'avif',
};

async function ensureDir() {
  await fs.mkdir(config.iconDir, { recursive: true });
}

function looksLikeHtml(bytes) {
  const head = bytes.slice(0, 64).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head');
}

function looksLikeImage(contentType, bytes) {
  // A proxied tool often answers with its Authentik login page. Reject any
  // HTML payload up front, no matter what content-type it claims.
  if (looksLikeHtml(bytes)) return false;
  if (contentType && EXT_BY_TYPE[contentType.split(';')[0].trim().toLowerCase()]) return true;
  // Sniff magic bytes for the common cases (covers servers that send
  // application/octet-stream for .ico, and rejects HTML login pages).
  if (bytes.length >= 4) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return true; // PNG
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return true; // JPEG
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return true; // GIF
    if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01) return true; // ICO
    const head = bytes.slice(0, 64).toString('utf8').trim().toLowerCase();
    if (head.startsWith('<svg') || head.startsWith('<?xml')) return true; // SVG
  }
  return false;
}

function extFor(contentType, bytes) {
  const mapped = contentType && EXT_BY_TYPE[contentType.split(';')[0].trim().toLowerCase()];
  if (mapped) return mapped;
  if (bytes[0] === 0x89) return 'png';
  if (bytes[0] === 0xff) return 'jpg';
  if (bytes[0] === 0x47) return 'gif';
  return 'ico';
}

async function writeIcon(id, bytes, ext) {
  await ensureDir();
  // Remove any previous icon for this id (extension may change).
  await removeIcons(id);
  const file = `${id}.${ext}`;
  await fs.writeFile(path.join(config.iconDir, file), bytes);
  return file;
}

export async function removeIcons(id) {
  try {
    const files = await fs.readdir(config.iconDir);
    await Promise.all(
      files
        .filter((f) => f === id || f.startsWith(`${id}.`))
        .map((f) => fs.rm(path.join(config.iconDir, f), { force: true }))
    );
  } catch {
    /* dir may not exist yet */
  }
}

async function fetchBytes(url, { timeoutMs = 6000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Toolbox/1.0 (+favicon-fetch)' },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > config.maxIconBytes) return null;
    return { contentType: res.headers.get('content-type') || '', bytes: buf };
  } catch {
    return null; // network error, timeout, or proxy login redirect chain
  } finally {
    clearTimeout(timer);
  }
}

// Best-effort: try a few well-known favicon locations at the tool's origin.
// Often fails when the tool is behind Authentik (we get HTML, not an image) —
// that's expected, and the caller falls back to a manual icon / monogram.
export async function autoFetchFavicon(id, toolUrl) {
  let origin;
  try {
    origin = new URL(toolUrl).origin;
  } catch {
    return null;
  }
  const candidates = [
    `${origin}/favicon.ico`,
    `${origin}/favicon.png`,
    `${origin}/apple-touch-icon.png`,
  ];
  for (const candidate of candidates) {
    const got = await fetchBytes(candidate);
    if (got && looksLikeImage(got.contentType, got.bytes)) {
      return writeIcon(id, got.bytes, extFor(got.contentType, got.bytes));
    }
  }
  return null;
}

// Manual override: download a user-supplied image URL and cache it locally.
export async function iconFromUrl(id, url) {
  const got = await fetchBytes(url, { timeoutMs: 8000 });
  if (!got || !looksLikeImage(got.contentType, got.bytes)) {
    return { ok: false, error: 'That URL did not return a usable image.' };
  }
  const file = await writeIcon(id, got.bytes, extFor(got.contentType, got.bytes));
  return { ok: true, file };
}

// Manual override: decode a data URL produced by a browser file picker.
export async function iconFromDataUrl(id, dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!match) return { ok: false, error: 'Unsupported image data.' };
  const contentType = match[1].toLowerCase();
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0) return { ok: false, error: 'Empty image.' };
  if (bytes.length > config.maxIconBytes) {
    return { ok: false, error: 'Image is too large.' };
  }
  if (!looksLikeImage(contentType, bytes)) {
    return { ok: false, error: 'That file is not a supported image.' };
  }
  const file = await writeIcon(id, bytes, extFor(contentType, bytes));
  return { ok: true, file };
}
