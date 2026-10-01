import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_KEYS,
  INSTALLATION_KEY,
  SESSION_KEYS,
  keysRemovedByLogout,
  keysRemovedByUnbind
} from '../src/credentials.ts';

test('logout removes only the Personal Entry Session', () => {
  assert.deepEqual(keysRemovedByLogout(), SESSION_KEYS);
  assert.equal(keysRemovedByLogout().includes(INSTALLATION_KEY), false);
  for (const key of DEVICE_KEYS) assert.equal(keysRemovedByLogout().includes(key), false);
});

test('unbind removes Gateway, Device and Session material but keeps installation identity', () => {
  const removed = keysRemovedByUnbind();
  for (const key of [...DEVICE_KEYS, ...SESSION_KEYS]) assert.equal(removed.includes(key), true);
  assert.equal(removed.includes(INSTALLATION_KEY), false);
});
