/**
 * Soulseek Bridge - Dual operation mode for hybrid search/download
 * PRD Section 6 - Dual Discovery Strategy
 */

import { EventEmitter } from 'events';
import { rename, unlink } from 'fs/promises';
import type {
  ContentHash,
  PublicKeyHex,
  SearchResult,
  TransferProgress,
  TransferStatus,
  OverlayBrowseFile,
  BrowseResponseMessage,
  DirectMessage,
  DirectMessageAck,
} from '../types.js';
import { QueryRouter } from '../search/query.js';
import { DirectTransport } from '../transport/direct.js';
import { RelayTransport } from '../transport/relay.js';
import { ReputationManager, TransferOutcome } from '../reputation/index.js';
import { PresenceBeacon } from '../presence/beacon.js';
import { BrowseManager } from '../browse/manager.js';
import { LocalDatabase } from '../localdb/index.js';
import { IdentityManager, computeFingerprint } from '../identity/index.js';
import { Publisher } from '../publish/publisher.js';
import { ProfileCache, type UserProfile } from '../profile/cache.js';
import { getDirectMessageSignableBytes } from '../utils/cbor.js';
import { hashBytes } from '../publish/hasher.js';

/**
 * Transfer ladder step
 */
type TransferMethod = 'direct' | 'relay' | 'soulseek';

/**
 * Soulseek result from external client
 */
export interface SoulseekSearchResult {
  filename: string;
  size: number;
  bitrate?: number;
  duration?: number;
  username: string;
  freeUploadSlots?: boolean;
  uploadSpeed?: number;
  path?: string;
}

/**
 * Soulseek transfer callbacks
 */
export interface SoulseekBridgeCallbacks {
  search: (query: string, timeout: number) => Promise<SoulseekSearchResult[]>;
  download: (username: string, filename: string, destPath: string) => Promise<boolean>;
  getFileHash?: (username: string, filename: string) => Promise<string | null>;
}

/**
 * Bridge configuration
 */
interface BridgeConfig {
  preferOverlay: boolean;
  overlaySearchTimeoutMs: number;
  soulseekSearchTimeoutMs: number;
  directTimeoutMs: number;
  relayTimeoutMs: number;
  maxRetries: number;
  relayUrls: string[];
  soulseekFallbackEnabled: boolean;
  bootstrapUrl?: string;
}

const DEFAULT_CONFIG: BridgeConfig = {
  preferOverlay: true,
  overlaySearchTimeoutMs: 5000,
  soulseekSearchTimeoutMs: 15000,
  directTimeoutMs: 30000,
  relayTimeoutMs: 60000,
  maxRetries: 3,
  relayUrls: [],
  soulseekFallbackEnabled: true,
  bootstrapUrl: undefined,
};

/**
 * Unified search result with source info
 */
export interface UnifiedSearchResult {
  id: string;
  filename: string;
  size: number;
  source: 'overlay' | 'soulseek' | 'both';

  // Overlay-specific
  contentHash?: ContentHash;
  overlayProviders?: Array<{ pubKey: PublicKeyHex; fingerprint?: string }>;
  /** Parent folder name (privacy-safe, from overlay) */
  folderPath?: string;

  // Soulseek-specific
  soulseekUsername?: string;
  soulseekPath?: string;
  uploadSpeed?: number;

  // Media metadata (from overlay or soulseek)
  /** Audio bitrate in bits per second (e.g., 320000 for 320kbps) */
  bitrate?: number;
  /** Duration in seconds */
  duration?: number;
  /** Video width in pixels */
  width?: number;
  /** Video height in pixels */
  height?: number;

  // Computed
  score: number;
  connectionQuality: 'direct' | 'relay' | 'soulseek' | 'unknown';
}

/**
 * Transfer state
 */
interface TransferState {
  id: string;
  result: UnifiedSearchResult;
  destPath: string;
  status: TransferStatus;
  method: TransferMethod | null;
  bytesTransferred: number;
  totalBytes: number;
  startTime: number;
  attempts: number;
  lastError?: string;
}

/**
 * Soulseek Bridge
 * Provides unified search and download across overlay and Soulseek
 */
