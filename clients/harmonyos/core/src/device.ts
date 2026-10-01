import type { HarmonyDeviceDescriptor } from './types.ts';

export function createHarmonyDeviceDescriptor(input: {
  displayName: string;
  systemVersion: string;
  appVersion: string;
  model: string;
}): HarmonyDeviceDescriptor {
  return {
    displayName: input.displayName,
    terminalType: 'mobile',
    platform: 'harmonyos',
    systemVersion: input.systemVersion,
    appVersion: input.appVersion,
    model: input.model
  };
}
