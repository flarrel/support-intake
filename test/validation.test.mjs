import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReview, parseTicket } from '../app/validation.mjs';

test('accepts text intake and trims whitespace', () => {
  assert.deepEqual(parseTicket({ text: '  Card declined.  ' }), {
    source: 'text', text: 'Card declined.',
  });
  for (const text of ['', ' ', 'x'.repeat(4001), 'broken\0input']) {
    assert.throws(() => parseTicket({ text }), { status: 400 });
  }
});

test('validates encoding and checks that PNG bytes match the declared type', () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const image = signature.toString('base64');
  assert.deepEqual(parseTicket({ image, mime: 'image/png' }), {
    source: 'image', image: signature, extension: 'png',
  });
  assert.throws(() => parseTicket({ image: image + '?', mime: 'image/png' }), { status: 400 });
  assert.throws(() => parseTicket({ image, mime: 'image/jpeg' }), { status: 400 });
  assert.throws(() => parseTicket({ image, mime: 'image/png', text: 'duplicate' }), { status: 400 });
});

test('only accepts catalog intents and a positive integer version', () => {
  const intents = new Set(['card_not_working']);
  const input = { intent: 'card_not_working', version: 1, note: '  Verified. ' };
  assert.deepEqual(parseReview(input, intents), { ...input, note: 'Verified.' });
  assert.throws(() => parseReview({ ...input, version: 0 }, intents), { status: 400 });
  assert.throws(() => parseReview({ ...input, intent: 'unknown' }, intents), { status: 400 });
});