export class SoulseekBridge extends EventEmitter {
  private config: BridgeConfig;
  private soulseekCallbacks: SoulseekBridgeCallbacks | null = null;
  private queryRouter: QueryRouter | null = null;
  private directTransport: DirectTransport | null = null;
  private relayTransport: RelayTransport | null = null;
  private reputation: ReputationManager | null = null;
  private beacon: PresenceBeacon | null = null;
  private browseManager: BrowseManager | null = null;
  private publisher: Publisher | null = null;
  private identity: IdentityManager | null = null;
  private profileCache: ProfileCache | null = null;
  private directMessageHandler: ((msg: DirectMessage) => void) | null = null;
  private activeTransfers: Map<string, TransferState> = new Map();
  private lastProgressEmit: Map<string, { time: number; status: TransferStatus }> = new Map();
  private readonly progressEmitIntervalMs = 200;
  private pendingBrowses: Map<string, {
    resolve: (files: OverlayBrowseFile[]) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  private initialized = false;

  constructor(config: Partial<BridgeConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the bridge
   */
  async initialize(options: {
    myPubKey: PublicKeyHex;
    indexerUrls: string[];
    dbPath: string;
    soulseekCallbacks?: SoulseekBridgeCallbacks;
    identity?: IdentityManager;
    localDb?: LocalDatabase;
    publisher?: Publisher;
    profileCache?: ProfileCache;
  }): Promise<void> {
    // Store publisher if provided
    if (options.publisher) {
      this.publisher = options.publisher;
    }

    // Store identity for message signing
    if (options.identity) {
      this.identity = options.identity;
    }

    // Store profile cache for capability discovery
    if (options.profileCache) {
      this.profileCache = options.profileCache;
    }

    // Initialize overlay components
    this.queryRouter = new QueryRouter(options.indexerUrls);
    this.directTransport = new DirectTransport(options.myPubKey);
    this.relayTransport = new RelayTransport(this.config.relayUrls);
    this.reputation = new ReputationManager(options.dbPath);
    this.beacon = new PresenceBeacon(options.myPubKey);

    // Initialize browse manager if identity and localDb provided
    if (options.identity && options.localDb) {
      this.browseManager = new BrowseManager(options.identity, options.localDb);

      // Set up browse request handler for direct transport
      this.directTransport.setBrowseRequestHandler((msg) => {
        return this.browseManager?.handleBrowseRequest(msg) || null;
      });

      // Set up browse request handler for relay transport
      this.relayTransport.setBrowseRequestHandler((msg) => {
        return this.browseManager?.handleBrowseRequest(msg) || null;
      });

      // Set up browse response handler
      this.directTransport.on('browse:response', (response: BrowseResponseMessage) => {
        this.handleBrowseResponse(response);
      });
    }

    // Wire up direct message handlers on both transports
    this.directTransport.setDirectMessageHandler((msg: DirectMessage) => {
      if (this.directMessageHandler) {
        this.directMessageHandler(msg);
      }
    });

    this.relayTransport.setDirectMessageHandler((msg: DirectMessage) => {
      if (this.directMessageHandler) {
        this.directMessageHandler(msg);
      }
    });

    // Initialize transports
    await this.directTransport.initialize();
    await this.beacon.initialize();

    // Set up progress forwarding
    this.directTransport.on('progress', (p: TransferProgress) => this.handleProgress(p));
    this.relayTransport.on('progress', (p: TransferProgress) => this.handleProgress(p));

    // Set Soulseek callbacks
    if (options.soulseekCallbacks) {
      this.soulseekCallbacks = options.soulseekCallbacks;
    }

    this.initialized = true;
  }

  /**
   * Shutdown the bridge
   */
  async shutdown(): Promise<void> {
    if (this.directTransport) {
      await this.directTransport.shutdown();
    }
    if (this.beacon) {
      await this.beacon.shutdown();
    }
    if (this.reputation) {
      this.reputation.close();
    }
    this.initialized = false;
  }

  /**
   * Set Soulseek callbacks
   */
  setSoulseekCallbacks(callbacks: SoulseekBridgeCallbacks): void {
    this.soulseekCallbacks = callbacks;
  }

  /**
   * Unified search across overlay and Soulseek
   */
  async search(query: string): Promise<UnifiedSearchResult[]> {
    if (!this.initialized) {
      throw new Error('Bridge not initialized');
    }

    const results: UnifiedSearchResult[] = [];
    const seenKeys = new Set<string>();

    // Search overlay and Soulseek in parallel
    const [overlayResults, soulseekResults] = await Promise.all([
      this.searchOverlay(query),
      this.searchSoulseek(query),
    ]);

    // Process overlay results
    for (const r of overlayResults) {
      const key = `${r.filename}:${r.size}`;
      seenKeys.add(key);

      results.push({
        id: r.contentHash || r.id,
        filename: r.filename,
        size: r.size,
        source: 'overlay',
        contentHash: r.contentHash as ContentHash,
        overlayProviders: r.providers
          .filter(p => p.pubKey !== undefined)
          .map(p => ({
            pubKey: p.pubKey as string,
            fingerprint: computeFingerprint(p.pubKey as string),
          })),
        folderPath: r.folderPath,
        score: r.score,
        connectionQuality: this.determineConnectionQuality(r),
        // Include media metadata from overlay results
        bitrate: r.bitrate,
        duration: r.duration,
        width: r.width,
        height: r.height,
      });
    }

    // Process Soulseek results
    for (const r of soulseekResults) {
      const key = `${r.filename}:${r.size}`;

      if (seenKeys.has(key)) {
        // Found in both - mark existing result
        const existing = results.find(x => `${x.filename}:${x.size}` === key);
        if (existing) {
          existing.source = 'both';
          existing.soulseekUsername = r.username;
          existing.soulseekPath = r.path;
          existing.bitrate = r.bitrate;
          existing.duration = r.duration;
          existing.uploadSpeed = r.uploadSpeed;
        }
      } else {
        // Soulseek-only result
        results.push({
          id: `ss:${r.username}:${r.filename}`,
          filename: r.filename,
          size: r.size,
          source: 'soulseek',
          soulseekUsername: r.username,
          soulseekPath: r.path,
          bitrate: r.bitrate,
          duration: r.duration,
          uploadSpeed: r.uploadSpeed,
          score: this.scoreSoulseekResult(r),
          connectionQuality: 'soulseek',
        });
      }
    }

    // Sort by preference and score
    return this.sortResults(results);
  }

  /**
   * Search overlay network
   */
  private async searchOverlay(query: string): Promise<SearchResult[]> {
    if (!this.queryRouter) return [];

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.config.overlaySearchTimeoutMs
      );

      const results = await this.queryRouter.search(query);
      clearTimeout(timeoutId);
      return results;
    } catch (err) {
      console.error('Overlay search failed:', err);
      return [];
    }
  }

  /**
   * Search Soulseek
   */
  private async searchSoulseek(query: string): Promise<SoulseekSearchResult[]> {
    if (!this.soulseekCallbacks) return [];

    try {
      return await this.soulseekCallbacks.search(query, this.config.soulseekSearchTimeoutMs);
    } catch (err) {
      console.error('Soulseek search failed:', err);
      return [];
    }
  }

