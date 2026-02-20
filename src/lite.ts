/**
 * @softtseek/overlay-client/lite - Pure-JS entry point
 *
 * Exports only modules that work without native C++ dependencies
 * (no better-sqlite3, hyperswarm, hypercore, hyperbee, hyperdht, sodium-native).
 * Uses blake3-wasm as fallback when native blake3 is unavailable.
 */

// High-level facade
export { OverlayClient, type OverlayClientOptions } from './overlay-client.js';

// Identity (pure JS: @noble/ed25519, @noble/hashes, @scure/bip39)
export {
  IdentityManager,
  generateIdentity,
  restoreIdentity,
  computeFingerprint,
  getAnonymousDisplayName,
  sign,
  verify,
  isValidPublicKey,
  isValidSignature,
  FileIdentityStorage,
  MemoryIdentityStorage,
  type Identity,
  type IdentityStorage,
} from './identity/index.js';

// Search (pure JS: HTTP fetch)
export { QueryRouter } from './search/query.js';

// Transport (relay only — uses net.Socket, no native deps)
export { RelayTransport } from './transport/relay.js';

// Publishing utilities (pure JS + blake3-wasm fallback)
export {
  hashFile,
  hashBytes,
  hashString,
  verifyFileHash,
  ensureBlake3,
  StreamingHasher,
  ChunkHasher,
  clearHashCache,
  type FileHashMeta,
} from './publish/hasher.js';

export {
  tokenizeFile,
  tokenizeQuery,
  tokenizeFilename,
  tokenizePath,
  parseExtension,
  truncateFilename,
  type TokenizationResult,
} from './publish/tokenizer.js';

// Core types
export * from './types.js';

// CBOR / signing utilities
export {
  encodeCanonical,
  hexToBytes,
  bytesToHex,
} from './utils/cbor.js';
