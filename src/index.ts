/**
 * @softtseek/overlay-client - Overlay Network Client Library
 *
 * This package provides the client-side implementation for the SoFTTSeek
 * overlay network, including identity management, search, publishing,
 * and P2P/relay transport.
 */

// Core types
export * from './types.js';

// Identity management
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

// Soulseek bridge for dual operation
export {
  SoulseekBridge,
  type SoulseekSearchResult,
  type SoulseekBridgeCallbacks,
  type UnifiedSearchResult,
} from './bridge/soulseek.js';

// Search
export { QueryRouter } from './search/query.js';
export { getShardForToken, getShardTopic, groupTokensByShard, IndexerSelector } from './search/sharding.js';

// Publishing
export {
  hashFile,
  hashBytes,
  hashString,
  verifyFileHash,
  StreamingHasher,
  ChunkHasher,
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
export {
  Publisher,
  verifyPublishMessage,
  verifyRefreshMessage,
  verifyTombstoneMessage,
  verifyCollectionSignature,
} from './publish/publisher.js';

// Transport
export { DirectTransport } from './transport/direct.js';
export { RelayTransport } from './transport/relay.js';

// Reputation
export { ReputationManager, type TransferOutcome } from './reputation/index.js';

// Presence
export { PresenceBeacon, type ProviderPresence } from './presence/beacon.js';

// Local database
export { LocalDatabase } from './localdb/index.js';

// Profile cache
export { ProfileCache, type UserProfile } from './profile/cache.js';

// Browse
export { BrowseManager } from './browse/manager.js';

// CBOR / signing utilities
export {
  encodeCanonical,
  getDownloadReceiptSignableBytes,
  getCollectionSignableBytes,
  getReputationReportSignableBytes,
  getDirectMessageSignableBytes,
  hexToBytes,
  bytesToHex,
} from './utils/cbor.js';