  /**
   * Download a file using transfer ladder
   */
  async download(result: UnifiedSearchResult, destPath: string): Promise<boolean> {
    if (!this.initialized) {
      throw new Error('Bridge not initialized');
    }

    const transferId = result.contentHash ?? result.id;
    const state: TransferState = {
      id: transferId,
      result: { ...result, id: transferId },
      destPath,
      status: 'connecting',
      method: null,
      bytesTransferred: 0,
      totalBytes: result.size,
      startTime: Date.now(),
      attempts: 0,
    };

    this.activeTransfers.set(transferId, state);
    this.emitTransferProgress(state);

    try {
      // Try overlay methods (direct + relay) in parallel for faster startup
      // First successful method wins, then fall back to Soulseek if both fail
      let success = false;

      if (result.contentHash) {
        const overlayResult = await this.tryOverlayTransferParallel(state);
        if (overlayResult.success) {
          state.method = overlayResult.method;
          state.status = 'completed';
          this.emitTransferProgress(state);
          return true;
        }
      }

      // Fall back to Soulseek if overlay methods failed
      if (result.soulseekUsername && this.config.soulseekFallbackEnabled) {
        state.method = 'soulseek';
        success = await this.trySoulseekTransfer(state);
        if (success) {
          state.status = 'completed';
          this.emitTransferProgress(state);
          return true;
        }
      }

      // All methods failed
      state.status = 'failed';
      this.emitTransferProgress(state);
      return false;
    } finally {
      // Use transferId (not result.id) since that's what we stored under
      this.activeTransfers.delete(transferId);
      this.lastProgressEmit.delete(transferId);
    }
  }

  /**
   * Try direct and relay transfers in parallel
   * First successful method wins, avoiding the 30s direct timeout blocking relay
   */
  private async tryOverlayTransferParallel(
    state: TransferState
  ): Promise<{ success: boolean; method: TransferMethod | null }> {
    const hasProviders = state.result.overlayProviders?.length;
    const canDirect =
      this.directTransport && state.result.contentHash && hasProviders;
    const canRelay =
      this.relayTransport && this.config.relayUrls.length > 0 && hasProviders;

    if (!canDirect && !canRelay) {
      return { success: false, method: null };
    }

    // Use temp files to avoid write conflicts between parallel transfers
    const directTempPath = `${state.destPath}.direct.tmp`;
    const relayTempPath = `${state.destPath}.relay.tmp`;

    // Collect errors from both methods for final error reporting
    const errors: { method: TransferMethod; error: string }[] = [];

    type TransferResult = {
      method: TransferMethod;
      success: boolean;
      error?: string;
    };
    const promises: Promise<TransferResult>[] = [];

    if (canDirect) {
      promises.push(
        this.tryDirectTransfer(state, directTempPath)
          .then((success) => ({
            method: 'direct' as const,
            success,
            error: success ? undefined : state.lastError,
          }))
          .catch((err) => ({
            method: 'direct' as const,
            success: false,
            error: err.message,
          }))
      );
    }

    if (canRelay) {
      promises.push(
        this.tryRelayTransfer(state, relayTempPath)
          .then((success) => ({
            method: 'relay' as const,
            success,
            error: success ? undefined : state.lastError,
          }))
          .catch((err) => ({
            method: 'relay' as const,
            success: false,
            error: err.message,
          }))
      );
    }

    // Race for first success, but don't reject if one fails
    return new Promise((resolve) => {
      let resolved = false;
      let failCount = 0;

      for (const promise of promises) {
        promise.then(async (result) => {
          if (resolved) {
            // Another method already won - clean up this temp file
            const tempPath =
              result.method === 'direct' ? directTempPath : relayTempPath;
            await unlink(tempPath).catch(() => {});
            return;
          }

          if (result.success) {
            // Move winning temp file to final destination
            const tempPath =
              result.method === 'direct' ? directTempPath : relayTempPath;
            try {
              await rename(tempPath, state.destPath);
              // Only mark as resolved AFTER successful rename
              resolved = true;
              state.method = result.method;
              resolve({ success: true, method: result.method });
            } catch (err: any) {
              // Rename failed - check if file already exists (other method won)
              if (err.code === 'EEXIST' || err.code === 'ENOTEMPTY') {
                // Other method already completed - treat as success
                await unlink(tempPath).catch(() => {});
                // Don't resolve here - let the other method's success handler do it
                return;
              }
              // Some other rename error - record it and continue
              errors.push({ method: result.method, error: err.message });
              await unlink(tempPath).catch(() => {});
              failCount++;
              if (failCount === promises.length) {
                state.lastError = errors.map((e) => `${e.method}: ${e.error}`).join('; ');
                resolve({ success: false, method: null });
              }
            }
          } else {
            // Transfer failed
            if (result.error) {
              errors.push({ method: result.method, error: result.error });
            }
            failCount++;
            // Clean up failed temp file
            const tempPath =
              result.method === 'direct' ? directTempPath : relayTempPath;
            await unlink(tempPath).catch(() => {});

            if (failCount === promises.length) {
              // All methods failed - propagate errors to state
              state.lastError = errors.map((e) => `${e.method}: ${e.error}`).join('; ');
              resolve({ success: false, method: null });
            }
          }
        });
      }
    });
  }

