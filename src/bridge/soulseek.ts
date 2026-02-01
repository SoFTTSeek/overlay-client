/**
 * Soulseek Bridge - Dual operation mode for hybrid search/download
 * PRD Section 6 - Dual Discovery Strategy
 */

import { EventEmitter } from 'events';
import type {
  ContentHash,
  PublicKeyHex,
  SearchResult,
  TransferProgress,
  TransferStatus,
  OverlayBrowseFile,
  BrowseResponseMessage,
} from '../types.js';
import { QueryRouter } from '../search/query.js';
import { DirectTransport } from '../transport/direct.js';
import { RelayTransport } from '../transport/relay.js';
import { ReputationManager, TransferOutcome } from '../reputation/index.js';
import { PresenceBeacon } from '../presence/beacon.js';
import { BrowseManager } from '../browse/manager.js';
import { LocalDatabase } from '../localdb/index.js';
import { IdentityManager } from '../identity/index.js';

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
  overlayProviders?: Array<{ pubKey: PublicKeyHex }>;
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
  private activeTransfers: Map<string, TransferState> = new Map();
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
  }): Promise<void> {
    // Initialize overlay components
    this.queryRouter = new QueryRouter(options.indexerUrls);
    this.directTransport = new DirectTransport(options.myPubKey);
    this.relayTransport = new RelayTransport(this.config.relayUrls);
    this.reputation = new ReputationManager(options.dbPath);
    this.beacon = new PresenceBeacon(options.myPubKey);

    // Initialize browse manager if identity and localDb provided
    if (options.identity && options.localDb) {
      this.browseManager = new BrowseManager(options.identity, options.localDb);

      // Set up browse request handler
      this.directTransport.setBrowseRequestHandler((msg) => {
        return this.browseManager?.handleBrowseRequest(msg) || null;
      });

      // Set up browse response handler
      this.directTransport.on('browse:response', (response: BrowseResponseMessage) => {
        this.handleBrowseResponse(response);
      });
    }

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
          .map(p => ({ pubKey: p.pubKey as string })),
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

    const state: TransferState = {
      id: result.id,
      result,
      destPath,
      status: 'connecting',
      method: null,
      bytesTransferred: 0,
      totalBytes: result.size,
      startTime: Date.now(),
      attempts: 0,
    };

    this.activeTransfers.set(result.id, state);
    this.emitTransferProgress(state);

    try {
      // Try transfer ladder: Direct → Relay → Soulseek
      let success = false;

      // 1. Try direct overlay transfer
      if (result.contentHash && result.overlayProviders?.length) {
        state.method = 'direct';
        success = await this.tryDirectTransfer(state);
        if (success) {
          state.status = 'completed';
          this.emitTransferProgress(state);
          return true;
        }
      }

      // 2. Try relay transfer
      if (result.contentHash && this.config.relayUrls.length > 0) {
        state.method = 'relay';
        success = await this.tryRelayTransfer(state);
        if (success) {
          state.status = 'completed';
          this.emitTransferProgress(state);
          return true;
        }
      }

      // 3. Fall back to Soulseek
      if (result.soulseekUsername) {
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
      this.activeTransfers.delete(result.id);
    }
  }

  /**
   * Try direct P2P transfer
   */
  private async tryDirectTransfer(state: TransferState): Promise<boolean> {
    if (!this.directTransport || !state.result.contentHash || !state.result.overlayProviders) {
      return false;
    }

    const providers = state.result.overlayProviders;

    // Sort providers by reputation
    if (this.reputation) {
      const pubKeys = providers.map(p => p.pubKey);
      const sorted = this.reputation.sortByReputation(pubKeys);
      providers.sort((a, b) => sorted.indexOf(a.pubKey) - sorted.indexOf(b.pubKey));
    }

    // Try each provider
    for (const provider of providers) {
      if (state.attempts >= this.config.maxRetries) break;
      state.attempts++;

      try {
        state.status = 'downloading';
        this.emitTransferProgress(state);

        const startTime = Date.now();
        const success = await this.directTransport.requestFile(
          state.result.contentHash,
          provider.pubKey,
          state.destPath
        );

        const duration = Date.now() - startTime;

        if (success && this.reputation) {
          this.reputation.recordTransfer(
            provider.pubKey,
            state.result.contentHash,
            'success',
            state.totalBytes,
            duration
          );
        }

        return success;
      } catch (err: any) {
        state.lastError = err.message;

        if (this.reputation) {
          this.reputation.recordTransfer(
            provider.pubKey,
            state.result.contentHash!,
            err.message.includes('timeout') ? 'timeout' : 'refused',
            0,
            0
          );
        }
      }
    }

    return false;
  }

  /**
   * Try relay transfer
   */
  private async tryRelayTransfer(state: TransferState): Promise<boolean> {
    if (!this.relayTransport || !state.result.contentHash) {
      return false;
    }

    // For relay, we need to coordinate with a provider
    // This is simplified - in practice, provider would need to connect to relay too
    try {
      state.status = 'downloading';
      this.emitTransferProgress(state);

      // Request file via relay (simplified)
      const { sessionId, relayUrl } = await this.relayTransport.requestFileViaRelay(
        state.result.contentHash,
        state.destPath,
        this.config.relayUrls[0]
      );

      // In real implementation, we'd need to signal provider to connect
      // For now, this assumes provider is already connected

      return true;
    } catch (err: any) {
      state.lastError = err.message;
      return false;
    }
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
      this.emitTransferProgress(state);
    }
  }

  /**
   * Emit transfer progress event
   */
  private emitTransferProgress(state: TransferState): void {
    this.emit('transfer:progress', {
      id: state.id,
      status: state.status,
      method: state.method,
      bytesTransferred: state.bytesTransferred,
      totalBytes: state.totalBytes,
      progress: state.totalBytes > 0 ? state.bytesTransferred / state.totalBytes : 0,
      elapsed: Date.now() - state.startTime,
      error: state.lastError,
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
   * Browse an overlay provider's files
   */
  async browseOverlay(providerPubKey: PublicKeyHex): Promise<OverlayBrowseFile[]> {
    if (!this.initialized || !this.directTransport || !this.browseManager) {
      throw new Error('Bridge not initialized or browse not available');
    }

    return new Promise(async (resolve, reject) => {
      const browseId = `browse:${providerPubKey}:${Date.now()}`;

      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingBrowses.delete(browseId);
        reject(new Error('Browse request timed out'));
      }, 30000);

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

        // Use static verify method from IdentityManager
        const { IdentityManager } = require('../identity/index.js');
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
