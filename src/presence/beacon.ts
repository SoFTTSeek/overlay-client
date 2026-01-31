/**
 * Presence Beacon System
 * PRD Section 8.4.1 - Presence beacons for provider discovery
 */

import { EventEmitter } from 'events';
import Hyperswarm from 'hyperswarm';
import { createHash } from 'crypto';
import type { PublicKeyHex, ContentHash } from '../types.js';
import { hexToBytes, bytesToHex } from '../utils/cbor.js';

/**
 * Beacon message types
 */
interface BeaconMessage {
  type: 'ANNOUNCE' | 'PROBE' | 'PRESENCE';
  pubKey: PublicKeyHex;
  contentHashes?: ContentHash[];
  timestamp: number;
  capabilities?: string[];
}

/**
 * Provider presence info
 */
export interface ProviderPresence {
  pubKey: PublicKeyHex;
  contentHashes: Set<ContentHash>;
  lastSeen: number;
  connectionQuality: 'unknown' | 'direct' | 'relay' | 'offline';
  capabilities: string[];
}

/**
 * Presence beacon configuration
 */
interface BeaconConfig {
  announceIntervalMs: number;
  presenceTimeoutMs: number;
  maxProvidersPerContent: number;
}

const DEFAULT_CONFIG: BeaconConfig = {
  announceIntervalMs: 60 * 1000, // 1 minute
  presenceTimeoutMs: 5 * 60 * 1000, // 5 minutes
  maxProvidersPerContent: 50,
};

/**
 * Generate DHT topic for content hash
 */
function contentTopic(contentHash: ContentHash): Buffer {
  // Use SHA256 of the content hash to create a 32-byte topic
  return createHash('sha256').update(contentHash).digest();
}

/**
 * Presence Beacon Service
 */
export class PresenceBeacon extends EventEmitter {
  private swarm: Hyperswarm | null = null;
  private config: BeaconConfig;
  private myPubKey: PublicKeyHex;
  private myContentHashes: Set<ContentHash> = new Set();
  private knownProviders: Map<PublicKeyHex, ProviderPresence> = new Map();
  private contentProviders: Map<ContentHash, Set<PublicKeyHex>> = new Map();
  private announceInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private joinedTopics: Map<string, Buffer> = new Map();

