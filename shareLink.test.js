// Unit tests for share-link encoding/decoding.
// Run: node --test shareLink.test.js
// No build step, no npm — uses Node 18+ built-in test runner.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { encodeShareToken, decodeShareToken, expandShareToken, TOKEN_LEN, SCALAR_RANGES, ENUMS, PARAM_NAMES } = require('./shareLink.js');

// A representative dough — one value per field, all mid-range.
const BASE = {
  tempC: 21, hours: 8, protein: 12.5, plVal: 50, hydration: 62,
  salt: 2.5, oilPct: 1.5, sugarPct: 0.5, starterStr: 50,
  ballCount: 4, ballWeight: 250, roomTemp: 20, ddt: 24, ovenC: 250,
  leavening: 'commercial', yeastType: 'idy', preferment: 'straight',
  mixMethod: 'hand', surface: 'steel',
};

describe('encodeShareToken / decodeShareToken', () => {
  test('round-trips the base dough exactly', () => {
    const token = encodeShareToken(BASE);
    const decoded = decodeShareToken(token);
    assert.deepEqual(decoded, BASE);
  });

  test('round-trips every field at its low and high slider bound', () => {
    for (const [key, [lo, hi]] of Object.entries(SCALAR_RANGES)) {
      for (const bound of [lo, hi]) {
        const dough = { ...BASE, [key]: bound };
        const decoded = decodeShareToken(encodeShareToken(dough));
        assert.equal(decoded[key], bound, `${key}=${bound} round-trip`);
      }
    }
  });

  test('round-trips every enum value', () => {
    for (const [key, values] of Object.entries(ENUMS)) {
      for (const val of values) {
        const dough = { ...BASE, [key]: val };
        const decoded = decodeShareToken(encodeShareToken(dough));
        assert.equal(decoded[key], val, `${key}=${val} round-trip`);
      }
    }
  });

  test('two tokens for the same dough are different strings', () => {
    const a = encodeShareToken(BASE);
    const b = encodeShareToken(BASE);
    assert.notEqual(a, b);
  });

  test('but both decode back to the same dough', () => {
    const a = decodeShareToken(encodeShareToken(BASE));
    const b = decodeShareToken(encodeShareToken(BASE));
    assert.deepEqual(a, b);
  });

  test('token is URL-safe (no padding, no reserved characters)', () => {
    const token = encodeShareToken(BASE);
    assert.match(token, /^[A-Za-z0-9\-_]+$/);
  });

  test('token stays short', () => {
    const token = encodeShareToken(BASE);
    assert.ok(token.length <= 48, `token length ${token.length} should be <= 48`);
  });

  test('rejects a truncated token', () => {
    const token = encodeShareToken(BASE);
    assert.equal(decodeShareToken(token.slice(0, -4)), null);
  });

  test('rejects a token with a flipped character (checksum catches corruption)', () => {
    const token = encodeShareToken(BASE);
    const chars = token.split('');
    const flipIdx = 5;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const original = chars[flipIdx];
    let replacement = original;
    while (replacement === original) {
      replacement = alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    chars[flipIdx] = replacement;
    assert.equal(decodeShareToken(chars.join('')), null);
  });

  test('rejects garbage input', () => {
    assert.equal(decodeShareToken('not-a-real-token'), null);
    assert.equal(decodeShareToken(''), null);
    assert.equal(decodeShareToken(null), null);
    assert.equal(decodeShareToken(undefined), null);
  });

  test('rejects a well-formed but all-zero token (checksum mismatch)', () => {
    // 31 base64url 'A's decode to exactly TOKEN_LEN (23) zero bytes — right
    // length, but the stored checksum (0) won't match FNV-1a of the
    // all-zero scrambled payload, so it must be rejected rather than
    // silently decoding to some default dough.
    assert.equal(TOKEN_LEN, 23, 'sanity check: token layout assumed by this test');
    const zeros = 'A'.repeat(31);
    assert.equal(decodeShareToken(zeros), null);
  });
});

describe('expandShareToken', () => {
  test('no hash: search passes through untouched, nothing flagged', () => {
    const result = expandShareToken('', '?foo=bar');
    assert.deepEqual(result, { search: '?foo=bar', badLink: false, present: false });
  });

  test('valid token: every field lands under its config-in-URL param name', () => {
    const token = encodeShareToken(BASE);
    const { search, badLink, present } = expandShareToken('#d=' + token, '');
    assert.equal(badLink, false);
    assert.equal(present, true);
    const params = new URLSearchParams(search);
    for (const [key, param] of Object.entries(PARAM_NAMES)) {
      assert.equal(params.get(param), String(BASE[key]), `${key} -> ?${param}`);
    }
  });

  test('valid token overlays dough fields but keeps unrelated existing params', () => {
    const token = encodeShareToken(BASE);
    const { search } = expandShareToken('#d=' + token, '?nerd=1&learn=1');
    const params = new URLSearchParams(search);
    assert.equal(params.get('nerd'), '1');
    assert.equal(params.get('learn'), '1');
    assert.equal(params.get('tempC'), String(BASE.tempC));
  });

  test('valid token overrides a same-named existing dough param', () => {
    const token = encodeShareToken(BASE);
    const { search } = expandShareToken('#d=' + token, '?tempC=99');
    assert.equal(new URLSearchParams(search).get('tempC'), String(BASE.tempC));
  });

  test('token embedded alongside other hash content is still found', () => {
    const token = encodeShareToken(BASE);
    const { search, present } = expandShareToken('#foo=1&d=' + token + '&bar=2', '');
    assert.equal(present, true);
    assert.equal(new URLSearchParams(search).get('tempC'), String(BASE.tempC));
  });

  test('corrupt token: flagged bad, search left untouched', () => {
    const result = expandShareToken('#d=not-a-real-token', '?keep=me');
    assert.deepEqual(result, { search: '?keep=me', badLink: true, present: true });
  });

  test('round-trips every enum through its query param', () => {
    for (const [key, values] of Object.entries(ENUMS)) {
      for (const val of values) {
        const dough = { ...BASE, [key]: val };
        const token = encodeShareToken(dough);
        const { search } = expandShareToken('#d=' + token, '');
        assert.equal(new URLSearchParams(search).get(PARAM_NAMES[key]), val);
      }
    }
  });
});
