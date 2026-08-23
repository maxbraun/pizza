// Share links — pack the dough's inputs (and, since v2, the name its author
// gave it) into a short, opaque, URL-safe token carried entirely in the URL.
// No server, no lookup table: the token *is* the dough. A random salt plus
// an XOR scramble means the same dough encodes to a different-looking token
// every time, so the link reads as a random slug rather than a query string
// — but decoding stays 100% deterministic and offline (anyone with the link, or the source, can read
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

const VERSION = 2;

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

// version + scalars + 2 enum bytes + 1 name-length byte, then that many
// UTF-8 name bytes. Everything up to the name byte is fixed width, so the
// payload's total length pins the name's length and vice versa.
const PAYLOAD_HEAD = 1 + SCALAR_FIELDS.length + 2 + 1;
const NAME_MAX = 64;             // bytes, not characters
const SALT_LEN = 4;
const CHECKSUM_LEN = 2;
const OVERHEAD = SALT_LEN + CHECKSUM_LEN;
const MIN_TOKEN_LEN = OVERHEAD + PAYLOAD_HEAD;
const MAX_TOKEN_LEN = MIN_TOKEN_LEN + NAME_MAX;

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

// ---- names ----
// A share link is read by a stranger, so the name travels as plain UTF-8
// inside the (scrambled) payload rather than as a query param: it stays as
// opaque-looking as the rest of the token. Control characters go — a name
// ends up in the DOM and in localStorage, and a bidi override would let a
// stranger's link render its name as something else entirely — and the
// whole thing is capped at NAME_MAX *bytes*, cut on a code-point boundary
// so a truncated emoji or umlaut can't leave a broken sequence behind.
function sanitizeName(name) {
  return String(name == null ? '' : name)
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function encodeName(name) {
  const clean = sanitizeName(name);
  if (!clean) return new Uint8Array(0);
  let bytes = new TextEncoder().encode(clean);
  if (bytes.length > NAME_MAX) {
    let end = NAME_MAX;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--; // back off mid-sequence
    bytes = bytes.slice(0, end);
  }
  return bytes;
}

function decodeName(bytes) {
  if (!bytes.length) return '';
  try { return sanitizeName(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (e) { return ''; } // mangled bytes cost the name, not the dough
}

// The longest form of `name` that survives a share token, sanitized. The
// recipe box stores names through this too, so a name never quietly
// changes the first time someone shares it.
function fitName(name) { return decodeName(encodeName(name)); }

// ---- inputs <-> payload bytes ----
function buildPayload(inputs, name) {
  const nameBytes = encodeName(name);
  const bytes = new Uint8Array(PAYLOAD_HEAD + nameBytes.length);
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
  bytes[PAYLOAD_HEAD - 1] = nameBytes.length;
  bytes.set(nameBytes, PAYLOAD_HEAD);
  return bytes;
}

// Returns { inputs, name }, or null if the bytes aren't a dough this
// version understands.
function parsePayload(bytes) {
  if (bytes[0] !== VERSION) return null;
  if (bytes.length < PAYLOAD_HEAD) return null;
  if (bytes[PAYLOAD_HEAD - 1] !== bytes.length - PAYLOAD_HEAD) return null; // name length must match
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
  if (!ok) return null;
  return { inputs: out, name: decodeName(bytes.slice(PAYLOAD_HEAD)) };
}

// ---- public API ----

// inputs: the same shape as FermentCalculator's `inputs` object, minus
// doughWeight (derived from ballCount * ballWeight on the receiving end).
// name: optional — what the sender calls this dough. Omit it and the token
// is the same length it was in v1.
function encodeShareToken(inputs, name) {
  const payload = buildPayload(inputs, name);
  const len = payload.length;
  const salt = randomBytes(SALT_LEN);
  const ks = keystream(salt, len);
  const scrambled = new Uint8Array(len);
  for (let i = 0; i < len; i++) scrambled[i] = payload[i] ^ ks[i];
  const sum = fnv1a16(scrambled);
  const buf = new Uint8Array(OVERHEAD + len);
  buf.set(salt, 0);
  buf.set(scrambled, SALT_LEN);
  buf[SALT_LEN + len] = sum >> 8;
  buf[SALT_LEN + len + 1] = sum & 0xff;
  return toBase64Url(buf);
}

// Returns { inputs, name }, or null for a missing/corrupt/foreign token
// (never throws — callers fall back to defaults). The payload is variable
// length now, so the buffer's own size says how much to unscramble; the
// name-length byte inside then has to agree, which is one more way a
// mangled token fails closed.
function decodeShareToken(token) {
  try {
    const buf = fromBase64Url(String(token || ''));
    if (buf.length < MIN_TOKEN_LEN || buf.length > MAX_TOKEN_LEN) return null;
    const len = buf.length - OVERHEAD;
    const salt = buf.slice(0, SALT_LEN);
    const scrambled = buf.slice(SALT_LEN, SALT_LEN + len);
    const sum = (buf[SALT_LEN + len] << 8) | buf[SALT_LEN + len + 1];
    if (fnv1a16(scrambled) !== sum) return null;
    const ks = keystream(salt, len);
    const payload = new Uint8Array(len);
    for (let i = 0; i < len; i++) payload[i] = scrambled[i] ^ ks[i];
    return parsePayload(payload);
  } catch (e) {
    return null;
  }
}

// The one place that says what a legal dough is, so anything arriving from
// outside the app — a share link, an imported recipe file, a hand-edited
// localStorage blob — gets checked the same way. Returns a fresh object
// with exactly the known fields, or null if any of them is missing,
// non-finite, out of range, or not one of the enum's values.
function sanitizeInputs(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const [key, [lo, hi]] of Object.entries(SCALAR_RANGES)) {
    const n = Number(obj[key]);
    if (!Number.isFinite(n) || n < lo - 1e-6 || n > hi + 1e-6) return null;
    out[key] = Math.round(n * 100) / 100;
  }
  for (const key of ENUM_ORDER) {
    if (!ENUMS[key].includes(obj[key])) return null;
    out[key] = obj[key];
  }
  return out;
}

// ---- folding a share token into the app's config-in-URL query string ----
//
// index.html (from a separate change) already persists the calculator's
// state as query params via small useConfigNumber/useConfigEnum/useConfigBool
// hooks, so a reload or a copied plain link reproduces the same setup. A
// share token doesn't need a second, parallel way of getting state into the
// app — it just needs to expand into those same params before the page's
// hooks read them. This keeps `#d=...` links compact and opaque to *send*,
// while everything downstream (state restore, refresh-safety) goes through
// the one mechanism. Field -> query-param names mirror index.html's hook
// calls exactly; keep the two in sync if either changes.
const PARAM_NAMES = {
  tempC: 'tempC', hours: 'hours', protein: 'protein', plVal: 'pl',
  hydration: 'hydration', salt: 'salt', oilPct: 'oil', sugarPct: 'sugar',
  yeastType: 'yeast', leavening: 'leaven', starterStr: 'starter',
  preferment: 'preferment', ballCount: 'balls', ballWeight: 'ballWeight',
  roomTemp: 'room', ddt: 'ddt', mixMethod: 'mix', ovenC: 'oven', surface: 'surface',
};

// Pure string transform, no DOM access, so it's testable without a browser:
// given the page's current hash and search strings, returns the search
// string to use instead (existing params kept, dough params from the token
// overlaid) and whether a `d=` token was present but failed to decode.
// index.html does the one DOM side effect (history.replaceState) with this.
function expandShareToken(hash, search) {
  const m = /(?:^#|[&])d=([^&]+)/.exec(hash || '');
  if (!m) return { search: search || '', badLink: false, present: false };
  let token;
  try { token = decodeURIComponent(m[1]); } catch (e) { return { search: search || '', badLink: true, present: true }; }
  const shared = decodeShareToken(token);
  if (!shared) return { search: search || '', badLink: true, present: true };
  const params = new URLSearchParams(search || '');
  Object.entries(PARAM_NAMES).forEach(([key, param]) => params.set(param, String(shared.inputs[key])));
  const qs = params.toString();
  // `dough`/`name` ride along so the app can offer to save what just
  // arrived: the query string alone can't tell a shared dough apart from
  // one the user built themselves.
  return {
    search: qs ? '?' + qs : '', badLink: false, present: true,
    dough: shared.inputs, name: shared.name,
  };
}

const __SHARE__ = {
  encodeShareToken, decodeShareToken, expandShareToken, sanitizeInputs, sanitizeName, fitName,
  VERSION, MIN_TOKEN_LEN, MAX_TOKEN_LEN, NAME_MAX,
  SCALAR_FIELDS, SCALAR_RANGES, ENUMS, ENUM_ORDER, PARAM_NAMES,
};

if (typeof module !== 'undefined' && module.exports) module.exports = __SHARE__;
if (typeof window !== 'undefined') window.ShareLink = __SHARE__;

})();
