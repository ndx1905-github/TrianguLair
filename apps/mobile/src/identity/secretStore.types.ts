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
 * `sync-keys`: earlier sharing key pairs and vault data keys kept by the sync engine, T-210;
 * `invitations-received`: invitation links I answered, whose key reads the inviter's places until they accept;
 * `pending-invitation`: a link opened before my identity existed, finished after the first launch; T-208;
 * `recovery-copy`: my current sharing key sealed with the phrase-derived key (TLSK mode 2), uploaded by the sync
 * controller to `keys/<owner>.bin` for a restore with the 12 words; T-206; `pending-move`: an identity move under way,
 * finished at the next launch if interrupted, devices review F-08; `db-key`: the local database's SQLCipher key,
 * erased first by a wipe so the database is unreadable at once, gap #7).
 */
export type SecretKey =
  | 'identity'
  | 'device-keys'
  | 'sharing-key'
  | 'primary-identity'
  | 'pending-phrase'
  | 'lock-code'
  | 'storage'
  | 'sync-keys'
  | 'invitations-received'
  | 'pending-invitation'
  | 'recovery-copy'
  | 'pending-move'
  | 'db-key';

export const SECRET_KEYS: readonly SecretKey[] = [
  'identity',
  'device-keys',
  'sharing-key',
  'primary-identity',
  'pending-phrase',
  'lock-code',
  'storage',
  'sync-keys',
  'invitations-received',
  'pending-invitation',
  'recovery-copy',
  'pending-move',
  'db-key',
];
