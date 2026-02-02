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
} from '../types.js';
import { StreamingHasher, verifyFileHash } from '../publish/hasher.js';
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
 * Relay transport client
 */
export class RelayTransport extends EventEmitter {
  private relayUrls: string[];
  private activeConnections: Map<string, RelayConnectionState> = new Map();
  private connectionTimeout: number = 30000;
  private providerRegistration: ProviderRegistrationState | null = null;
  private reconnectDelayMs: number = 5000;

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

  /**
   * Connect to a relay server
   * @param relayUrl - URL of the relay server
   * @param persistent - If true, disables timeout for long-lived connections (provider mode)
   */
  private connectToRelay(relayUrl: string, persistent = false): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const { host, port } = this.parseRelayUrl(relayUrl);

      const socket = createConnection({ host, port }, () => {
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

    return new Promise(async (resolve, reject) => {
      try {
        // Wait a moment for relay to pair
        await new Promise(r => setTimeout(r, 500));

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
      } catch (err) {
        reject(err);
      }
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

                // Create destination directory
                await mkdir(dirname(state.destPath!), { recursive: true });
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
    const selectedRelay = relayUrl || this.relayUrls[0];
    if (!selectedRelay) {
      throw new Error('No relay servers available');
    }

    // Clean up existing registration if any
    if (this.providerRegistration) {
      this.unregisterProvider();
    }

    this.providerRegistration = {
      pubKey,
      socket: null as any, // Will be set below
      relayUrl: selectedRelay,
      connected: false,
      providedFiles,
    };

    await this.connectAsProvider();
  }

  /**
   * Connect to relay as provider
   */
  private async connectAsProvider(): Promise<void> {
    if (!this.providerRegistration) return;

    try {
      // Use persistent=true to disable timeout for long-lived provider connections
      const socket = await this.connectToRelay(this.providerRegistration.relayUrl, true);
      this.providerRegistration.socket = socket;
      this.providerRegistration.connected = true;

      // Send PROVIDER_REGISTER
      const register = {
        type: 'PROVIDER_REGISTER',
        pubKey: this.providerRegistration.pubKey,
      };
      writeFrame(socket, Buffer.from(JSON.stringify(register)));

      // Set up handlers
      this.setupProviderSocketHandlers(socket);

      console.log(`Registered as provider with relay: ${this.providerRegistration.pubKey.slice(0, 16)}...`);
      this.emit('provider:registered', { relayUrl: this.providerRegistration.relayUrl });
    } catch (err) {
      console.error('Failed to connect to relay as provider:', err);
      this.scheduleProviderReconnect();
    }
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
      // Don't trigger reconnect here - 'close' event will handle it
    });

    socket.on('close', () => {
      if (this.providerRegistration) {
        this.providerRegistration.connected = false;
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
        return;
      }

      if (msg.type === 'FILE_REQUEST' && msg.contentHash && msg.requesterSessionId) {
        console.log('Relay FILE_REQUEST received for:', msg.contentHash.slice(0, 16));
        await this.handleRelayFileRequest(socket, msg.contentHash, msg.requesterSessionId);
        return;
      }
    } catch (err) {
      console.error('Failed to parse provider frame:', err);
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

    this.providerRegistration.reconnectTimer = setTimeout(() => {
      if (this.providerRegistration && !this.providerRegistration.connected) {
        this.connectAsProvider();
      }
    }, this.reconnectDelayMs);
  }

  /**
   * Unregister as provider
   */
  unregisterProvider(): void {
    if (!this.providerRegistration) return;

    if (this.providerRegistration.reconnectTimer) {
      clearTimeout(this.providerRegistration.reconnectTimer);
    }

    if (this.providerRegistration.socket && !this.providerRegistration.socket.destroyed) {
      this.providerRegistration.socket.destroy();
    }

    this.providerRegistration = null;
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
    const selectedRelay = relayUrl || this.relayUrls[0];
    if (!selectedRelay) {
      throw new Error('No relay servers available');
    }

    // Connect to relay - use persistent=true to disable the 30s socket timeout
    // The transfer has its own 120s timeout, we don't want the socket timeout killing it
    const socket = await this.connectToRelay(selectedRelay, true);

    return new Promise(async (resolve, reject) => {
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
    let totalBytesReceived = 0;

    // Log socket events for debugging
    socket.on('timeout', () => {
      console.log('Relay requester socket: timeout event');
    });

    socket.on('data', async (data: Buffer) => {
      totalBytesReceived += data.length;
      // Log raw data arrival (first 32 bytes in hex for debugging)
      console.log(`Relay: Received ${data.length} bytes (total: ${totalBytesReceived}), first 32: ${data.subarray(0, 32).toString('hex')}`);

      buffer = Buffer.concat([buffer, data]);

      const { frames, remaining } = parseFrames(buffer);
      console.log(`Relay: Parsed ${frames.length} frames, remaining buffer: ${remaining.length} bytes`);
      buffer = remaining;

      for (const frame of frames) {
        try {
          console.log(`Relay: Processing frame of ${frame.length} bytes, starts with: ${frame.subarray(0, 50).toString('utf8').replace(/[^\x20-\x7E]/g, '?')}`);
          const msg = JSON.parse(frame.toString());
          console.log(`Relay: Parsed message type: ${msg.type}`);

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

            // Create destination directory
            await mkdir(dirname(state.destPath!), { recursive: true });
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
              this.emitProgress(state);
            }
            continue;
          }

          if (msg.type === 'COMPLETE') {
            console.log('Relay: Received COMPLETE, handling transfer completion');
            await this.handleTransferComplete(state);
            if ((state as any).timeout) clearTimeout((state as any).timeout);
            return;
          }
        } catch (err) {
          // Not JSON or parse error - log for debugging
          console.log(`Relay: Frame parse error: ${err}, frame length: ${frame.length}, starts with: ${frame.subarray(0, 50).toString('hex')}`);
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
}
