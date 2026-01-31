/**
 * Core types for the Overlay Network
 * PRD Section 13 - Protocol definitions
 */

// ============================================
// Identity Types
// ============================================

/** 32-byte Ed25519 public key in hex */
export type PublicKeyHex = string;

/** 64-byte Ed25519 signature in hex */
export type SignatureHex = string;

/** 32-byte BLAKE3 content hash in hex */
export type ContentHash = string;

/** User fingerprint derived from pubkey (first 6-8 chars of SHA-256(pubkey)) */
export type Fingerprint = string;

/** Display handle like @username */
export type Handle = string;

// ============================================
// File Extension Enum
// ============================================

export const FILE_EXTENSIONS = [
  'mp3', 'flac', 'wav', 'aac', 'ogg', 'opus', 'wma', 'm4a', 'aiff',
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff',
  'pdf', 'epub', 'mobi', 'txt', 'doc', 'docx',
  'zip', 'rar', '7z', 'tar', 'gz',
  'other'
] as const;

export type FileExtension = typeof FILE_EXTENSIONS[number];

// ============================================
// Posting Types (PRD Section 5.2)
// ============================================

/**
 * Compact provider record stored under token in the inverted index
 */
export interface Posting {
  /** BLAKE3 hash of file content (32 bytes hex) */
  contentHash: ContentHash;

  /** Provider's Ed25519 public key (32 bytes hex) */
  providerPubKey: PublicKeyHex;

  /** File size in bytes */
  size: number;

  /** File extension */
  ext: FileExtension;

  /** Truncated filename (max 96 bytes) */
  filenameShort?: string;

  /** Publish timestamp (ms since epoch) */
  ts: number;

  /** Time-to-live in milliseconds */
  ttlMs: number;

  /** Signature over canonical CBOR bytes */
  sig: SignatureHex;

  /** Audio bitrate in bits per second (e.g., 320000 for 320kbps) */
  bitrate?: number;

  /** Duration in seconds */
  duration?: number;

  /** Video width in pixels */
  width?: number;

  /** Video height in pixels */
  height?: number;
}

/**
 * Token with associated posting for publishing
 */
export interface TokenPosting {
  token: string;
  contentHash: ContentHash;
  size: number;
  ext: FileExtension;
  filenameShort?: string;
  /** Parent folder name (privacy-safe, not full path) */
  folderPath?: string;
  /** Audio bitrate in bits per second (e.g., 320000 for 320kbps) */
  bitrate?: number;
  /** Duration in seconds */
  duration?: number;
  /** Video width in pixels */
  width?: number;
  /** Video height in pixels */
  height?: number;
}

// ============================================
// Message Types (PRD Section 13)
// ============================================

export type MessageType =
  | 'PUBLISH'
  | 'REFRESH'
  | 'TOMBSTONE'
  | 'QUERY'
  | 'QUERY_RESPONSE'
  | 'PRESENCE'
  | 'RELAY_HELLO'
  | 'PROFILE_REQUEST'
  | 'PROFILE_RESPONSE'
  | 'BROWSE_REQUEST'
  | 'BROWSE_RESPONSE';

/**
 * PUBLISH message - announce files to indexers
 */
export interface PublishMessage {
  type: 'PUBLISH';
  providerPubKey: PublicKeyHex;
  ts: number;
  ttlMs: number;
  postings: TokenPosting[];
  sig: SignatureHex;
}

/**
 * REFRESH message - extend TTL of existing postings
 */
export interface RefreshMessage {
  type: 'REFRESH';
  providerPubKey: PublicKeyHex;
  ts: number;
  ttlMs: number;
  /** List of (token, contentHash) pairs to refresh */
  items: Array<{ token: string; contentHash: ContentHash }>;
  sig: SignatureHex;
}

/**
 * TOMBSTONE message - remove postings
 */
export interface TombstoneMessage {
  type: 'TOMBSTONE';
  providerPubKey: PublicKeyHex;
  ts: number;
  removals: Array<{ token: string; contentHash: ContentHash }>;
  sig: SignatureHex;
}

/**
 * Query filters
 */
export interface QueryFilters {
  ext?: FileExtension[];
  minSize?: number;
  maxSize?: number;
}

/**
 * QUERY message - search for files
 */
export interface QueryMessage {
  type: 'QUERY';
  tokens: string[];
  filters?: QueryFilters;
  limit?: number;
  cursor?: string | null;
}

/**
 * Query result item
 */
