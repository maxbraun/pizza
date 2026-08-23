// Unit tests for share-link encoding/decoding.
// Run: node --test shareLink.test.js
// No build step, no npm — uses Node 18+ built-in test runner.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { encodeShareToken, decodeShareToken, expandShareToken, MIN_PAYLOAD_LEN, MAX_QUERY_BYTES } = require('./shareLink.js');

// A representative config query string, as the config-in-URL hooks write it.
const BASE = 'tempC=4&hours=48&protein=13&hydration=68&salt=2.8&leaven=sourdough&balls=6&ballWeight=320&oven=300&surface=stone&style=neapolitan';

describe('encodeShareToken / decodeShareToken', () => {
  test('round-trips a typical config query string exactly', () => {
    assert.equal(decodeShareToken(encodeShareToken(BASE)), BASE);
  });

  test('leading "?" is normalized away', () => {
    assert.equal(decodeShareToken(encodeShareToken('?' + BASE)), BASE);
  });

  test('round-trips typed off-grid values losslessly (the v1 quantizer corrupted these)', () => {
    const qs = 'ballWeight=313&hydration=62.7&salt=2.83&hours=36.5';
    assert.equal(decodeShareToken(encodeShareToken(qs)), qs);
  });

  test('round-trips params it has never heard of (future controls)', () => {
    const qs = 'someFutureKnob=42&anotherOne=maybe';
    assert.equal(decodeShareToken(encodeShareToken(qs)), qs);
  });

  test('round-trips the empty query string (all-defaults dough)', () => {
    assert.equal(decodeShareToken(encodeShareToken('')), '');
    assert.equal(decodeShareToken(encodeShareToken(null)), '');
  });

  test('round-trips percent-encoded and non-ASCII content', () => {
    const qs = new URLSearchParams({ note: 'Sauerteig — 65 % Hydration!' }).toString();
    assert.equal(decodeShareToken(encodeShareToken(qs)), qs);
  });

  test('two tokens for the same config are different strings but decode identically', () => {
    const a = encodeShareToken(BASE);
    const b = encodeShareToken(BASE);
    assert.notEqual(a, b);
    assert.equal(decodeShareToken(a), decodeShareToken(b));
  });

  test('token is URL-safe (no padding, no reserved characters)', () => {
    assert.match(encodeShareToken(BASE), /^[A-Za-z0-9\-_]+$/);
  });

  test('an all-defaults token is padded, not conspicuously tiny', () => {
    // salt(4) + padded payload(MIN_PAYLOAD_LEN) + checksum(2), base64url'd
    const minChars = Math.floor(((4 + MIN_PAYLOAD_LEN + 2) * 8) / 6);
    assert.ok(encodeShareToken('').length >= minChars);
  });

  test('rejects a query string over the size bound', () => {
    assert.equal(encodeShareToken('x=' + 'a'.repeat(MAX_QUERY_BYTES)), null);
  });

  test('rejects a truncated token', () => {
    assert.equal(decodeShareToken(encodeShareToken(BASE).slice(0, -4)), null);
  });

  test('rejects a token with a flipped character (checksum catches corruption)', () => {
    const token = encodeShareToken(BASE);
    const chars = token.split('');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const original = chars[5];
    let replacement = original;
    while (replacement === original) {
      replacement = alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    chars[5] = replacement;
    assert.equal(decodeShareToken(chars.join('')), null);
  });

  test('rejects garbage input', () => {
    assert.equal(decodeShareToken('not-a-real-token'), null);
    assert.equal(decodeShareToken(''), null);
    assert.equal(decodeShareToken(null), null);
    assert.equal(decodeShareToken(undefined), null);
  });

  test('rejects a v1-era token (old fixed-schema format)', () => {
    // v1 tokens were exactly 23 bytes = 31 base64url chars; whatever their
    // content, the version byte can no longer be 2 after a valid checksum,
    // so a representative one must fail cleanly rather than mis-decode.
    assert.equal(decodeShareToken('6iYSdZyD-TFHbPK9Iq6y7ytt8y3T5TU'), null);
  });
});

describe('expandShareToken', () => {
  test('no hash: search passes through untouched, nothing flagged', () => {
    assert.deepEqual(expandShareToken('', '?foo=bar'), { search: '?foo=bar', badLink: false, present: false });
  });

  test('valid token: its params land in the returned search string', () => {
    const { search, badLink, present } = expandShareToken('#d=' + encodeShareToken(BASE), '');
    assert.equal(badLink, false);
    assert.equal(present, true);
    const params = new URLSearchParams(search);
    for (const [key, value] of new URLSearchParams(BASE)) {
      assert.equal(params.get(key), value, key);
    }
  });

  test('regression: ballWeight survives a share (v1 reset it to 100)', () => {
    const { search } = expandShareToken('#d=' + encodeShareToken('ballWeight=320'), '');
    assert.equal(new URLSearchParams(search).get('ballWeight'), '320');
  });

  test('token params overlay existing search, unrelated params kept', () => {
    const { search } = expandShareToken('#d=' + encodeShareToken('tempC=4'), '?keep=me&tempC=99');
    const params = new URLSearchParams(search);
    assert.equal(params.get('keep'), 'me');
    assert.equal(params.get('tempC'), '4');
  });

  test('all-defaults token: search unchanged, hash still consumed', () => {
    assert.deepEqual(expandShareToken('#d=' + encodeShareToken(''), ''), { search: '', badLink: false, present: true });
  });

  test('token embedded alongside other hash content is still found', () => {
    const { search, present } = expandShareToken('#foo=1&d=' + encodeShareToken('tempC=4') + '&bar=2', '');
    assert.equal(present, true);
    assert.equal(new URLSearchParams(search).get('tempC'), '4');
  });

  test('corrupt token: flagged bad, search left untouched', () => {
    assert.deepEqual(expandShareToken('#d=not-a-real-token', '?keep=me'), { search: '?keep=me', badLink: true, present: true });
  });
});