  /**
   * Hedged provider transfer - starts providers incrementally with delays.
   * First success wins, remaining attempts are cleaned up.
   */
  private async hedgedProviderTransfer(
    providers: Array<{ pubKey: PublicKeyHex; fingerprint?: string }>,
    attemptFn: (provider: { pubKey: PublicKeyHex; fingerprint?: string }, tempPath: string) => Promise<boolean>,
    baseTempPath: string,
    hedgeDelayMs: number,
    maxConcurrent = 3,
  ): Promise<{ success: boolean; winnerTempPath?: string }> {
    if (providers.length === 0 || maxConcurrent <= 0) {
      return { success: false };
    }

    const limit = Math.min(providers.length, maxConcurrent);
    const activePaths: string[] = [];
    let resolved = false;

    return new Promise((resolve) => {
      let started = 0;
      let finished = 0;

      const startNext = () => {
        if (resolved || started >= limit) return;

        const idx = started;
        started++;
        const tempPath = `${baseTempPath}.hedge${idx}.tmp`;
        activePaths.push(tempPath);

        attemptFn(providers[idx], tempPath)
          .then(async (success) => {
            finished++;
            if (resolved) {
              // Another provider won - clean up
              await unlink(tempPath).catch(() => {});
              return;
            }
            if (success) {
              resolved = true;
              resolve({ success: true, winnerTempPath: tempPath });
              // Clean up other temp files
              for (const p of activePaths) {
                if (p !== tempPath) {
                  unlink(p).catch(() => {});
                }
              }
            } else if (finished >= started) {
              // All started attempts have finished and failed
              await unlink(tempPath).catch(() => {});
              if (started < limit) {
                startNext();
              } else {
                resolve({ success: false });
              }
            }
          })
          .catch(async () => {
            finished++;
            await unlink(tempPath).catch(() => {});
            if (resolved) return;
            if (finished >= started) {
              if (started < limit) {
                startNext();
              } else {
                resolve({ success: false });
              }
            }
          });

        // Schedule next hedge after delay
        if (started < limit) {
          setTimeout(() => {
            if (!resolved) {
              startNext();
            }
          }, hedgeDelayMs);
        }
      };

      // Start first provider immediately
      startNext();
    });
  }

  /**
   * Try direct P2P transfer
   * @param destPathOverride - Optional path to write to instead of state.destPath (for parallel transfers)
   */
  private async tryDirectTransfer(
    state: TransferState,
    destPathOverride?: string
  ): Promise<boolean> {
    if (
      !this.directTransport ||
      !state.result.contentHash ||
      !state.result.overlayProviders
    ) {
      return false;
    }

    const writePath = destPathOverride ?? state.destPath;
    const providers = state.result.overlayProviders;

    // Sort providers by reputation
    if (this.reputation) {
      const pubKeys = providers.map((p) => p.pubKey);
      const sorted = this.reputation.sortByReputation(pubKeys);
      providers.sort((a, b) => sorted.indexOf(a.pubKey) - sorted.indexOf(b.pubKey));
    }

    // Use hedged provider transfer instead of sequential loop
    const maxHedge = Math.min(3, this.config.maxRetries - state.attempts);
    const result = await this.hedgedProviderTransfer(
      providers,
      async (provider, tempPath) => {
        state.attempts++;
        state.method = 'direct';
        state.status = 'downloading';
        this.emitTransferProgress(state);

        try {
          const startTime = Date.now();
          const success = await this.directTransport!.requestFile(
            state.result.contentHash!,
            provider.pubKey,
            tempPath
          );

          const duration = Date.now() - startTime;

          if (success && this.reputation) {
            this.reputation.recordTransfer(
              provider.pubKey,
              state.result.contentHash!,
              'success',
              state.totalBytes,
              duration
            );
            if (this.identity) {
              this.reputation.submitReport(this.identity, provider.pubKey, 'success', state.totalBytes, duration);
            }
          }

          if (!success && this.reputation) {
            this.reputation.recordTransfer(provider.pubKey, state.result.contentHash!, 'refused', 0, 0);
            if (this.identity) {
              this.reputation.submitReport(this.identity, provider.pubKey, 'refused', 0, 0);
            }
          }

          return success;
        } catch (err: any) {
          state.lastError = err.message;

          if (this.reputation) {
            const directOutcome: TransferOutcome = err.message.includes('timeout') ? 'timeout' : 'refused';
            this.reputation.recordTransfer(
              provider.pubKey,
              state.result.contentHash!,
              directOutcome,
              0,
              0
            );
            if (this.identity) {
              this.reputation.submitReport(this.identity, provider.pubKey, directOutcome, 0, 0);
            }
          }

          return false;
        }
      },
      writePath,
      3000, // 3s hedge delay for direct
      maxHedge,
    );

    if (result.success && result.winnerTempPath) {
      await rename(result.winnerTempPath, writePath);
      return true;
    }

    return false;
  }

  /**
   * Try relay transfer
   * Uses pubKey-based routing where providers maintain persistent relay connections
   * @param destPathOverride - Optional path to write to instead of state.destPath (for parallel transfers)
   */
  private async tryRelayTransfer(
    state: TransferState,
    destPathOverride?: string
  ): Promise<boolean> {
    if (
      !this.relayTransport ||
      !state.result.contentHash ||
      !state.result.overlayProviders?.length
    ) {
      return false;
    }

    const writePath = destPathOverride ?? state.destPath;

    // Sort providers by reputation
    const providers = [...state.result.overlayProviders];
    if (this.reputation) {
      const pubKeys = providers.map((p) => p.pubKey);
      const sorted = this.reputation.sortByReputation(pubKeys);
      providers.sort((a, b) => sorted.indexOf(a.pubKey) - sorted.indexOf(b.pubKey));
    }

    // Use hedged provider transfer instead of sequential loop
    const maxHedge = Math.min(3, this.config.maxRetries - state.attempts);
    const result = await this.hedgedProviderTransfer(
      providers,
      async (provider, tempPath) => {
        state.attempts++;
        state.method = 'relay';
        state.status = 'downloading';
        state.lastError = undefined;
        this.emitTransferProgress(state);

        console.log(
          `Attempting relay transfer from provider ${provider.pubKey.slice(0, 16)}...`
        );

        try {
          const startTime = Date.now();
          const success = await this.relayTransport!.requestFileFromProvider(
            state.result.contentHash!,
            provider.pubKey,
            tempPath
          );

          const duration = Date.now() - startTime;

          if (success && this.reputation) {
            this.reputation.recordTransfer(
              provider.pubKey,
              state.result.contentHash!,
              'success',
              state.totalBytes,
              duration
            );
            if (this.identity) {
              this.reputation.submitReport(this.identity, provider.pubKey, 'success', state.totalBytes, duration);
            }
          }

          return success;
        } catch (err: any) {
          console.error(`Relay transfer from ${provider.pubKey.slice(0, 16)} failed:`, err.message);
          state.lastError = err.message;

          if (this.reputation) {
            const relayOutcome: TransferOutcome = err.message.includes('timeout') ? 'timeout' : 'refused';
            this.reputation.recordTransfer(
              provider.pubKey,
              state.result.contentHash!,
              relayOutcome,
              0,
              0
            );
            if (this.identity) {
              this.reputation.submitReport(this.identity, provider.pubKey, relayOutcome, 0, 0);
            }
          }

          return false;
        }
      },
      writePath,
      5000, // 5s hedge delay for relay
      maxHedge,
    );

    if (result.success && result.winnerTempPath) {
      await rename(result.winnerTempPath, writePath);
      return true;
    }

    return false;
  }

