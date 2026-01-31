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
 * Frame format: uint32_be length + payload
 */
function writeFrame(socket: Socket, data: Buffer): void {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  socket.write(Buffer.concat([header, data]));
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
   */
  private connectToRelay(relayUrl: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const { host, port } = this.parseRelayUrl(relayUrl);

      const socket = createConnection({ host, port }, () => {
        resolve(socket);
      });

      socket.on('error', reject);

      socket.setTimeout(this.connectionTimeout, () => {
        socket.destroy(new Error('Connection timeout'));
        reject(new Error('Connection timeout'));
      });
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
}
