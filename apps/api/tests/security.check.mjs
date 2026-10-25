import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, checkPassword, equalHex, tokenHash } from '../src/services/security.js';
test('passwords are salted and verified without plaintext storage', async () => {
  const first = await hashPassword('strong-secret-password');
  const second = await hashPassword('strong-secret-password');
  assert.notEqual(first, second);
  assert.ok(!first.includes('strong-secret-password'));
  assert.equal(await checkPassword('strong-secret-password', first), true);
  assert.equal(await checkPassword('incorrect', first), false);
  assert.equal(await checkPassword('anything', 'not-a-hash'), false);
});
test('hex signatures compare correctly and tokens are hashed', () => {
  assert.equal(equalHex('aabb', 'aabb'), true);
  assert.equal(equalHex('aabb', 'aabc'), false);
  assert.equal(equalHex('aa', 'aaaa'), false);
  assert.equal(equalHex('garbage', 'aaaa'), false);
  assert.equal(tokenHash('token'), tokenHash('token'));
  assert.notEqual(tokenHash('token'), 'token');
});
