// Share links — wrap the calculator's config-in-URL query string in an
// opaque, URL-safe token carried entirely in the URL. No server, no lookup
// table: the token *is* the dough.
//
// The app already persists its whole state as query params (see the
// useConfigNumber/useConfigEnum/useConfigBool hooks in index.html), so a
// share token is nothing but that query string, scrambled: it is lossless
// for any value those params can hold — typed off-grid numbers included —
// and automatically covers every current and future control with no field
// schema to keep in sync here.
//
// A random salt plus an XOR scramble means the same dough encodes to a
// different-looking token every time, and short payloads are padded to a
// minimum length, so the link reads as a random slug rather than a query
// string — but decoding stays 100% deterministic and offline (anyone with
// the link, or the source, can read it back; this hides the parameters
// from a glance, not from analysis).
//
// Loaded two ways, same as doughEngine.js:
//   - Node (tests):   require('./shareLink.js')
//   - Browser (app):  <script src="shareLink.js"> after doughEngine.js,
//                     which index.html's babel block reads off
//                     window.ShareLink. Reuses window.DoughEngine's
//                     mulberry32 rather than shipping a second copy.

(function () {
'use strict';

const engine = (typeof module !== 'undefined' && module.exports)
  ? require('./doughEngine.js')
  : window.DoughEngine;
const mulberry32 = engine.mulberry32;

// v1 tokens (a fixed per-field byte schema) are no longer decoded: the
// schema couldn't represent typed off-grid values and silently dropped
// fields the query string carries. A stray v1 link fails the version check
// and lands on the app's graceful "couldn't be read" fallback.
const VERSION = 2;

const SALT_LEN = 4;
const CHECKSUM_LEN = 2;
const HEADER_LEN = 3;         // version byte + 2-byte query length
const MIN_PAYLOAD_LEN = 27;   // pad short payloads so a near-default dough
                              // doesn't stand out as a conspicuously tiny token
const MAX_QUERY_BYTES = 4096; // sanity bound, far above any real config string

// Keystream derived from the salt — scrambles the payload so the token
// doesn't visibly encode the same dough the same way twice. Not a security
// boundary: the algorithm ships with the page, so this is opacity, not
// secrecy.
function keystream(saltBytes, len) {
  const seed = (saltBytes[0] << 24) | (saltBytes[1] << 16) | (saltBytes[2] << 8) | saltBytes[3];
  const rng = mulberry32(seed);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

// FNV-1a, truncated to 16 bits — just enough to catch a mangled or
// hand-edited token, not a cryptographic integrity check.
function fnv1a16(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  h >>>= 0;
  return (h ^ (h >>> 16)) & 0xffff;
}

function randomBytes(n) {
  const out = new Uint8Array(n);
  const c = (typeof globalThis !== 'undefined' && globalThis.crypto) || (typeof window !== 'undefined' && window.crypto);
  if (c && c.getRandomValues) c.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

// ---- base64url (no padding) ----
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function toBase64Url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 !== undefined) out += B64[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    if (b2 !== undefined) out += B64[b2 & 63];
  }
  return out;
}
function fromBase64Url(str) {
  const bytes = [];
  let buffer = 0, bits = 0;
  for (let i = 0; i < str.length; i++) {
    const idx = B64.indexOf(str[i]);
    if (idx === -1) continue; // ignore stray chars (whitespace, trailing punctuation, etc.)
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

// ---- public API ----

// search: a query string, with or without the leading '?' (typically
// window.location.search — whatever the config-in-URL hooks have written).
// Returns the token, or null for input the token format can't hold.
function encodeShareToken(search) {
  const qs = String(search == null ? '' : search).replace(/^\?/, '');
  const queryBytes = new TextEncoder().encode(qs);
  if (queryBytes.length > MAX_QUERY_BYTES) return null;
  const payloadLen = Math.max(HEADER_LEN + queryBytes.length, MIN_PAYLOAD_LEN);
  const payload = randomBytes(payloadLen); // bytes past the query stay random padding
  payload[0] = VERSION;
  payload[1] = queryBytes.length >> 8;
  payload[2] = queryBytes.length & 0xff;
  payload.set(queryBytes, HEADER_LEN);
  const salt = randomBytes(SALT_LEN);
  const ks = keystream(salt, payloadLen);
  for (let i = 0; i < payloadLen; i++) payload[i] ^= ks[i];
  const sum = fnv1a16(payload);
  const buf = new Uint8Array(SALT_LEN + payloadLen + CHECKSUM_LEN);
  buf.set(salt, 0);
  buf.set(payload, SALT_LEN);
  buf[SALT_LEN + payloadLen] = sum >> 8;
  buf[SALT_LEN + payloadLen + 1] = sum & 0xff;
  return toBase64Url(buf);
}

// Returns the decoded query string (no leading '?'), or null for a
// missing/corrupt/foreign token (never throws — callers fall back to
// defaults).
function decodeShareToken(token) {
  try {
    const buf = fromBase64Url(String(token || ''));
    const payloadLen = buf.length - SALT_LEN - CHECKSUM_LEN;
    if (payloadLen < HEADER_LEN) return null;
    const salt = buf.slice(0, SALT_LEN);
    const payload = buf.slice(SALT_LEN, SALT_LEN + payloadLen);
    const sum = (buf[SALT_LEN + payloadLen] << 8) | buf[SALT_LEN + payloadLen + 1];
    if (fnv1a16(payload) !== sum) return null;
    const ks = keystream(salt, payloadLen);
    for (let i = 0; i < payloadLen; i++) payload[i] ^= ks[i];
    if (payload[0] !== VERSION) return null;
    const len = (payload[1] << 8) | payload[2];
    if (len > MAX_QUERY_BYTES || HEADER_LEN + len > payloadLen) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(payload.slice(HEADER_LEN, HEADER_LEN + len));
  } catch (e) {
    return null;
  }
}

// Folds a share token into the page's query string. Pure string transform,
// no DOM access, so it's testable without a browser: given the page's
// current hash and search strings, returns the search string to use instead
// (existing params kept, the token's params overlaid on top) and whether a
// `d=` token was present but failed to decode. index.html does the one DOM
// side effect (history.replaceState) with this, before the config-in-URL
// hooks take their first read.
function expandShareToken(hash, search) {
  const m = /(?:^#|[&])d=([^&]+)/.exec(hash || '');
  if (!m) return { search: search || '', badLink: false, present: false };
  let token;
  try { token = decodeURIComponent(m[1]); } catch (e) { return { search: search || '', badLink: true, present: true }; }
  const decoded = decodeShareToken(token);
  if (decoded == null) return { search: search || '', badLink: true, present: true };
  const params = new URLSearchParams(search || '');
  new URLSearchParams(decoded).forEach((value, key) => params.set(key, value));
  const qs = params.toString();
  return { search: qs ? '?' + qs : '', badLink: false, present: true };
}

const __SHARE__ = {
  encodeShareToken, decodeShareToken, expandShareToken,
  VERSION, MIN_PAYLOAD_LEN, MAX_QUERY_BYTES,
};

if (typeof module !== 'undefined' && module.exports) module.exports = __SHARE__;
if (typeof window !== 'undefined') window.ShareLink = __SHARE__;

})();
