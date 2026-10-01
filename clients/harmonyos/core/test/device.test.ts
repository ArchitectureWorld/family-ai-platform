import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarmonyDeviceDescriptor } from '../src/device.ts';

test('declares a HarmonyOS phone as a mobile terminal without pretending to be iOS', () => {
  assert.deepEqual(createHarmonyDeviceDescriptor({
    displayName: '测试鸿蒙手机',
    systemVersion: 'HarmonyOS 7',
    appVersion: '0.1.0',
    model: 'HarmonyOS Phone'
  }), {
    displayName: '测试鸿蒙手机',
    terminalType: 'mobile',
    platform: 'harmonyos',
    systemVersion: 'HarmonyOS 7',
    appVersion: '0.1.0',
    model: 'HarmonyOS Phone'
  });
});
