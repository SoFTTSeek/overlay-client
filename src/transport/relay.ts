/**
 * Relay Transport - NAT traversal via relay server
 * PRD Section 8.3 - Stream relay service
 */

import { EventEmitter } from 'events';
import { createConnection, Socket } from 'net';
import { randomBytes } from 'crypto';
import type {
  ContentHash,
  PublicKeyHex,
  TransferProgress,
  TransferStatus,
  RelayHelloMessage,
  RelayRole,
  BrowseRequestMessage,
  BrowseResponseMessage,
  DirectMessage,
  DirectMessageAck,
} from '../types.js';
import { StreamingHasher, verifyFileHash } from '../publish/hasher.js';
import { IdentityManager } from '../identity/index.js';
import { getDirectMessageSignableBytes } from '../utils/cbor.js';
import { createWriteStream, createReadStream } from 'fs';
import { stat, mkdir, unlink } from 'fs/promises';
import { dirname } from 'path';

/**
 * Relay connection state
 */
interface RelayConnectionState {
  sessionId: string;
  role: RelayRole;
  socket: Socket;
  contentHash: ContentHash;
  destPath?: string;
  status: TransferStatus;
  bytesTransferred: number;
  totalBytes: number;
  hasher: StreamingHasher;
  writeStream?: ReturnType<typeof createWriteStream>;
  resolve: (result: boolean) => void;
  reject: (error: Error) => void;
}

/**
 * Provider registration state
 */
interface ProviderRegistrationState {
  pubKey: string;
  socket: Socket;
  relayUrl: string;
  connected: boolean;
  reconnectTimer?: NodeJS.Timeout;
  reconnectAttempt: number;
  registerAck?: {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };
  providedFiles: Map<ContentHash, string>; // contentHash -> filePath
}

/**
 * Frame format: uint32_be length + payload
 * Returns true if the write was successful and the buffer is not full
 */
function writeFrame(socket: Socket, data: Buffer): boolean {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  return socket.write(Buffer.concat([header, data]));
}

/**
 * Parse frames from a buffer
 */
function parseFrames(buffer: Buffer): { frames: Buffer[]; remaining: Buffer } {
  const frames: Buffer[] = [];
  let offset = 0;

  while (offset + 4 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (offset + 4 + length > buffer.length) break;

    frames.push(Buffer.from(buffer.subarray(offset + 4, offset + 4 + length)));
    offset += 4 + length;
  }

  return {
    frames,
    remaining: Buffer.from(buffer.subarray(offset)),
  };
}

/**
 * Browse request handler function type
 */
type BrowseRequestHandler = (msg: BrowseRequestMessage) => BrowseResponseMessage | null;

/**
 * Direct message handler function type (for relay provider side)
 */
type DirectMessageHandler = (msg: DirectMessage) => void;

/**
 * Relay transport client
 */
export class RelayTransport extends EventEmitter {
  private relayUrls: string[];
  private activeConnections: Map<string, RelayConnectionState> = new Map();
  private connectionTimeout: number = 30000;
  private providerRegistration: ProviderRegistrationState | null = null;
  private reconnectDelayMs: number = 5000;
  private maxReconnectDelayMs: number = 60000;
  private providerConnectPromise: Promise<void> | null = null;
  private browseRequestHandler: BrowseRequestHandler | null = null;
  private directMessageHandler: DirectMessageHandler | null = null;

  constructor(relayUrls: string[]) {
    super();
    this.relayUrls = relayUrls;
  }

  /**
   * Generate a session ID
   */
  private generateSessionId(): string {
    return randomBytes(16).toString('hex');
  }