  /**
   * Try Soulseek fallback
   */
  private async trySoulseekTransfer(state: TransferState): Promise<boolean> {
    if (!this.soulseekCallbacks || !state.result.soulseekUsername) {
      return false;
    }

    try {
      state.status = 'downloading';
      this.emitTransferProgress(state);

      const filename = state.result.soulseekPath || state.result.filename;
      return await this.soulseekCallbacks.download(
        state.result.soulseekUsername,
        filename,
        state.destPath
      );
    } catch (err: any) {
      state.lastError = err.message;
      return false;
    }
  }

  /**
   * Handle progress updates from transports
   */
  private handleProgress(progress: TransferProgress): void {
    const state = this.activeTransfers.get(progress.contentHash);
    if (state) {
      state.bytesTransferred = progress.bytesDownloaded;
      state.status = progress.status;
      // Update method based on which transport is reporting progress
      // This ensures correct method is shown even during parallel transfers
      if (progress.transport === 'direct' || progress.transport === 'relay') {
        state.method = progress.transport;
      }

      const now = Date.now();
      const last = this.lastProgressEmit.get(state.id);
      const statusChanged = !last || last.status !== progress.status;
      const isTerminal = progress.status === 'completed' || progress.status === 'failed';
      const shouldEmit =
        isTerminal ||
        statusChanged ||
        !last ||
        (now - last.time >= this.progressEmitIntervalMs);

      if (!shouldEmit) {
        return;
      }

      this.lastProgressEmit.set(state.id, { time: now, status: progress.status });
      this.emitTransferProgress(state);
    }
  }

  /**
   * Emit transfer progress event
   * Includes full metadata (filename, localPath, remotePath, username) so UI can display properly
   */
  private emitTransferProgress(state: TransferState): void {
    // Build username from source - overlay providers or soulseek username
    let username: string;
    if (state.result.soulseekUsername) {
      username = `soulseek:${state.result.soulseekUsername}`;
    } else if (state.result.overlayProviders?.[0]?.pubKey) {
      username = `overlay:${state.result.overlayProviders[0].pubKey}`;
    } else {
      username = 'unknown';
    }

    // Build remotePath from folderPath + filename
    const remotePath = state.result.folderPath
      ? `${state.result.folderPath}/${state.result.filename}`
      : state.result.filename;

    this.emit('transfer:progress', {
      id: state.id,
      status: state.status,
      method: state.method,
      bytesTransferred: state.bytesTransferred,
      totalBytes: state.totalBytes,
      progress: state.totalBytes > 0 ? state.bytesTransferred / state.totalBytes : 0,
      elapsed: Date.now() - state.startTime,
      error: state.lastError,
      // Include metadata for proper UI display
      filename: state.result.filename,
      localPath: state.destPath,
      remotePath,
      username,
    });
  }

  /**
   * Determine connection quality for overlay result
   */
  private determineConnectionQuality(result: SearchResult): 'direct' | 'relay' | 'unknown' {
    // In real implementation, this would check presence beacons
    // For now, assume unknown
    return 'unknown';
  }

  /**
   * Score a Soulseek result
   */
  private scoreSoulseekResult(result: SoulseekSearchResult): number {
    let score = 50; // Base score

    // Bonus for free slots
    if (result.freeUploadSlots) {
      score += 20;
    }

    // Bonus for upload speed
    if (result.uploadSpeed) {
      score += Math.min(20, result.uploadSpeed / 1000); // 1KB/s = 1 point
    }

    return score;
  }

  /**
   * Sort results by preference and score
   */
  private sortResults(results: UnifiedSearchResult[]): UnifiedSearchResult[] {
    return results.sort((a, b) => {
      // Prefer overlay if configured
      if (this.config.preferOverlay) {
        if (a.source === 'both' && b.source !== 'both') return -1;
        if (b.source === 'both' && a.source !== 'both') return 1;
        if (a.source === 'overlay' && b.source === 'soulseek') return -1;
        if (b.source === 'overlay' && a.source === 'soulseek') return 1;
      }

      // Then by score
      return b.score - a.score;
    });
  }

  /**
   * Get active transfer count
   */
  getActiveTransferCount(): number {
    return this.activeTransfers.size;
  }

  /**
   * Get transfer state
   */
  getTransferState(id: string): TransferState | null {
    return this.activeTransfers.get(id) || null;
  }

  /**
   * Cancel a transfer
   */
  cancelTransfer(id: string): boolean {
    const state = this.activeTransfers.get(id);
    if (!state) return false;

    state.status = 'failed';
    state.lastError = 'Cancelled';
    this.emitTransferProgress(state);
    this.activeTransfers.delete(id);
    this.lastProgressEmit.delete(id);
    return true;
  }

  /**
   * Update relay URLs
   */
  updateRelayUrls(urls: string[]): void {
    this.config.relayUrls = urls;
    if (this.relayTransport) {
      this.relayTransport.updateRelays(urls);
    }
  }