export interface QueryResultItem {
  contentHash: ContentHash;
  providers: Array<{
    pubKey: PublicKeyHex;
    size: number;
    ext: FileExtension;
    filenameShort?: string;
    /** Parent folder name (privacy-safe, not full path) */
    folderPath?: string;
    ts: number;
    /** Audio bitrate in bits per second */
    bitrate?: number;
    /** Duration in seconds */
    duration?: number;
    /** Video width in pixels */
    width?: number;
    /** Video height in pixels */
    height?: number;
  }>;
  /** Match score for ranking */
  score: number;
}

/**
 * QUERY_RESPONSE message
 */
export interface QueryResponseMessage {
  type: 'QUERY_RESPONSE';
  results: QueryResultItem[];
  cursor?: string | null;
  totalHits?: number;
}

// ============================================
// Presence Types (PRD Section 7, 13.4)
// ============================================

export interface ProviderCapabilities {
  /** Supports relay transport */
  relay: boolean;
  /** Supports metadata fetch */
  metaFetch: boolean;
  /** Supports direct transfer */
  direct: boolean;
}

/**
 * PRESENCE beacon message
 */
export interface PresenceMessage {
  type: 'PRESENCE';
  providerPubKey: PublicKeyHex;
  ts: number;
  ttlMs: number;
  capabilities: ProviderCapabilities;
  sig: SignatureHex;
}

/**
 * Profile data (fetched lazily)
 */
export interface Profile {
  providerPubKey: PublicKeyHex;
  displayName?: string;
  handle?: Handle;
  capabilities: ProviderCapabilities;
  ts: number;
  sig: SignatureHex;
}

export interface ProfileRequestMessage {
  type: 'PROFILE_REQUEST';
  providerPubKey: PublicKeyHex;
}

export interface ProfileResponseMessage {
  type: 'PROFILE_RESPONSE';
  profile: Profile | null;
}

// ============================================
// Relay Types (PRD Section 8.3, 13.5)
// ============================================

export type RelayRole = 'requester' | 'provider';

/**
 * RELAY_HELLO handshake message
 */
export interface RelayHelloMessage {
  type: 'RELAY_HELLO';
  sessionId: string;
  role: RelayRole;
}

// ============================================
// Transfer Types
// ============================================

export interface TransferRequest {
  contentHash: ContentHash;
  /** Optional byte range for resumption */
  rangeStart?: number;
  rangeEnd?: number;
}

export interface TransferMetadata {
  contentHash: ContentHash;
  size: number;
  /** Chunk size for partial verification */
  chunkSize: number;
  /** Number of chunks */
  chunkCount: number;
}

export type TransferStatus =
  | 'pending'
  | 'connecting'
  | 'downloading'
  | 'verifying'
  | 'completed'
  | 'failed';

export interface TransferProgress {
  contentHash: ContentHash;
  status: TransferStatus;
  bytesDownloaded: number;
  totalBytes: number;
  chunksVerified: number;
  totalChunks: number;
  /** Transport method used */
  transport: 'direct' | 'relay' | 'soulseek';
}

// ============================================
// Sharding Types (PRD Section 5.3)
// ============================================

/** Number of shards (4096 = 2^12) */
export const SHARD_COUNT = 4096;

/** Shard ID (0 to SHARD_COUNT-1) */
export type ShardId = number;

/** Topic format for shard discovery */
export const shardTopic = (shardId: ShardId): string =>
  `idx-shard-v1:${shardId}`;

// ============================================
// Local Database Types
// ============================================

/**
 * File entry in local database
 */
export interface LocalFileEntry {
  /** Full path to file */
  path: string;
  /** BLAKE3 content hash */
  contentHash: ContentHash;
  /** File size */
  size: number;
  /** Last modified time */
  mtime: number;
  /** File extension */
  ext: FileExtension;
  /** Extracted tokens */
  tokens: string[];
  /** Last publish timestamp */
  lastPublished?: number;
  /** Parent folder name (privacy-safe, not full path) */
  folderPath?: string;
  /** Audio bitrate in bits per second (e.g., 320000 for 320kbps) */
  bitrate?: number;
  /** Duration in seconds */
  duration?: number;
  /** Video width in pixels */
  width?: number;
  /** Video height in pixels */
  height?: number;
}

/**
 * Reputation entry for a provider
 */
export interface ProviderReputation {
  pubKey: PublicKeyHex;
  successfulTransfers: number;
  failedTransfers: number;
  totalBytesReceived: number;
  avgTimeToFirstByte: number;
  directConnections: number;
  relayConnections: number;
  lastSeen: number;
  blocked: boolean;
}

// ============================================
// Search Result Types (client-side)
// ============================================

export type ResultSource = 'overlay' | 'soulseek';

