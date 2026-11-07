/** Where secrets live on this platform (see secretStore.native.ts / secretStore.web.ts). */
export interface SecretStore {
  /**
   * - `keychain`: iOS Keychain / Android Keystore through expo-secure-store,
   *   readable only while the device is unlocked, never backed up or migrated.
   * - `web-wrapped`: web test build, IndexedDB encrypted with a non-extractable
   *   WebCrypto key kept in the same IndexedDB (test only).
   * - `web-plain`: web test build without WebCrypto (plain http): IndexedDB, unencrypted (test only).
   * - `memory`: nothing persists (storage blocked); the identity is lost when the page closes.
   */
  readonly kind: 'keychain' | 'web-wrapped' | 'web-plain' | 'memory';
  get(key: SecretKey): Promise<string | null>;
  set(key: SecretKey, value: string): Promise<void>;
  remove(key: SecretKey): Promise<void>;
}

/**
 * Every entry the app keeps in the secret store (`storage`: storage settings with their credentials, T-203;
 * `invitations-received`: invitation links I answered, whose key reads the inviter's places until they accept;
 * `pending-invitation`: a link opened before my identity existed, finished after the first launch; T-208).
 */
export type SecretKey = 'identity' | 'device-keys' | 'sharing-key' | 'primary-identity' | 'pending-phrase' | 'lock-code' | 'storage' | 'invitations-received' | 'pending-invitation';

export const SECRET_KEYS: readonly SecretKey[] = ['identity', 'device-keys', 'sharing-key', 'primary-identity', 'pending-phrase', 'lock-code', 'storage', 'invitations-received', 'pending-invitation'];