  /**
   * Enable or disable Soulseek fallback
   */
  setSoulseekFallbackEnabled(enabled: boolean): void {
    this.config.soulseekFallbackEnabled = enabled;
  }

  /**
   * Register as a provider with the relay server
   * This enables other peers to download from us via relay when direct fails
   */
  async registerWithRelay(): Promise<void> {
    if (!this.relayTransport || !this.directTransport) {
      console.log('Cannot register with relay: transport not initialized');
      return;
    }

    if (this.config.relayUrls.length === 0) {
      console.log('Cannot register with relay: no relay URLs configured');
      return;
    }

    // Get our pubKey from the direct transport
    const myPubKey = (this.directTransport as any).myPubKey;
    if (!myPubKey) {
      console.log('Cannot register with relay: no pubKey');
      return;
    }

    // Get the files we're providing from direct transport
    const providedFiles = (this.directTransport as any).providedFiles as Map<string, string>;
    if (!providedFiles || providedFiles.size === 0) {
      console.log('No files to provide via relay');
      return;
    }

    try {
      if (this.relayTransport.isProviderRegistered()) {
        this.relayTransport.updateProvidedFiles(providedFiles);
        console.log(
          `Updated relay provider file set: ${myPubKey.slice(0, 16)}... (${providedFiles.size} files)`
        );
        return;
      }

      await this.relayTransport.registerAsProvider(myPubKey, providedFiles);
      console.log(`Registered with relay as provider: ${myPubKey.slice(0, 16)}... (${providedFiles.size} files)`);
    } catch (err) {
      console.error('Failed to register with relay:', err);
    }
  }

  /**
   * Unregister from relay server
   */
  unregisterFromRelay(): void {
    if (this.relayTransport) {
      this.relayTransport.unregisterProvider();
    }
  }

  /**
   * Update the list of files we can provide via relay
   */
  updateRelayProvidedFiles(): void {
    if (!this.relayTransport || !this.directTransport) return;

    const providedFiles = (this.directTransport as any).providedFiles as Map<string, string>;
    if (providedFiles) {
      this.relayTransport.updateProvidedFiles(providedFiles);
    }
  }

  /**
   * Update indexer URLs
   */
  updateIndexerUrls(urls: string[]): void {
    if (this.queryRouter) {
      this.queryRouter.updateIndexers(urls);
    }
  }

  /**
   * Register a file we can provide for P2P transfers
   */
  registerProvidedFile(contentHash: ContentHash, filePath: string): void {
    if (this.directTransport) {
      this.directTransport.registerFile(contentHash, filePath);
    }
  }

  /**
   * Unregister a file from P2P transfers
   */
  unregisterProvidedFile(contentHash: ContentHash): void {
    if (this.directTransport) {
      this.directTransport.unregisterFile(contentHash);
    }
  }

  /**
   * Publish a buffer (in-memory data) to the overlay network.
   * Indexes the buffer via the Publisher, registers the file for serving,
   * and lets the normal publish cycle propagate it to indexers.
   */
  async publishBuffer(name: string, data: Buffer): Promise<void> {
    if (!this.publisher) {
      throw new Error("Publisher not available");
    }
    const entry = await this.publisher.indexBuffer(name, data);
    // Register file for serving via direct P2P
    this.registerProvidedFile(entry.contentHash, entry.path);
  }

  /**
   * Browse an overlay provider's files
   * Tries indexer first (fast HTTP), then falls back to direct P2P + relay in parallel
   */
  async browseOverlay(providerPubKey: PublicKeyHex): Promise<OverlayBrowseFile[]> {
    if (!this.initialized || !this.directTransport || !this.browseManager) {
      throw new Error('Bridge not initialized or browse not available');
    }

    // Try indexer first (fast HTTP query, no P2P needed)
    let indexerFiles: OverlayBrowseFile[] = [];
    let indexerPartial = false;
    try {
      const result = await this.browseOverlayIndexer(providerPubKey);
      indexerFiles = result.files;
      indexerPartial = result.partial;

      if (indexerFiles.length > 0 && !indexerPartial) {
        console.log(`Overlay browse: Indexer returned ${indexerFiles.length} files for ${providerPubKey.slice(0, 16)}`);
        return indexerFiles;
      }
      if (indexerFiles.length > 0 && indexerPartial) {
        console.log(`Overlay browse: Indexer returned ${indexerFiles.length} files (partial) — trying P2P for complete results`);
      } else {
        console.log('Overlay browse: Indexer returned 0 results, falling back to P2P');
      }
    } catch (err) {
      console.log('Overlay browse: Indexer failed, falling back to P2P:', (err as Error).message);
    }

    // Fall back to direct P2P + relay in parallel
    const hasRelay = !!this.relayTransport;
    let p2pFiles: OverlayBrowseFile[] = [];
    try {
      if (!hasRelay) {
        console.log('Overlay browse: No relay available, trying direct P2P only');
        p2pFiles = await this.browseOverlayDirect(providerPubKey);
      } else {
        console.log(
          'Overlay browse: Trying direct P2P and relay in parallel to',
          providerPubKey.slice(0, 16)
        );
        p2pFiles = await this.browseOverlayParallel(providerPubKey);
      }
    } catch {
      // P2P failed — fall through to return whatever we have
    }

    // Return whichever source gave more results
    if (p2pFiles.length >= indexerFiles.length) {
      return p2pFiles;
    }
    return indexerFiles;
  }