  constructor(pubKey: PublicKeyHex, config: Partial<BeaconConfig> = {}) {
    super();
    this.myPubKey = pubKey;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the beacon service
   */
  async initialize(): Promise<void> {
    this.swarm = new Hyperswarm();

    this.swarm.on('connection', (socket, info) => {
      this.handleConnection(socket, info);
    });

    // Start announce interval
    this.announceInterval = setInterval(() => {
      this.broadcastPresence();
    }, this.config.announceIntervalMs);

    // Start cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanupStalePresence();
    }, 30 * 1000);
  }

  /**
   * Shutdown the beacon service
   */
  async shutdown(): Promise<void> {
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    if (this.swarm) {
      await this.swarm.destroy();
      this.swarm = null;
    }
  }

  /**
   * Register content we can provide
   */
  registerContent(contentHash: ContentHash): void {
    this.myContentHashes.add(contentHash);

    // Join the topic for this content
    if (this.swarm) {
      const topic = contentTopic(contentHash);
      this.swarm.join(topic, { client: false, server: true });
      this.joinedTopics.set(contentHash, topic);
    }
  }

  /**
   * Unregister content
   */
  unregisterContent(contentHash: ContentHash): void {
    this.myContentHashes.delete(contentHash);

    // Leave the topic
    const topic = this.joinedTopics.get(contentHash);
    if (topic && this.swarm) {
      this.swarm.leave(topic);
      this.joinedTopics.delete(contentHash);
    }
  }

  /**
   * Probe for providers of specific content
   */
  async probeContent(contentHash: ContentHash): Promise<ProviderPresence[]> {
    if (!this.swarm) {
      throw new Error('Beacon not initialized');
    }

    const topic = contentTopic(contentHash);

    // Join topic as client
    this.swarm.join(topic, { client: true, server: false });

    // Wait for connections
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Return known providers for this content
    const providerPubKeys = this.contentProviders.get(contentHash) || new Set();
    const providers: ProviderPresence[] = [];

    for (const pubKey of providerPubKeys) {
      const presence = this.knownProviders.get(pubKey);
      if (presence) {
        providers.push(presence);
      }
    }

    return providers;
  }

  /**
   * Get providers for content hash
   */
  getProviders(contentHash: ContentHash): ProviderPresence[] {
    const providerPubKeys = this.contentProviders.get(contentHash) || new Set();
    const providers: ProviderPresence[] = [];

    for (const pubKey of providerPubKeys) {
      const presence = this.knownProviders.get(pubKey);
      if (presence && this.isPresenceValid(presence)) {
        providers.push(presence);
      }
    }

    return providers;
  }

  /**
   * Get all known providers
   */
  getAllProviders(): ProviderPresence[] {
    return Array.from(this.knownProviders.values()).filter(p =>
      this.isPresenceValid(p)
    );
  }

  /**
   * Handle incoming connection
   */
  private handleConnection(socket: any, info: any): void {
    let buffer = Buffer.alloc(0);

    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);

      // Parse newline-delimited messages
      while (true) {
        const idx = buffer.indexOf('\n');
        if (idx === -1) break;

        const msgData = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);

        try {
          const msg: BeaconMessage = JSON.parse(msgData.toString());
          this.handleMessage(socket, msg);
        } catch {
          // Ignore invalid messages
        }
      }
    });

    socket.on('error', () => {
      // Connection errors are expected
    });

    // Send our presence immediately
    this.sendPresence(socket);
  }

  /**
   * Handle beacon message
   */
  private handleMessage(socket: any, msg: BeaconMessage): void {
    switch (msg.type) {
      case 'ANNOUNCE':
      case 'PRESENCE':
        this.handlePresence(msg);
        break;
      case 'PROBE':
        this.handleProbe(socket, msg);
        break;
    }
  }

  /**
   * Handle presence announcement
   */
  private handlePresence(msg: BeaconMessage): void {
    // Don't track our own presence
    if (msg.pubKey === this.myPubKey) return;

    let presence = this.knownProviders.get(msg.pubKey);

    if (!presence) {
      presence = {
        pubKey: msg.pubKey,
        contentHashes: new Set(),
        lastSeen: Date.now(),
        connectionQuality: 'direct',
        capabilities: msg.capabilities || [],
      };
      this.knownProviders.set(msg.pubKey, presence);
    }

    presence.lastSeen = Date.now();
    presence.connectionQuality = 'direct';

    if (msg.contentHashes) {
      for (const hash of msg.contentHashes) {
        presence.contentHashes.add(hash);

        // Update content -> provider mapping
        let providers = this.contentProviders.get(hash);
        if (!providers) {
          providers = new Set();
          this.contentProviders.set(hash, providers);
        }
        providers.add(msg.pubKey);

        // Limit providers per content
        if (providers.size > this.config.maxProvidersPerContent) {
          const toRemove = Array.from(providers)[0];
          providers.delete(toRemove);
        }
      }
    }

    this.emit('presence', presence);
  }

  /**
   * Handle probe request
   */
  private handleProbe(socket: any, msg: BeaconMessage): void {
    // Respond with our presence
    this.sendPresence(socket);
  }

  /**
   * Send our presence to a socket
   */
  private sendPresence(socket: any): void {
    const msg: BeaconMessage = {
      type: 'PRESENCE',
      pubKey: this.myPubKey,
      contentHashes: Array.from(this.myContentHashes),
      timestamp: Date.now(),
      capabilities: ['direct', 'relay'],
    };

    try {
      socket.write(JSON.stringify(msg) + '\n');
    } catch {
      // Socket may be closed
    }
  }

  /**
   * Broadcast presence to all connected peers
   */
  private broadcastPresence(): void {
    if (!this.swarm) return;

    const msg: BeaconMessage = {
      type: 'ANNOUNCE',
      pubKey: this.myPubKey,
      contentHashes: Array.from(this.myContentHashes),
      timestamp: Date.now(),
      capabilities: ['direct', 'relay'],
    };

    const data = JSON.stringify(msg) + '\n';

    for (const socket of this.swarm.connections) {
      try {
        socket.write(data);
      } catch {
        // Socket may be closed
      }
    }
  }

  /**
   * Clean up stale presence entries
   */
  private cleanupStalePresence(): void {
    const now = Date.now();

    for (const [pubKey, presence] of this.knownProviders) {
      if (!this.isPresenceValid(presence)) {
        this.knownProviders.delete(pubKey);

        // Remove from content mappings
        for (const hash of presence.contentHashes) {
          const providers = this.contentProviders.get(hash);
          if (providers) {
            providers.delete(pubKey);
            if (providers.size === 0) {
              this.contentProviders.delete(hash);
            }
          }
        }

        this.emit('presence:expired', pubKey);
      }
    }
  }

  /**
   * Check if presence is still valid
   */
  private isPresenceValid(presence: ProviderPresence): boolean {
    return Date.now() - presence.lastSeen < this.config.presenceTimeoutMs;
  }

  /**
   * Get content count
   */
  getContentCount(): number {
    return this.myContentHashes.size;
  }

  /**
   * Get provider count
   */
  getProviderCount(): number {
    return this.knownProviders.size;
  }
}
