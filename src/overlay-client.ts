/**
 * OverlayClient - High-level facade for the SoFTTSeek overlay network.
 * Relay-only, no Electron dependencies. Suitable for CLI and programmatic use.
 */

import { mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { IdentityManager, FileIdentityStorage, getAnonymousDisplayName } from './identity/index.js';
import { QueryRouter } from './search/query.js';
import { RelayTransport } from './transport/relay.js';
import { ensureBlake3 } from './publish/hasher.js';
import type {
  SearchResult,
  QueryFilters,
  TransferProgress,
  OverlayBrowseFile,
  BrowseRequestMessage,
  PublicKeyHex,
} from './types.js';

const DEFAULT_BOOTSTRAP = ['http://178.156.232.58:8080'];
const DEFAULT_RELAY = ['relay://178.156.231.111:9000'];

export interface OverlayClientOptions {
  /** Config/data directory. Defaults to ~/.softtseek */
  configDir?: string;
  /** Bootstrap node URLs. Defaults to production bootstrap. */
  bootstrapNodes?: string[];
  /** Relay node URLs. Defaults to production relay. */
  relayNodes?: string[];
}

interface BootstrapResponse {
  indexers: Array<{ url: string; shardStart: number; shardEnd: number }>;
  relays: Array<{ url: string; region: string }>;
  config: { shardCount: number };
}

export class OverlayClient {
  private identity: IdentityManager;
  private queryRouter: QueryRouter | null = null;
  private relay: RelayTransport;
  private configDir: string;
  private bootstrapNodes: string[];
  private relayNodes: string[];
  private indexerUrls: string[] = [];
  private initialized = false;

  private constructor(opts: Required<Pick<OverlayClientOptions, 'configDir'>> & OverlayClientOptions) {
    this.configDir = opts.configDir;
    this.bootstrapNodes = opts.bootstrapNodes ?? DEFAULT_BOOTSTRAP;
    this.relayNodes = opts.relayNodes ?? DEFAULT_RELAY;
    this.identity = new IdentityManager(new FileIdentityStorage(this.configDir));
    this.relay = new RelayTransport(this.relayNodes);
  }

  /**
   * Create and initialize an OverlayClient instance.
   */
  static async create(opts: OverlayClientOptions = {}): Promise<OverlayClient> {
    const configDir = opts.configDir ?? join(homedir(), '.softtseek');

    // Ensure config directory exists with restricted permissions
    await mkdir(configDir, { recursive: true, mode: 0o700 });

    // Initialize blake3 (native or wasm)
    await ensureBlake3();

    const client = new OverlayClient({ ...opts, configDir });

    // Initialize identity (loads existing or generates new)
    await client.identity.initialize();

    // Discover indexers from bootstrap
    await client.discoverNetwork();

    client.initialized = true;
    return client;
  }

  /**
   * Discover indexers and relays from bootstrap nodes.
   */
  private async discoverNetwork(): Promise<void> {
    for (const bootstrapUrl of this.bootstrapNodes) {
      try {
        const response = await fetch(`${bootstrapUrl}/v1/bootstrap`, {
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) continue;

        const data = await response.json() as BootstrapResponse;

        this.indexerUrls = data.indexers.map(i => i.url);

        if (data.relays?.length > 0) {
          this.relayNodes = data.relays.map(r =>
            r.url.startsWith('relay://') ? r.url : `relay://${r.url}`
          );
          this.relay.updateRelays(this.relayNodes);
        }

        this.queryRouter = new QueryRouter(this.indexerUrls);
        return;
      } catch {
        // Try next bootstrap node
      }
    }

    // No bootstrap succeeded - create router with empty indexers
    // Search will return empty results but other operations still work
    this.queryRouter = new QueryRouter([]);
  }

  /**
   * Get the current identity.
   */
  getIdentity(): { publicKey: string; fingerprint: string; displayName: string } {
    const id = this.identity.getIdentity();
    return {
      publicKey: id.publicKey,
      fingerprint: id.fingerprint,
      displayName: getAnonymousDisplayName(id.fingerprint),
    };
  }

  /**
   * Search the overlay network.
   */
  async search(
    query: string,
    opts?: { filters?: QueryFilters; limit?: number; signal?: AbortSignal; timeoutMs?: number }
  ): Promise<SearchResult[]> {
    if (!this.queryRouter) return [];
    return this.queryRouter.search(query, opts?.filters, opts?.limit, opts?.signal, opts?.timeoutMs);
  }

  /**
   * Download a file from a provider via relay.
   */
  async download(
    contentHash: string,
    providerPubKey: string,
    destPath: string,
    opts?: {
      onProgress?: (progress: TransferProgress) => void;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): Promise<boolean> {
    // Pre-flight: fail fast if provider is confirmed offline
    const status = await this.checkProviderStatus(providerPubKey);
    if (status === 'offline') {
      throw new Error(
        `Provider ${providerPubKey.slice(0, 16)}... is not currently online on any relay. They need to be running SoFTTSeek to serve files.`
      );
    }

    if (opts?.onProgress) {
      const handler = (p: TransferProgress) => {
        if (p.contentHash === contentHash) opts.onProgress!(p);
      };
      this.relay.on('progress', handler);
      try {
        return await this.relay.requestFileFromProvider(
          contentHash, providerPubKey, destPath, undefined,
          { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
        );
      } finally {
        this.relay.off('progress', handler);
      }
    }
    return this.relay.requestFileFromProvider(
      contentHash, providerPubKey, destPath, undefined,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
  }

  /**
   * Browse a provider's shared files via relay.
   */
  async browseProvider(pubKey: string): Promise<OverlayBrowseFile[]> {
    const id = this.identity.getIdentity();
    const ts = Date.now();
    const browseRequest: BrowseRequestMessage = {
      type: 'BROWSE_REQUEST',
      requesterPubKey: id.publicKey as PublicKeyHex,
      ts,
      sig: this.identity.sign(Buffer.from(`BROWSE:${id.publicKey}:${ts}`)),
    };

    const response = await this.relay.sendBrowseRequest(pubKey, browseRequest);
    return response.files ?? [];
  }

  /**
   * Check health of the overlay network infrastructure.
   */
  async checkHealth(): Promise<{
    bootstrap: boolean;
    indexers: string[];
    relays: string[];
  }> {
    let bootstrapHealthy = false;

    // Check bootstrap
    for (const url of this.bootstrapNodes) {
      try {
        const res = await fetch(`${url}/v1/health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          bootstrapHealthy = true;
          break;
        }
      } catch {
        // Not reachable
      }
    }

    // Check indexers
    const healthyIndexers: string[] = [];
    for (const url of this.indexerUrls) {
      try {
        const res = await fetch(`${url}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) healthyIndexers.push(url);
      } catch {
        // Not reachable
      }
    }

    // Report relay URLs (we can't easily health-check TCP relays)
    return {
      bootstrap: bootstrapHealthy,
      indexers: healthyIndexers,
      relays: this.relayNodes,
    };
  }

  /**
   * Derive relay HTTP URL from its TCP URL.
   * Relay TCP is e.g. "relay://178.156.231.111:9000", HTTP is port+1
   */
  private getRelayHttpUrl(relayTcpUrl: string): string {
    const cleaned = relayTcpUrl.replace(/^(relay|tcp):\/\//, '');
    const lastColon = cleaned.lastIndexOf(':');
    if (lastColon === -1) return `http://${cleaned}:9001`;
    const host = cleaned.substring(0, lastColon);
    const port = parseInt(cleaned.substring(lastColon + 1), 10);
    return `http://${host}:${port + 1}`;
  }

  /**
   * Query all known relays for online providers.
   * Returns a Set of provider pubkeys if at least one relay responds,
   * or null if all relays are unreachable.
   */
  async getOnlineProviders(): Promise<Set<string> | null> {
    const results = await Promise.allSettled(
      this.relayNodes.map(async (relayUrl) => {
        const httpUrl = this.getRelayHttpUrl(relayUrl);
        const res = await fetch(`${httpUrl}/v1/providers/online`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { providers: string[]; ts: number };
        return data.providers;
      })
    );

    const allProviders = new Set<string>();
    let anySuccess = false;

    for (const result of results) {
      if (result.status === 'fulfilled') {
        anySuccess = true;
        for (const pubKey of result.value) {
          allProviders.add(pubKey);
        }
      }
    }

    return anySuccess ? allProviders : null;
  }

  /**
   * Check whether a specific provider is online.
   * Returns 'online', 'offline', or 'unknown' (if relays are unreachable).
   */
  async checkProviderStatus(pubKey: string): Promise<'online' | 'offline' | 'unknown'> {
    const online = await this.getOnlineProviders();
    if (online === null) return 'unknown';
    return online.has(pubKey) ? 'online' : 'offline';
  }

  /**
   * Gracefully shut down connections.
   */
  async shutdown(): Promise<void> {
    this.relay.unregisterProvider();
    this.initialized = false;
  }
}