  /**
   * Browse using both direct P2P and relay in parallel - first success wins
   */
  private async browseOverlayParallel(
    providerPubKey: PublicKeyHex
  ): Promise<OverlayBrowseFile[]> {
    type BrowseResult = {
      success: boolean;
      method: 'direct' | 'relay';
      files?: OverlayBrowseFile[];
      error?: string;
    };

    const errors: { method: string; error: string }[] = [];

    // Create promises for both methods
    const directPromise: Promise<BrowseResult> = this.browseOverlayDirect(providerPubKey)
      .then((files) => ({ success: true, method: 'direct' as const, files }))
      .catch((err) => ({ success: false, method: 'direct' as const, error: err.message }));

    const relayPromise: Promise<BrowseResult> = this.browseOverlayRelay(providerPubKey)
      .then((files) => ({ success: true, method: 'relay' as const, files }))
      .catch((err) => ({ success: false, method: 'relay' as const, error: err.message }));

    const promises = [directPromise, relayPromise];

    // Race for first success
    return new Promise((resolve, reject) => {
      let resolved = false;
      let failCount = 0;

      for (const promise of promises) {
        promise.then((result) => {
          if (resolved) {
            // Another method already won
            return;
          }

          if (result.success && result.files) {
            resolved = true;
            console.log(
              `Overlay browse: ${result.method} won with ${result.files.length} files`
            );
            resolve(result.files);
          } else {
            // This method failed
            if (result.error) {
              errors.push({ method: result.method, error: result.error });
            }
            failCount++;

            if (failCount === promises.length) {
              // All methods failed
              const errorMsg = errors.map((e) => `${e.method}: ${e.error}`).join('; ');
              console.log('Overlay browse: All methods failed:', errorMsg);
              reject(new Error(`Browse failed: ${errorMsg}`));
            }
          }
        });
      }
    });
  }

  /**
   * Browse via relay transport
   */
  private async browseOverlayRelay(
    providerPubKey: PublicKeyHex
  ): Promise<OverlayBrowseFile[]> {
    if (!this.relayTransport || !this.browseManager) {
      throw new Error('Relay transport or browse manager not available');
    }

    const request = this.browseManager.createBrowseRequest();
    const response = await this.relayTransport.sendBrowseRequest(providerPubKey, request);

    // Verify signature
    const signableData = Buffer.from(
      JSON.stringify({
        type: 'BROWSE_RESPONSE',
        providerPubKey: response.providerPubKey,
        ts: response.ts,
        files: response.files,
      })
    );

    const { IdentityManager } = await import('../identity/index.js');
    if (!IdentityManager.verify(signableData, response.sig, response.providerPubKey)) {
      throw new Error('Invalid browse response signature');
    }

    // Check timestamp is recent (within 5 minutes)
    const now = Date.now();
    if (Math.abs(now - response.ts) > 5 * 60 * 1000) {
      throw new Error('Browse response timestamp invalid');
    }

    return response.files;
  }

  /**
   * Browse via indexer HTTP endpoint (fastest, no P2P needed)
   */
  private async browseOverlayIndexer(providerPubKey: PublicKeyHex): Promise<{ files: OverlayBrowseFile[]; partial: boolean }> {
    if (!this.queryRouter) {
      throw new Error('Query router not available');
    }

    const indexerUrls = this.queryRouter.getIndexerUrls();
    if (indexerUrls.length === 0) {
      throw new Error('No indexer URLs available');
    }

    // Query all indexers in parallel (files may be split across shards)
    const responses = await Promise.allSettled(
      indexerUrls.map(async (url) => {
        const res = await fetch(`${url}/v1/browse/${encodeURIComponent(providerPubKey)}?limit=5000`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          throw new Error(`Indexer ${url} returned ${res.status}`);
        }
        return res.json() as Promise<{
          providerPubKey: string;
          files: Array<{
            path: string;
            filename: string;
            size: number;
            contentHash: string;
            ext: string;
            bitrate?: number;
            duration?: number;
            width?: number;
            height?: number;
          }>;
          totalFiles: number;
          source: string;
        }>;
      })
    );

    // Merge results by contentHash (deduplicate across shards)
    const fileMap = new Map<string, OverlayBrowseFile>();
    for (const result of responses) {
      if (result.status === 'fulfilled' && result.value.files) {
        for (const file of result.value.files) {
          if (!fileMap.has(file.contentHash)) {
            fileMap.set(file.contentHash, {
              path: file.path,
              filename: file.filename,
              size: file.size,
              contentHash: file.contentHash as ContentHash,
              ext: file.ext,
              bitrate: file.bitrate,
              duration: file.duration,
              width: file.width,
              height: file.height,
            });
          }
        }
      }
    }

    const shardFailed = responses.some((r) => r.status === 'rejected');
    const truncated = responses.some(
      (r) => r.status === 'fulfilled' && r.value.totalFiles > (r.value.files?.length ?? 0)
    );
    const partial = shardFailed || truncated;

    if (shardFailed) {
      const failed = responses.filter((r) => r.status === 'rejected').length;
      console.log(`Overlay browse: ${failed}/${responses.length} indexer(s) failed — results may be incomplete`);
    }
    if (truncated) {
      console.log(`Overlay browse: Indexer results truncated by limit — results may be incomplete`);
    }

    return { files: Array.from(fileMap.values()), partial };
  }

  /**
   * Browse an overlay provider's files via direct P2P
   */
  private async browseOverlayDirect(providerPubKey: PublicKeyHex): Promise<OverlayBrowseFile[]> {
    return new Promise(async (resolve, reject) => {
      const browseId = `browse:${providerPubKey}:${Date.now()}`;

      // Set up timeout - shorter for direct (15s) to allow relay fallback
      const timeout = setTimeout(() => {
        this.pendingBrowses.delete(browseId);
        reject(new Error('Direct browse request timed out'));
      }, 15000);

      this.pendingBrowses.set(browseId, { resolve, reject, timeout });

      try {
        // Create and send browse request
        const request = this.browseManager!.createBrowseRequest();
        await this.directTransport!.sendBrowseRequest(providerPubKey, request);
      } catch (err) {
        clearTimeout(timeout);
        this.pendingBrowses.delete(browseId);
        reject(err);
      }
    });
  }