  /**
   * Parse relay URL into host and port
   */
  private parseRelayUrl(url: string): { host: string; port: number } {
    // Handle formats: "host:port" or "relay://host:port"
    const cleaned = url.replace(/^relay:\/\//, '');
    const [host, portStr] = cleaned.split(':');
    return { host, port: parseInt(portStr || '9000', 10) };
  }

  private getRelayCandidates(preferredRelay?: string): string[] {
    const candidates: string[] = [];
    const seen = new Set<string>();

    const add = (relayUrl?: string) => {
      if (!relayUrl || seen.has(relayUrl)) return;
      seen.add(relayUrl);
      candidates.push(relayUrl);
    };

    add(preferredRelay);
    add(this.providerRegistration?.relayUrl);
    for (const relayUrl of this.relayUrls) {
      add(relayUrl);
    }

    return candidates;
  }

  /**
   * Connect to a relay server
   * @param relayUrl - URL of the relay server
   * @param persistent - If true, disables timeout for long-lived connections (provider mode)
   */
  private connectToRelay(relayUrl: string, persistent = false): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const { host, port } = this.parseRelayUrl(relayUrl);

      const socket = createConnection({ host, port }, () => {
        socket.setKeepAlive(true, 15000);
        socket.setNoDelay(true);
        // Disable timeout for persistent connections (providers stay connected)
        if (persistent) {
          socket.setTimeout(0);
        }
        resolve(socket);
      });

      socket.on('error', reject);

      // Only set connection timeout for non-persistent connections
      if (!persistent) {
        socket.setTimeout(this.connectionTimeout, () => {
          socket.destroy(new Error('Connection timeout'));
          reject(new Error('Connection timeout'));
        });
      }
    });
  }

  /**
   * Request a file via relay
   * Returns sessionId that must be shared with provider
   */
  async requestFileViaRelay(
    contentHash: ContentHash,
    destPath: string,
    relayUrl?: string
  ): Promise<{ sessionId: string; relayUrl: string }> {
    const selectedRelay = relayUrl || this.relayUrls[0];
    if (!selectedRelay) {
      throw new Error('No relay servers available');
    }

    // Pre-create destination directory before connecting (same fix as requestFileFromProvider)
    await mkdir(dirname(destPath), { recursive: true });

    const sessionId = this.generateSessionId();

    // Connect to relay
    const socket = await this.connectToRelay(selectedRelay);

    // Send RELAY_HELLO
    const hello: RelayHelloMessage = {
      type: 'RELAY_HELLO',
      sessionId,
      role: 'requester',
    };
    writeFrame(socket, Buffer.from(JSON.stringify(hello)));

    return new Promise((resolve, reject) => {
      const state: RelayConnectionState = {
        sessionId,
        role: 'requester',
        socket,
        contentHash,
        destPath,
        status: 'connecting',
        bytesTransferred: 0,
        totalBytes: 0,
        hasher: new StreamingHasher(),
        resolve: (result) => {
          this.activeConnections.delete(sessionId);
          resolve({ sessionId, relayUrl: selectedRelay });
        },
        reject: (err) => {
          this.activeConnections.delete(sessionId);
          reject(err);
        },
      };

      this.activeConnections.set(sessionId, state);
      this.setupSocketHandlers(socket, state);

      // Resolve immediately with session info - actual transfer happens async
      resolve({ sessionId, relayUrl: selectedRelay });
    });
  }

  /**
   * Provide a file via relay (called by provider when they receive sessionId)
   */
  async provideFileViaRelay(
    sessionId: string,
    relayUrl: string,
    filePath: string,
    contentHash: ContentHash
  ): Promise<boolean> {
    // Connect to relay
    const socket = await this.connectToRelay(relayUrl);

    // Send RELAY_HELLO
    const hello: RelayHelloMessage = {
      type: 'RELAY_HELLO',
      sessionId,
      role: 'provider',
    };
    writeFrame(socket, Buffer.from(JSON.stringify(hello)));

    // Wait a moment for relay to pair before sending data.
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Get file stats
    const stats = await stat(filePath);

    // Send metadata frame
    const metadata = {
      type: 'METADATA',
      contentHash,
      size: stats.size,
    };
    writeFrame(socket, Buffer.from(JSON.stringify(metadata)));

    // Stream file data
    return new Promise((resolve, reject) => {
      const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });

      stream.on('data', (chunk: Buffer | string) => {
        const bufferChunk = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        writeFrame(socket, bufferChunk);
      });

      stream.on('end', () => {
        // Send completion marker
        writeFrame(socket, Buffer.from(JSON.stringify({ type: 'COMPLETE' })));
        resolve(true);
      });

      stream.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Setup socket handlers for receiving data
   */
  private setupSocketHandlers(socket: Socket, state: RelayConnectionState): void {
    let buffer: Buffer = Buffer.alloc(0);
    let metadataReceived = false;

    socket.on('data', async (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);

      const { frames, remaining } = parseFrames(buffer);
      buffer = remaining;

      for (const frame of frames) {
        // Check if this is a control message (JSON starting with '{')
        // Control messages are small and start with '{', while file data is typically larger
        // and unlikely to be valid JSON starting with '{'
        const isLikelyControlMessage = frame.length < 1024 && frame[0] === 0x7b; // '{' char

        if (isLikelyControlMessage) {
          try {
            const msg = JSON.parse(frame.toString());

            // Only process if it has a valid 'type' field
            if (typeof msg.type === 'string') {
              if (msg.type === 'METADATA') {
                metadataReceived = true;
                state.totalBytes = msg.size;
                state.status = 'downloading';

                // Directory was pre-created in requestFileViaRelay — no async gap
                state.writeStream = createWriteStream(state.destPath!);

                this.emitProgress(state);
                continue;
              }

              if (msg.type === 'COMPLETE') {
                await this.handleTransferComplete(state);
                continue;
              }

              if (msg.type === 'ERROR') {
                state.status = 'failed';
                state.reject(new Error(msg.error || 'Relay error'));
                continue;
              }
            }
            // Unknown type or no type - fall through to treat as data
          } catch {
            // Parse failed - treat as file data
          }
        }

        // Treat as file data
        if (metadataReceived && state.writeStream) {
          state.writeStream.write(frame);
          state.hasher.update(frame);
          state.bytesTransferred += frame.length;
          this.emitProgress(state);
        }
      }
    });

    socket.on('error', (err) => {
      state.status = 'failed';
      state.reject(err);
    });

    socket.on('close', () => {
      if (state.status === 'downloading') {
        state.status = 'failed';
        state.reject(new Error('Connection closed'));
      }
    });
  }

  /**
   * Handle transfer completion
   */
  private async handleTransferComplete(state: RelayConnectionState): Promise<void> {
    if (state.writeStream) {
      state.writeStream.end();
    }

    state.status = 'verifying';
    this.emitProgress(state);

    // Verify hash
    const isValid = await verifyFileHash(state.destPath!, state.contentHash);

    if (isValid) {
      state.status = 'completed';
      this.emitProgress(state);
      state.resolve(true);
    } else {
      await unlink(state.destPath!).catch(() => {});
      state.status = 'failed';
      this.emitProgress(state);
      state.reject(new Error('Hash verification failed'));
    }
  }

  /**
   * Emit progress event
   */
  private emitProgress(state: RelayConnectionState): void {
    const progress: TransferProgress = {
      contentHash: state.contentHash,
      status: state.status,
      bytesDownloaded: state.bytesTransferred,
      totalBytes: state.totalBytes,
      chunksVerified: 0,
      totalChunks: 0,
      transport: 'relay',
    };

    this.emit('progress', progress);
  }

  /**
   * Update relay URLs
   */
  updateRelays(relayUrls: string[]): void {
    this.relayUrls = relayUrls;
    if (!this.providerRegistration) return;

    if (relayUrls.length === 0) {
      this.unregisterProvider();
      return;
    }

    if (!relayUrls.includes(this.providerRegistration.relayUrl)) {
      this.providerRegistration.connected = false;
      if (this.providerRegistration.socket && !this.providerRegistration.socket.destroyed) {
        this.providerRegistration.socket.destroy();
      }
      this.providerRegistration.relayUrl = relayUrls[0];
      this.scheduleProviderReconnect();
    }
  }

  /**
   * Get active connection count
   */
  getActiveConnectionCount(): number {
    return this.activeConnections.size;
  }

  /**
   * Register as a provider with the relay server
   * Maintains a persistent connection for receiving file requests
   */
  async registerAsProvider(
    pubKey: string,
    providedFiles: Map<ContentHash, string>,
    relayUrl?: string
  ): Promise<void> {
    const selectedRelay = relayUrl || this.getRelayCandidates()[0];
    if (!selectedRelay) {
      throw new Error('No relay servers available');
    }

    // Fast path: already registered for this pubKey/relay, just update files.
    if (
      this.providerRegistration
      && this.providerRegistration.pubKey === pubKey
      && this.providerRegistration.relayUrl === selectedRelay
    ) {
      this.providerRegistration.providedFiles = providedFiles;
      if (this.providerRegistration.connected) {
        return;
      }
      await this.connectAsProvider();
      return;
    }

    // Clean up existing registration if switching pubKey or relay.
    if (this.providerRegistration) {
      this.unregisterProvider();
    }

    this.providerRegistration = {
      pubKey,
      socket: null as any, // Will be set below
      relayUrl: selectedRelay,
      connected: false,
      reconnectAttempt: 0,
      providedFiles,
    };

    await this.connectAsProvider();
  }

  /**
   * Connect to relay as provider
   */
  private async connectAsProvider(): Promise<void> {
    if (!this.providerRegistration) return;
    if (this.providerConnectPromise) {
      return this.providerConnectPromise;
    }

    this.providerConnectPromise = (async () => {
      if (!this.providerRegistration) return;

      const candidates = this.getRelayCandidates(this.providerRegistration.relayUrl);
      let lastError: Error | null = null;

      for (const relayUrl of candidates) {
        if (!this.providerRegistration) return;

        try {
          // Use persistent=true to disable timeout for long-lived provider connections
          const socket = await this.connectToRelay(relayUrl, true);
          this.providerRegistration.socket = socket;
          this.providerRegistration.connected = false;
          this.providerRegistration.relayUrl = relayUrl;

          // Set up handlers before sending register so ACK is captured.
          this.setupProviderSocketHandlers(socket);

          // Send PROVIDER_REGISTER
          const register = {
            type: 'PROVIDER_REGISTER',
            pubKey: this.providerRegistration.pubKey,
          };
          writeFrame(socket, Buffer.from(JSON.stringify(register)));

          // Wait for relay ACK before marking connected.
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error('Provider registration ACK timeout'));
            }, 10000);

            if (!this.providerRegistration || this.providerRegistration.socket !== socket) {
              clearTimeout(timer);
              reject(new Error('Provider registration state changed'));
              return;
            }

            this.providerRegistration.registerAck = {
              resolve: () => {
                clearTimeout(timer);
                resolve();
              },
              reject: (error: Error) => {
                clearTimeout(timer);
                reject(error);
              },
              timer,
            };
          });

          if (!this.providerRegistration || this.providerRegistration.socket !== socket) {
            return;
          }

          this.providerRegistration.connected = true;
          this.providerRegistration.reconnectAttempt = 0;
          this.providerRegistration.registerAck = undefined;

          console.log(`Registered as provider with relay: ${this.providerRegistration.pubKey.slice(0, 16)}...`);
          this.emit('provider:registered', { relayUrl: this.providerRegistration.relayUrl });
          return;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          console.error(`Failed to connect to relay ${relayUrl} as provider:`, lastError.message);

          if (this.providerRegistration?.socket && !this.providerRegistration.socket.destroyed) {
            this.providerRegistration.socket.destroy();
          }
          if (this.providerRegistration) {
            this.providerRegistration.connected = false;
            this.providerRegistration.registerAck = undefined;
          }
        }
      }

      if (lastError) {
        console.error('Failed to connect to relay as provider:', lastError.message);
      }
      this.scheduleProviderReconnect();
    })().finally(() => {
      this.providerConnectPromise = null;
    });

    return this.providerConnectPromise;
  }

  /**
   * Set up socket handlers for provider connection
   */
  private setupProviderSocketHandlers(socket: Socket): void {
    let buffer: Buffer = Buffer.alloc(0);

    socket.on('data', async (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);

      const { frames, remaining } = parseFrames(buffer);
      buffer = remaining;

      for (const frame of frames) {
        await this.handleProviderFrame(socket, frame);
      }
    });

    socket.on('error', (err) => {
      console.error('Provider relay socket error:', err.message);
      if (this.providerRegistration?.socket === socket) {
        this.providerRegistration.connected = false;
        if (this.providerRegistration.registerAck) {
          this.providerRegistration.registerAck.reject(new Error(`Provider relay socket error: ${err.message}`));
          this.providerRegistration.registerAck = undefined;
        }
      }
      // Don't trigger reconnect here - 'close' event will handle it.
    });

    socket.on('close', () => {
      if (this.providerRegistration?.socket === socket) {
        this.providerRegistration.connected = false;
        if (this.providerRegistration.registerAck) {
          this.providerRegistration.registerAck.reject(new Error('Provider relay connection closed before registration ACK'));
          this.providerRegistration.registerAck = undefined;
        }
        console.log('Provider relay connection closed, reconnecting...');
        this.scheduleProviderReconnect();
      }
    });

    // Handle drain event for logging purposes
    socket.on('drain', () => {
      console.log('Provider socket drained, buffer cleared');
    });
  }

  /**
   * Handle a frame received on the provider connection
   */
  private async handleProviderFrame(socket: Socket, frame: Buffer): Promise<void> {
    try {
      const msg = JSON.parse(frame.toString());
      console.log('Provider received frame:', msg.type, msg.contentHash?.slice(0, 16) || '');

      if (msg.type === 'PROVIDER_REGISTERED') {
        console.log('Provider registration confirmed by relay');
        if (this.providerRegistration?.socket === socket && this.providerRegistration.registerAck) {
          this.providerRegistration.registerAck.resolve();
        }
        return;
      }

      if (msg.type === 'FILE_REQUEST' && msg.contentHash && msg.requesterSessionId) {
        console.log('Relay FILE_REQUEST received for:', msg.contentHash.slice(0, 16));
        await this.handleRelayFileRequest(socket, msg.contentHash, msg.requesterSessionId);
        return;
      }

      if (msg.type === 'BROWSE_REQUEST' && msg.browseRequest && msg.requesterSessionId) {
        console.log('Relay BROWSE_REQUEST received from:', msg.browseRequest.requesterPubKey?.slice(0, 16));
        await this.handleRelayBrowseRequest(socket, msg.browseRequest, msg.requesterSessionId);
        return;
      }

      if (msg.type === 'DIRECT_MESSAGE' && msg.directMessage && msg.requesterSessionId) {
        console.log('Relay DIRECT_MESSAGE received from:', msg.directMessage.from?.slice(0, 16));
        await this.handleRelayDirectMessage(socket, msg.directMessage, msg.requesterSessionId);
        return;
      }
    } catch (err) {
      console.error('Failed to parse provider frame:', err);
    }
  }

  /**
   * Handle a browse request received via relay
   */
  private async handleRelayBrowseRequest(
    socket: Socket,
    browseRequest: BrowseRequestMessage,
    requesterSessionId: string
  ): Promise<void> {
    console.log('Relay BROWSE_REQUEST: Handling browse from', browseRequest.requesterPubKey?.slice(0, 16));

    if (!this.browseRequestHandler) {
      console.log('Relay BROWSE_REQUEST: No browse handler registered');
      const error = {
        type: 'ERROR',
        requesterSessionId,
        error: 'Browse not available',
      };
      writeFrame(socket, Buffer.from(JSON.stringify(error)));
      return;
    }

    try {
      const response = this.browseRequestHandler(browseRequest);
      if (response) {
        const browseResponse = {
          type: 'BROWSE_RESPONSE',
          requesterSessionId,
          browseResponse: response,
        };
        writeFrame(socket, Buffer.from(JSON.stringify(browseResponse)));
        console.log('Relay BROWSE_REQUEST: Sent response with', response.files?.length || 0, 'files');
      } else {
        const error = {
          type: 'ERROR',
          requesterSessionId,
          error: 'Browse request rejected',
        };
        writeFrame(socket, Buffer.from(JSON.stringify(error)));
      }
    } catch (err: any) {
      console.error('Relay BROWSE_REQUEST: Error:', err.message);
      const error = {
        type: 'ERROR',
        requesterSessionId,
        error: err.message,
      };
      writeFrame(socket, Buffer.from(JSON.stringify(error)));
    }
  }

  /**
   * Handle a file request received via relay
   */
  private async handleRelayFileRequest(
    socket: Socket,
    contentHash: ContentHash,
    requesterSessionId: string
  ): Promise<void> {
    if (!this.providerRegistration) {
      console.log('Relay FILE_REQUEST: No provider registration');
      return;
    }

    console.log('Relay FILE_REQUEST: Looking up file', contentHash.slice(0, 16));
    console.log('Relay FILE_REQUEST: Available files:', Array.from(this.providerRegistration.providedFiles.keys()).map(k => k.slice(0, 16)));

    const filePath = this.providerRegistration.providedFiles.get(contentHash);
    if (!filePath) {
      // File not available
      console.log('Relay FILE_REQUEST: File not found for hash', contentHash.slice(0, 16));
      const error = {
        type: 'ERROR',
        requesterSessionId,
        error: 'File not available',
      };
      writeFrame(socket, Buffer.from(JSON.stringify(error)));
      return;
    }

    console.log('Relay FILE_REQUEST: Found file at', filePath);

    try {
      // Get file stats
      const stats = await stat(filePath);
      console.log('Relay FILE_REQUEST: File size', stats.size, 'bytes');

      // Send metadata
      const metadata = {
        type: 'FILE_RESPONSE',
        requesterSessionId,
        contentHash,
        size: stats.size,
      };
      const metadataWritten = writeFrame(socket, Buffer.from(JSON.stringify(metadata)));
      console.log('Relay FILE_REQUEST: Sent metadata for session', requesterSessionId.slice(0, 16), 'buffered:', !metadataWritten);

      // Use smaller chunks to avoid buffer overflow (32KB → ~43KB base64)
      const stream = createReadStream(filePath, { highWaterMark: 32 * 1024 });
      let chunkCount = 0;
      let bytesSent = 0;

      stream.on('data', (chunk: Buffer | string) => {
        const bufferChunk = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        chunkCount++;
        bytesSent += bufferChunk.length;

        // Send as DATA frame with session ID
        const dataMsg = {
          type: 'DATA',
          requesterSessionId,
          chunk: bufferChunk.toString('base64'),
        };

        const canContinue = writeFrame(socket, Buffer.from(JSON.stringify(dataMsg)));

        // Handle backpressure: pause stream if socket buffer is full
        if (!canContinue) {
          stream.pause();
          socket.once('drain', () => {
            stream.resume();
          });
        }

        // Log progress every 10 chunks
        if (chunkCount % 10 === 0) {
          console.log(`Relay FILE_REQUEST: Streaming chunk ${chunkCount}, ${bytesSent} bytes sent`);
        }
      });

      stream.on('end', () => {
        console.log(`Relay FILE_REQUEST: Stream complete, ${chunkCount} chunks, ${bytesSent} bytes total`);
        const complete = {
          type: 'COMPLETE',
          requesterSessionId,
          contentHash,
        };
        writeFrame(socket, Buffer.from(JSON.stringify(complete)));
      });

      stream.on('error', (err) => {
        console.error('Relay FILE_REQUEST: Stream error:', err.message);
        const error = {
          type: 'ERROR',
          requesterSessionId,
          error: err.message,
        };
        writeFrame(socket, Buffer.from(JSON.stringify(error)));
      });
    } catch (err: any) {
      console.error('Relay FILE_REQUEST: Error:', err.message);
      const error = {
        type: 'ERROR',
        requesterSessionId,
        error: err.message,
      };
      writeFrame(socket, Buffer.from(JSON.stringify(error)));
    }
  }

  /**
   * Schedule a reconnection attempt for provider
   */
  private scheduleProviderReconnect(): void {
    if (!this.providerRegistration) return;

    if (this.providerRegistration.reconnectTimer) {
      clearTimeout(this.providerRegistration.reconnectTimer);
    }

    const attempt = this.providerRegistration.reconnectAttempt;
    const backoff = Math.min(this.reconnectDelayMs * (2 ** attempt), this.maxReconnectDelayMs);
    const jitter = Math.floor(Math.random() * 1000);
    const delayMs = backoff + jitter;
    this.providerRegistration.reconnectAttempt += 1;

    this.providerRegistration.reconnectTimer = setTimeout(() => {
      if (this.providerRegistration && !this.providerRegistration.connected) {
        void this.connectAsProvider();
      }
    }, delayMs);
  }

  /**
   * Unregister as provider
   */
  unregisterProvider(): void {
    if (!this.providerRegistration) return;

    if (this.providerRegistration.reconnectTimer) {
      clearTimeout(this.providerRegistration.reconnectTimer);
    }

    if (this.providerRegistration.registerAck) {
      this.providerRegistration.registerAck.reject(new Error('Provider unregistered'));
      this.providerRegistration.registerAck = undefined;
    }

    if (this.providerRegistration.socket && !this.providerRegistration.socket.destroyed) {
      this.providerRegistration.socket.destroy();
    }

    this.providerRegistration = null;
    this.providerConnectPromise = null;
    this.emit('provider:unregistered');
  }

  /**
   * Update the list of files we can provide
   */
  updateProvidedFiles(files: Map<ContentHash, string>): void {
    if (this.providerRegistration) {
      this.providerRegistration.providedFiles = files;
    }
  }

  /**
   * Check if we're registered as a provider
   */
  isProviderRegistered(): boolean {
    return this.providerRegistration?.connected ?? false;
  }

  /**
   * Request a file via relay using pubKey-based routing (new protocol)
   * This is the new method that uses provider pubKey instead of session ID
   */
  async requestFileFromProvider(
    contentHash: ContentHash,
    providerPubKey: string,
    destPath: string,
    relayUrl?: string
  ): Promise<boolean> {
    const relayCandidates = this.getRelayCandidates(relayUrl);
    if (relayCandidates.length === 0) {
      throw new Error('No relay servers available');
    }

    // Pre-create destination directory before connecting.
    // This MUST happen before data starts flowing — doing it inside the
    // socket 'data' handler (with await) causes a race condition where
    // DATA frames arrive while mkdir is pending, before the writeStream
    // exists, silently dropping file chunks.
    await mkdir(dirname(destPath), { recursive: true });

    const errors: string[] = [];
    for (const candidate of relayCandidates) {
      try {
        return await this.requestFileFromProviderViaRelay(
          contentHash,
          providerPubKey,
          destPath,
          candidate,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${candidate}: ${message}`);
        // Ensure retries always start clean, even if the previous attempt left a partial file.
        await unlink(destPath).catch(() => {});
      }
    }

    throw new Error(`Relay file request failed on all relays: ${errors.join('; ')}`);
  }

  private async requestFileFromProviderViaRelay(
    contentHash: ContentHash,
    providerPubKey: string,
    destPath: string,
    relayUrl: string,
  ): Promise<boolean> {
    // Connect to relay - use persistent=true to disable the 30s socket timeout
    // The transfer has its own 120s timeout, we don't want the socket timeout killing it
    const socket = await this.connectToRelay(relayUrl, true);

    return new Promise((resolve, reject) => {
      const state: RelayConnectionState = {
        sessionId: `${providerPubKey}:${contentHash}:${Date.now()}`,
        role: 'requester',
        socket,
        contentHash,
        destPath,
        status: 'connecting',
        bytesTransferred: 0,
        totalBytes: 0,
        hasher: new StreamingHasher(),
        resolve,
        reject,
      };

      this.activeConnections.set(state.sessionId, state);

      // Send RELAY_REQUEST (new protocol)
      const request = {
        type: 'RELAY_REQUEST',
        providerPubKey,
        contentHash,
      };
      writeFrame(socket, Buffer.from(JSON.stringify(request)));

      // Set up handlers for receiving file
      this.setupRequesterSocketHandlers(socket, state);

      // Set timeout with proper cleanup
      const timeout = setTimeout(async () => {
        if (state.status === 'connecting' || state.status === 'downloading') {
          state.status = 'failed';
          this.activeConnections.delete(state.sessionId);

          // Close the socket to prevent further data handling
          if (!socket.destroyed) {
            socket.destroy();
          }

          // Close write stream if open
          if (state.writeStream) {
            state.writeStream.end();
          }

          // Clean up partial file
          if (state.destPath) {
            await unlink(state.destPath).catch(() => {});
          }

          reject(new Error('Relay transfer timeout'));
        }
      }, 120000); // 2 minute timeout for relay transfers

      // Store timeout and socket so we can clear them on success
      (state as any).timeout = timeout;
      (state as any).socket = socket;
    });
  }

  /**
   * Set up socket handlers for requester connection
   */
  private setupRequesterSocketHandlers(socket: Socket, state: RelayConnectionState): void {
    let buffer: Buffer = Buffer.alloc(0);
    let metadataReceived = false;
    let transferStartTime = 0;
    let lastProgressLogBytes = 0;
    let lastProgressLogPercent = 0;
    const PROGRESS_LOG_INTERVAL_BYTES = 5 * 1024 * 1024; // Log every 5MB
    const PROGRESS_LOG_INTERVAL_PERCENT = 10; // Or every 10%

    // Extract provider pubkey from session ID for logging
    const providerPubKey = state.sessionId.split(':')[0] || 'unknown';

    socket.on('data', async (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);

      const { frames, remaining } = parseFrames(buffer);
      buffer = remaining;

      for (const frame of frames) {
        try {
          const msg = JSON.parse(frame.toString());

          if (msg.type === 'ERROR') {
            state.status = 'failed';
            if ((state as any).timeout) clearTimeout((state as any).timeout);
            this.activeConnections.delete(state.sessionId);
            state.reject(new Error(msg.error || 'Relay error'));
            return;
          }

          if (msg.type === 'FILE_RESPONSE') {
            metadataReceived = true;
            state.totalBytes = msg.size;
            state.status = 'downloading';
            transferStartTime = Date.now();

            // Log transfer start with size
            const sizeMB = (msg.size / 1024 / 1024).toFixed(1);
            console.log(`Relay: Transfer started - ${sizeMB}MB from ${providerPubKey.slice(0, 8)}`);

            // Directory was pre-created in requestFileFromProvider — no async
            // gap that could let DATA frames slip through before writeStream exists
            state.writeStream = createWriteStream(state.destPath!);

            this.emitProgress(state);
            continue;
          }

          if (msg.type === 'DATA' && msg.chunk) {
            if (metadataReceived && state.writeStream) {
              const chunk = Buffer.from(msg.chunk, 'base64');
              state.writeStream.write(chunk);
              state.hasher.update(chunk);
              state.bytesTransferred += chunk.length;

              // Log progress periodically (every 5MB or 10%)
              const bytesSinceLast = state.bytesTransferred - lastProgressLogBytes;
              const percentComplete = state.totalBytes > 0
                ? Math.floor((state.bytesTransferred / state.totalBytes) * 100)
                : 0;
              const percentThreshold = Math.floor(percentComplete / PROGRESS_LOG_INTERVAL_PERCENT) * PROGRESS_LOG_INTERVAL_PERCENT;

              if (bytesSinceLast >= PROGRESS_LOG_INTERVAL_BYTES ||
                  (percentThreshold > lastProgressLogPercent && percentComplete > 0)) {
                const progressMB = (state.bytesTransferred / 1024 / 1024).toFixed(1);
                console.log(`Relay: Progress ${percentComplete}% (${progressMB}MB)`);
                lastProgressLogBytes = state.bytesTransferred;
                lastProgressLogPercent = percentThreshold;
              }

              this.emitProgress(state);
            }
            continue;
          }

          if (msg.type === 'COMPLETE') {
            const durationSec = transferStartTime > 0
              ? ((Date.now() - transferStartTime) / 1000).toFixed(1)
              : '?';
            const sizeMB = (state.bytesTransferred / 1024 / 1024).toFixed(1);
            console.log(`Relay: Transfer complete - ${sizeMB}MB in ${durationSec}s`);
            await this.handleTransferComplete(state);
            if ((state as any).timeout) clearTimeout((state as any).timeout);
            return;
          }
        } catch (err) {
          // JSON parse errors are expected for non-control frames.
          // But real errors (e.g. hash verification failure) must propagate.
          if (err instanceof SyntaxError) {
            // Not JSON — silently ignore (binary data or non-control frame)
          } else {
            // Real processing error — fail the transfer
            state.status = 'failed';
            if ((state as any).timeout) clearTimeout((state as any).timeout);
            this.activeConnections.delete(state.sessionId);
            state.reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
        }
      }
    });

    socket.on('error', async (err) => {
      state.status = 'failed';
      if ((state as any).timeout) clearTimeout((state as any).timeout);
      this.activeConnections.delete(state.sessionId);

      // Close write stream if open
      if (state.writeStream) {
        state.writeStream.end();
      }

      // Clean up partial file
      if (state.destPath) {
        await unlink(state.destPath).catch(() => {});
      }

      state.reject(err);
    });

    socket.on('close', async () => {
      if (state.status === 'downloading' || state.status === 'connecting') {
        state.status = 'failed';
        if ((state as any).timeout) clearTimeout((state as any).timeout);
        this.activeConnections.delete(state.sessionId);

        // Close write stream if open
        if (state.writeStream) {
          state.writeStream.end();
        }

        // Clean up partial file
        if (state.destPath) {
          await unlink(state.destPath).catch(() => {});
        }

        state.reject(new Error('Connection closed'));
      }
    });
  }

  /**
   * Set the browse request handler (for provider role)
   */
  setBrowseRequestHandler(handler: BrowseRequestHandler): void {
    this.browseRequestHandler = handler;
  }

  /**
   * Set the direct message handler (for provider role)
   */
  setDirectMessageHandler(handler: DirectMessageHandler): void {
    this.directMessageHandler = handler;
  }

  /**
   * Handle a direct message received via relay
   */
  private async handleRelayDirectMessage(
    socket: Socket,
    directMessage: DirectMessage,
    requesterSessionId: string
  ): Promise<void> {
    console.log('Relay DIRECT_MESSAGE: Handling message from', directMessage.from?.slice(0, 16));

    if (!this.directMessageHandler) {
      console.log('Relay DIRECT_MESSAGE: No message handler registered');
      const error = {
        type: 'DIRECT_MESSAGE_RESPONSE',
        requesterSessionId,
        directMessageAck: {
          type: 'DIRECT_MESSAGE_ACK',
          messageId: directMessage.messageId,
          status: 'undeliverable',
        },
      };
      writeFrame(socket, Buffer.from(JSON.stringify(error)));
      return;
    }

    // Verify Ed25519 signature before processing
    try {
      const signableBytes = getDirectMessageSignableBytes(directMessage);
      if (!IdentityManager.verify(signableBytes, directMessage.sig, directMessage.from)) {
        console.error('Relay DIRECT_MESSAGE: Signature verification failed from:', directMessage.from?.slice(0, 16));
        const rejected = {
          type: 'DIRECT_MESSAGE_RESPONSE',
          requesterSessionId,
          directMessageAck: {
            type: 'DIRECT_MESSAGE_ACK',
            messageId: directMessage.messageId,
            status: 'rejected',
          },
        };
        writeFrame(socket, Buffer.from(JSON.stringify(rejected)));
        return;
      }
    } catch (sigErr: any) {
      console.error('Relay DIRECT_MESSAGE: Signature check error:', sigErr.message);
      const rejected = {
        type: 'DIRECT_MESSAGE_RESPONSE',
        requesterSessionId,
        directMessageAck: {
          type: 'DIRECT_MESSAGE_ACK',
          messageId: directMessage.messageId,
          status: 'rejected',
        },
      };
      writeFrame(socket, Buffer.from(JSON.stringify(rejected)));
      return;
    }

    try {
      this.directMessageHandler(directMessage);

      const ackResponse = {
        type: 'DIRECT_MESSAGE_RESPONSE',
        requesterSessionId,
        directMessageAck: {
          type: 'DIRECT_MESSAGE_ACK',
          messageId: directMessage.messageId,
          status: 'delivered',
        },
      };
      writeFrame(socket, Buffer.from(JSON.stringify(ackResponse)));
      console.log('Relay DIRECT_MESSAGE: Sent ACK for message', directMessage.messageId.slice(0, 16));
    } catch (err: any) {
      console.error('Relay DIRECT_MESSAGE: Error:', err.message);
      const error = {
        type: 'DIRECT_MESSAGE_RESPONSE',
        requesterSessionId,
        directMessageAck: {
          type: 'DIRECT_MESSAGE_ACK',
          messageId: directMessage.messageId,
          status: 'rejected',
        },
      };
      writeFrame(socket, Buffer.from(JSON.stringify(error)));
    }
  }

  /**
   * Send a direct message via relay
   * Returns a promise that resolves with the ACK
   */
  async sendDirectMessage(
    targetPubKey: PublicKeyHex,
    relayUrl: string,
    message: DirectMessage
  ): Promise<DirectMessageAck> {
    const relayCandidates = this.getRelayCandidates(relayUrl);
    if (relayCandidates.length === 0) {
      throw new Error('No relay URLs configured');
    }

    console.log('Sending direct message via relay to:', targetPubKey.slice(0, 16));

    const errors: string[] = [];
    for (const candidate of relayCandidates) {
      try {
        return await this.sendDirectMessageViaRelay(candidate, targetPubKey, message);
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        errors.push(`${candidate}: ${messageText}`);
      }
    }

    throw new Error(`Direct message failed on all relays: ${errors.join('; ')}`);
  }

  private async sendDirectMessageViaRelay(
    relayUrl: string,
    targetPubKey: PublicKeyHex,
    message: DirectMessage,
  ): Promise<DirectMessageAck> {
    const socket = await this.connectToRelay(relayUrl, true);

    return new Promise((resolve, reject) => {
      let settled = false;

      // Set timeout for ACK response
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error('Direct message via relay timed out'));
      }, 30000);

      let buffer = Buffer.alloc(0);

      socket.on('data', (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);
        const { frames, remaining } = parseFrames(buffer);
        buffer = Buffer.from(remaining);

        for (const frame of frames) {
          try {
            const msg = JSON.parse(frame.toString());

            if (msg.type === 'ERROR') {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              socket.destroy();
              reject(new Error(msg.error || 'Direct message failed'));
              return;
            }

            if (msg.type === 'DIRECT_MESSAGE_RESPONSE' && msg.directMessageAck) {
              // Verify ACK matches the message we sent
              if (msg.directMessageAck.messageId !== message.messageId) {
                console.log('Relay direct message: Ignoring ACK for wrong messageId:', msg.directMessageAck.messageId?.slice(0, 16));
                continue;
              }
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              socket.destroy();
              console.log('Relay direct message: Received ACK:', msg.directMessageAck.status);
              resolve(msg.directMessageAck as DirectMessageAck);
              return;
            }
          } catch (err) {
            console.log('Relay direct message: Frame parse error:', err);
          }
        }
      });

      socket.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      });

      socket.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error('Relay connection closed before receiving ACK'));
      });

      // Send RELAY_DIRECT_MESSAGE
      const request = {
        type: 'RELAY_DIRECT_MESSAGE',
        providerPubKey: targetPubKey,
        directMessage: message,
      };
      writeFrame(socket, Buffer.from(JSON.stringify(request)));
      console.log('Relay direct message: Sent RELAY_DIRECT_MESSAGE');
    });
  }

  /**
   * Send a browse request via relay
   * Returns a promise that resolves when the browse response is received
   */
  async sendBrowseRequest(
    providerPubKey: PublicKeyHex,
    browseRequest: BrowseRequestMessage
  ): Promise<BrowseResponseMessage> {
    const relayCandidates = this.getRelayCandidates();
    if (relayCandidates.length === 0) {
      throw new Error('No relay URLs configured');
    }

    console.log('Sending browse request via relay to provider:', providerPubKey.slice(0, 16));

    const errors: string[] = [];
    for (const candidate of relayCandidates) {
      try {
        return await this.sendBrowseRequestViaRelay(candidate, providerPubKey, browseRequest);
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        errors.push(`${candidate}: ${messageText}`);
      }
    }

    throw new Error(`Browse request failed on all relays: ${errors.join('; ')}`);
  }

  private async sendBrowseRequestViaRelay(
    relayUrl: string,
    providerPubKey: PublicKeyHex,
    browseRequest: BrowseRequestMessage,
  ): Promise<BrowseResponseMessage> {
    // Connect to relay - use persistent=true to disable socket timeout
    const socket = await this.connectToRelay(relayUrl, true);

    return new Promise((resolve, reject) => {
      let settled = false;

      // Set timeout for browse response
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error('Browse request via relay timed out'));
      }, 30000);

      let buffer = Buffer.alloc(0);

      socket.on('data', (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);
        const { frames, remaining } = parseFrames(buffer);
        buffer = Buffer.from(remaining);

        for (const frame of frames) {
          try {
            const msg = JSON.parse(frame.toString());
            console.log('Relay browse: Received message type:', msg.type);

            if (msg.type === 'ERROR') {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              socket.destroy();
              reject(new Error(msg.error || 'Browse request failed'));
              return;
            }

            if (msg.type === 'BROWSE_RESPONSE' && msg.browseResponse) {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              socket.destroy();
              console.log('Relay browse: Received response with', msg.browseResponse.files?.length || 0, 'files');
              resolve(msg.browseResponse);
              return;
            }
          } catch (err) {
            console.log('Relay browse: Frame parse error:', err);
          }
        }
      });

      socket.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      });

      socket.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error('Relay connection closed before receiving browse response'));
      });

      // Send RELAY_BROWSE_REQUEST
      const request = {
        type: 'RELAY_BROWSE_REQUEST',
        providerPubKey,
        browseRequest,
      };
      writeFrame(socket, Buffer.from(JSON.stringify(request)));
      console.log('Relay browse: Sent RELAY_BROWSE_REQUEST');
    });
  }
}
