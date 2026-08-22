// Share links — pack the dough's inputs into a short, opaque, URL-safe
// token carried entirely in the URL. No server, no lookup table: the token
// *is* the dough. A random salt plus an XOR scramble means the same dough
// encodes to a different-looking token every time, so the link reads as a
// random slug rather than a query string — but decoding stays 100%
// deterministic and offline (anyone with the link, or the source, can read
// it back; this hides the parameters from a glance, not from analysis).
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

const VERSION = 1;

// One byte per field, scaled to match each slider's own min/max/step (see
// index.html) — `enc` turns a UI value into a byte 0-255, `dec` reverses it.
const SCALAR_FIELDS = [
  ['tempC',      v => v - 2,          b => b + 2],
  ['hours',      v => v - 2,          b => b + 2],
  ['protein',    v => v * 10 - 80,    b => (b + 80) / 10],
  ['plVal',      v => v,              b => b],
  ['hydration',  v => v - 50,         b => b + 50],
  ['salt',       v => v * 10,         b => b / 10],
  ['oilPct',     v => v * 10,         b => b / 10],
  ['sugarPct',   v => v * 4,          b => b / 4],
  ['starterStr', v => v,              b => b],
  ['ballCount',  v => v - 1,          b => b + 1],
  ['ballWeight', v => (v - 100) / 25, b => b * 25 + 100],
  ['roomTemp',   v => v - 12,         b => b + 12],
  ['ddt',        v => (v - 20) * 2,   b => b / 2 + 20],
  ['ovenC',      v => (v - 200) / 5,  b => b * 5 + 200],
];

// Legal post-decode range per field — rejects a corrupted or foreign token
// instead of feeding the app an out-of-range dough.
const SCALAR_RANGES = {
  tempC: [2, 35], hours: [2, 96], protein: [8, 15], plVal: [0, 100],
  hydration: [50, 85], salt: [0, 4], oilPct: [0, 6], sugarPct: [0, 4],
  starterStr: [0, 100], ballCount: [1, 12], ballWeight: [100, 500],
  roomTemp: [12, 30], ddt: [20, 28], ovenC: [200, 500],
};

const ENUMS = {
  leavening:  ['commercial', 'sourdough'],
  yeastType:  ['idy', 'ady', 'fresh'],
  preferment: ['straight', 'poolish', 'biga'],
  mixMethod:  ['hand', 'mixer', 'processor'],
  surface:    ['steel', 'stone', 'pan', 'rack'],
};
// Bit width each enum needs, in the order they're packed into the enum bytes.
const ENUM_ORDER = ['leavening', 'yeastType', 'preferment', 'mixMethod', 'surface'];
const ENUM_BITS = { leavening: 1, yeastType: 2, preferment: 2, mixMethod: 2, surface: 2 };

const PAYLOAD_LEN = 1 + SCALAR_FIELDS.length + 2; // version + scalars + 2 enum bytes
const SALT_LEN = 4;
const CHECKSUM_LEN = 2;
const TOKEN_LEN = SALT_LEN + PAYLOAD_LEN + CHECKSUM_LEN;

function clampByte(n) { return Math.max(0, Math.min(255, Math.round(n))); }

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

// ---- inputs <-> payload bytes ----
function buildPayload(inputs) {
  const bytes = new Uint8Array(PAYLOAD_LEN);
  bytes[0] = VERSION;
  SCALAR_FIELDS.forEach(([key, enc], i) => {
    bytes[1 + i] = clampByte(enc(inputs[key]));
  });
  let enumBits = 0, shift = 0;
  ENUM_ORDER.forEach((key) => {
    const idx = Math.max(0, ENUMS[key].indexOf(inputs[key]));
    enumBits |= idx << shift;
    shift += ENUM_BITS[key];
  });
  bytes[1 + SCALAR_FIELDS.length] = enumBits & 0xff;
  bytes[2 + SCALAR_FIELDS.length] = (enumBits >> 8) & 0xff;
  return bytes;
}

function parsePayload(bytes) {
  if (bytes[0] !== VERSION) return null;
  const out = {};
  for (let i = 0; i < SCALAR_FIELDS.length; i++) {
    const [key, , dec] = SCALAR_FIELDS[i];
    const val = dec(bytes[1 + i]);
    const [lo, hi] = SCALAR_RANGES[key];
    if (val < lo - 1e-6 || val > hi + 1e-6) return null;
    out[key] = Math.round(val * 100) / 100; // trim division/float noise
  }
  const enumBits = bytes[1 + SCALAR_FIELDS.length] | (bytes[2 + SCALAR_FIELDS.length] << 8);
  let shift = 0, ok = true;
  ENUM_ORDER.forEach((key) => {
    const idx = (enumBits >> shift) & ((1 << ENUM_BITS[key]) - 1);
    shift += ENUM_BITS[key];
    const val = ENUMS[key][idx];
    if (val === undefined) ok = false;
    out[key] = val;
  });
  return ok ? out : null;
}

// ---- public API ----

// inputs: the same shape as FermentCalculator's `inputs` object, minus
// doughWeight (derived from ballCount * ballWeight on the receiving end).
function encodeShareToken(inputs) {
  const payload = buildPayload(inputs);
  const salt = randomBytes(SALT_LEN);
  const ks = keystream(salt, PAYLOAD_LEN);
  const scrambled = new Uint8Array(PAYLOAD_LEN);
  for (let i = 0; i < PAYLOAD_LEN; i++) scrambled[i] = payload[i] ^ ks[i];
  const sum = fnv1a16(scrambled);
  const buf = new Uint8Array(TOKEN_LEN);
  buf.set(salt, 0);
  buf.set(scrambled, SALT_LEN);
  buf[SALT_LEN + PAYLOAD_LEN] = sum >> 8;
  buf[SALT_LEN + PAYLOAD_LEN + 1] = sum & 0xff;
  return toBase64Url(buf);
}

// Returns the decoded inputs object, or null for a missing/corrupt/foreign
// token (never throws — callers fall back to defaults).
function decodeShareToken(token) {
  try {
    const buf = fromBase64Url(String(token || ''));
    if (buf.length !== TOKEN_LEN) return null;
    const salt = buf.slice(0, SALT_LEN);
    const scrambled = buf.slice(SALT_LEN, SALT_LEN + PAYLOAD_LEN);
    const sum = (buf[SALT_LEN + PAYLOAD_LEN] << 8) | buf[SALT_LEN + PAYLOAD_LEN + 1];
    if (fnv1a16(scrambled) !== sum) return null;
    const ks = keystream(salt, PAYLOAD_LEN);
    const payload = new Uint8Array(PAYLOAD_LEN);
    for (let i = 0; i < PAYLOAD_LEN; i++) payload[i] = scrambled[i] ^ ks[i];
    return parsePayload(payload);
  } catch (e) {
    return null;
  }
}

const __SHARE__ = {
  encodeShareToken, decodeShareToken,
  VERSION, TOKEN_LEN, SCALAR_FIELDS, SCALAR_RANGES, ENUMS,
};

if (typeof module !== 'undefined' && module.exports) module.exports = __SHARE__;
if (typeof window !== 'undefined') window.ShareLink = __SHARE__;

})();