  /**
   * Send a direct message to a peer
   * Builds, signs, and sends a DirectMessage via direct P2P or relay fallback
   */
  async sendMessage(
    targetPubKey: PublicKeyHex,
    content: string,
    contentType = 'text/plain'
  ): Promise<DirectMessageAck> {
    if (!this.initialized || !this.identity) {
      throw new Error('Bridge not initialized or identity not available');
    }

    const myPubKey = this.identity.getPublicKey();
    const ts = Date.now();

    // Build the signable data
    const signableBytes = getDirectMessageSignableBytes({
      from: myPubKey,
      to: targetPubKey,
      ts,
      contentType,
      payload: content,
    });

    // Compute messageId as BLAKE3 hash of the signable bytes
    const messageId = hashBytes(signableBytes);

    // Sign the message
    const sig = this.identity.sign(signableBytes);

    const message: DirectMessage = {
      type: 'DIRECT_MESSAGE',
      messageId,
      from: myPubKey,
      to: targetPubKey,
      ts,
      contentType,
      payload: content,
      sig,
    };

    // Try direct transport first, fall back to relay (same ladder pattern as browse)
    if (this.directTransport) {
      try {
        const ack = await this.directTransport.sendDirectMessage(targetPubKey, message);
        return ack;
      } catch (err) {
        console.log('Direct message via P2P failed, trying relay:', (err as Error).message);
      }
    }

    // Fall back to relay
    if (this.relayTransport && this.config.relayUrls.length > 0) {
      const ack = await this.relayTransport.sendDirectMessage(
        targetPubKey,
        this.config.relayUrls[0],
        message
      );
      return ack;
    }

    throw new Error('No transport available for direct messaging');
  }

  /**
   * Register a handler for incoming direct messages
   */
  onMessage(handler: (msg: DirectMessage) => void): void {
    this.directMessageHandler = handler;
  }

  /**
   * Set agent capabilities and broadcast via presence beacon + auth service
   */
  async setCapabilities(capabilities: string[]): Promise<void> {
    // Update beacon for DHT-based discovery
    if (this.beacon) {
      this.beacon.setAgentCapabilities(capabilities);
    }

    // Update auth service profile for cloud-based discovery
    if (this.profileCache && this.identity) {
      try {
        const pubKey = this.identity.getPublicKey();
        await this.profileCache.updateCapabilities(pubKey, capabilities, this.identity);
      } catch (err) {
        console.error('Failed to update capabilities on auth service:', err);
      }
    }
  }

  /**
   * Find peers advertising a specific agent capability
   * Queries both DHT presence (local) and auth service (cloud)
   */
  async findPeersByCapability(capability: string): Promise<UserProfile[]> {
    const profiles: UserProfile[] = [];
    const seen = new Set<string>();

    // Query auth service for cloud-based discovery
    if (this.profileCache) {
      try {
        const cloudProfiles = await this.profileCache.findByCapability(capability);
        for (const p of cloudProfiles) {
          if (!seen.has(p.pubKey)) {
            seen.add(p.pubKey);
            profiles.push(p);
          }
        }
      } catch (err) {
        console.error('Failed to query capabilities from auth service:', err);
      }
    }

    // Also check DHT presence for peers not registered with auth service
    if (this.beacon) {
      const dhtPeers = this.beacon.findByAgentCapability(capability);
      for (const peer of dhtPeers) {
        if (!seen.has(peer.pubKey)) {
          seen.add(peer.pubKey);
          profiles.push({
            pubKey: peer.pubKey,
            createdAt: 0,
            updatedAt: peer.lastSeen,
          });
        }
      }
    }

    return profiles;
  }

  /**
   * Get agent capabilities for a specific peer
   * Checks cache first, then fetches from auth service
   */
  async getCapabilities(pubKey: PublicKeyHex): Promise<string[]> {
    // Check DHT presence first (fastest, no network)
    if (this.beacon) {
      const providers = this.beacon.getAllProviders();
      const provider = providers.find(p => p.pubKey === pubKey);
      if (provider && provider.agentCapabilities.length > 0) {
        return provider.agentCapabilities;
      }
    }

    // Fall back to auth service profile
    if (this.profileCache) {
      const profile = await this.profileCache.getProfile(pubKey);
      // UserProfile doesn't have agentCapabilities, but the auth service
      // returns them on the Profile type. Re-fetch if needed.
      if (profile) {
        // The profile cache fetches from auth service which includes agentCapabilities
        // in the response. We can access it if it's been extended.
        return (profile as any).agentCapabilities || [];
      }
    }

    return [];
  }

  /**
   * Handle incoming browse response
   */
  private handleBrowseResponse(response: BrowseResponseMessage): void {
    // Find pending browse for this provider
    for (const [browseId, pending] of this.pendingBrowses) {
      if (browseId.includes(response.providerPubKey)) {
        // Verify signature
        const signableData = Buffer.from(JSON.stringify({
          type: 'BROWSE_RESPONSE',
          providerPubKey: response.providerPubKey,
          ts: response.ts,
          files: response.files,
        }));

        // Verify browse response signature
        if (!IdentityManager.verify(signableData, response.sig, response.providerPubKey)) {
          pending.reject(new Error('Invalid browse response signature'));
          clearTimeout(pending.timeout);
          this.pendingBrowses.delete(browseId);
          return;
        }

        // Check timestamp is recent (within 5 minutes)
        const now = Date.now();
        if (Math.abs(now - response.ts) > 5 * 60 * 1000) {
          pending.reject(new Error('Browse response timestamp invalid'));
          clearTimeout(pending.timeout);
          this.pendingBrowses.delete(browseId);
          return;
        }

        // Success - resolve with files
        pending.resolve(response.files);
        clearTimeout(pending.timeout);
        this.pendingBrowses.delete(browseId);
        return;
      }
    }
  }
}