export type ConnectionQuality = 'direct' | 'relay' | 'unknown';

export interface SearchResult {
  /** Unique ID for deduplication */
  id: string;
  contentHash?: ContentHash;
  filename: string;
  path?: string;
  /** Parent folder name (privacy-safe, not full path) */
  folderPath?: string;
  size: number;
  ext: FileExtension;
  source: ResultSource;
  connectionQuality: ConnectionQuality;
  providers: Array<{
    pubKey?: PublicKeyHex;
    username?: string;
    reputation?: ProviderReputation;
  }>;
  /** Combined ranking score */
  score: number;
  /** Audio bitrate in bits per second (e.g., 320000 for 320kbps) */
  bitrate?: number;
  /** Duration in seconds */
  duration?: number;
  /** Video width in pixels */
  width?: number;
  /** Video height in pixels */
  height?: number;
}

// ============================================
// Error Types
// ============================================

export type OverlayErrorCode =
  | 'INVALID_SIGNATURE'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'INVALID_PAYLOAD'
  | 'INDEXER_UNAVAILABLE'
  | 'RELAY_UNAVAILABLE'
  | 'TRANSFER_FAILED'
  | 'HASH_MISMATCH'
  | 'CONNECTION_FAILED'
  | 'TIMEOUT';

export class OverlayError extends Error {
  constructor(
    public code: OverlayErrorCode,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'OverlayError';
  }
}

// ============================================
// Configuration Types
// ============================================

export interface OverlayConfig {
  /** Bootstrap node addresses */
  bootstrapNodes: string[];

  /** Known relay addresses */
  relayNodes: string[];

  /** Known indexer addresses (optional, can discover) */
  indexerNodes?: string[];

  /** Default TTL for postings (ms) */
  defaultTtlMs: number;

  /** Refresh interval for postings (ms) */
  refreshIntervalMs: number;

  /** Presence beacon interval (ms) */
  presenceIntervalMs: number;

  /** Query timeout (ms) */
  queryTimeoutMs: number;

  /** Transfer timeout (ms) */
  transferTimeoutMs: number;

  /** Number of indexers to query per shard */
  indexerReplicationK: number;

  /** Enable Soulseek fallback (Phase 1) */
  soulseekFallbackEnabled: boolean;
}

export const DEFAULT_CONFIG: OverlayConfig = {
  bootstrapNodes: [],
  relayNodes: [],
  defaultTtlMs: 24 * 60 * 60 * 1000, // 24 hours
  refreshIntervalMs: 12 * 60 * 60 * 1000, // 12 hours
  presenceIntervalMs: 2 * 60 * 1000, // 2 minutes
  queryTimeoutMs: 10 * 1000, // 10 seconds
  transferTimeoutMs: 5 * 60 * 1000, // 5 minutes
  indexerReplicationK: 5,
  soulseekFallbackEnabled: true,
};

// ============================================
// Browse Types
// ============================================

/**
 * File entry for browse response (privacy-safe - relative paths only)
 */
export interface OverlayBrowseFile {
  /** Relative path (privacy-safe, no absolute paths) */
  path: string;
  /** Filename */
  filename: string;
  /** File size in bytes */
  size: number;
  /** BLAKE3 content hash */
  contentHash: ContentHash;
  /** File extension */
  ext: FileExtension;
  /** Audio bitrate in bits per second */
  bitrate?: number;
  /** Duration in seconds */
  duration?: number;
  /** Video width in pixels */
  width?: number;
  /** Video height in pixels */
  height?: number;
}

/**
 * BROWSE_REQUEST message - request to browse a provider's files
 */
export interface BrowseRequestMessage {
  type: 'BROWSE_REQUEST';
  requesterPubKey: PublicKeyHex;
  ts: number;
  sig: SignatureHex;
}

/**
 * BROWSE_RESPONSE message - response with provider's file list
 */
export interface BrowseResponseMessage {
  type: 'BROWSE_RESPONSE';
  providerPubKey: PublicKeyHex;
  ts: number;
  files: OverlayBrowseFile[];
  sig: SignatureHex;
}

// ============================================
// Union Types for Message Handling
// ============================================

export type IndexerMessage =
  | PublishMessage
  | RefreshMessage
  | TombstoneMessage
  | QueryMessage;

export type IndexerResponse = QueryResponseMessage;

export type PeerMessage =
  | PresenceMessage
  | ProfileRequestMessage
  | ProfileResponseMessage
  | RelayHelloMessage
  | BrowseRequestMessage
  | BrowseResponseMessage;

export type AnyMessage = IndexerMessage | IndexerResponse | PeerMessage;
