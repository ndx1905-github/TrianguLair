/**
 * Native secrets: expo-secure-store (iOS Keychain, Android Keystore-backed
 * encrypted preferences). WHEN_UNLOCKED_THIS_DEVICE_ONLY: readable only while
 * the phone is unlocked (spec "Protections on the device"), never included in
 * backups or restored to another device (device keys are never copied).
 */
import * as SecureStore from 'expo-secure-store';

import type { SecretKey, SecretStore } from './secretStore.types';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: 'org.triangulair.keys',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const name = (key: SecretKey) => `tl.${key}`;

export async function openSecretStore(): Promise<SecretStore> {
  return {
    kind: 'keychain',
    get: (key) => SecureStore.getItemAsync(name(key), OPTIONS),
    set: (key, value) => SecureStore.setItemAsync(name(key), value, OPTIONS),
    remove: (key) => SecureStore.deleteItemAsync(name(key), OPTIONS),
  };
}
