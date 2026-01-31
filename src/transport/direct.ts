/**
 * Direct Transport - P2P file transfer via Hyperswarm
 * PRD Section 8.2 - Overlay transfer protocol
 */

import Hyperswarm from 'hyperswarm';
import { EventEmitter } from 'events';
import { createWriteStream, createReadStream } from 'fs';
import { stat, mkdir, unlink } from 'fs/promises';
import { dirname } from 'path';
import type {
  ContentHash,
  PublicKeyHex,
  TransferRequest,
  TransferMetadata,
  TransferProgress,
  TransferStatus,
  BrowseRequestMessage,
  BrowseResponseMessage,
} from '../types.js';
import { StreamingHasher, verifyFileHash } from '../publish/hasher.js';
import { bytesToHex, hexToBytes } from '../utils/cbor.js';

/**
 * Transfer message types
 */
type TransferMessageType =
  | 'REQUEST'
  | 'METADATA'
  | 'DATA'
  | 'ERROR'
  | 'COMPLETE'
  | 'BROWSE_REQUEST'
  | 'BROWSE_RESPONSE';

interface TransferMessage {
  type: TransferMessageType;
  contentHash?: ContentHash;
  metadata?: TransferMetadata;
  chunk?: Buffer;
  chunkIndex?: number;
  error?: string;
  // Browse-specific fields
  browseRequest?: BrowseRequestMessage;
  browseResponse?: BrowseResponseMessage;
}

/**
 * Serialize a transfer message
 */
function serializeMessage(msg: TransferMessage): Buffer {
  return Buffer.from(JSON.stringify({
    ...msg,
    chunk: msg.chunk ? msg.chunk.toString('base64') : undefined,
  }));
}

/**
 * Deserialize a transfer message
 */
function deserializeMessage(data: Buffer): TransferMessage {
  const parsed = JSON.parse(data.toString());
  return {
    ...parsed,
    chunk: parsed.chunk ? Buffer.from(parsed.chunk, 'base64') : undefined,
  };
}

/**
 * Active transfer state
 */
interface TransferState {
  contentHash: ContentHash;
  providerPubKey: PublicKeyHex;
  destPath: string;
  status: TransferStatus;
  metadata?: TransferMetadata;
  bytesReceived: number;
  hasher: StreamingHasher;
  writeStream?: ReturnType<typeof createWriteStream>;
  startTime: number;
  requestSent?: boolean;
  resolve: (result: boolean) => void;
  reject: (error: Error) => void;
}

/**
 * Browse request handler function type
 */
type BrowseRequestHandler = (msg: BrowseRequestMessage) => BrowseResponseMessage | null;

/**
 * Direct transport for P2P file transfers
 */
export class DirectTransport extends EventEmitter {
  private swarm: Hyperswarm | null = null;
  private activeTransfers: Map<string, TransferState> = new Map();
  private providedFiles: Map<ContentHash, string> = new Map(); // hash -> filePath
  private myPubKey?: PublicKeyHex;
  private providerTopic: Buffer | null = null;
  private providerTopicJoined = false;
  private browseRequestHandler: BrowseRequestHandler | null = null;

  constructor(myPubKey?: PublicKeyHex) {
    super();
    this.myPubKey = myPubKey;
  }

  /**
   * Initialize the swarm
   */
  async initialize(): Promise<void> {
    this.swarm = new Hyperswarm();

    this.swarm.on('connection', (socket, info) => {
      this.handleConnection(socket, info);
    });

    this.ensureProviderTopicJoined();
  }

  /**
   * Shutdown the transport
   */
  async shutdown(): Promise<void> {
    if (this.swarm) {
      await this.swarm.destroy();
      this.swarm = null;
    }
  }

  /**
   * Register a file we can provide
   */
  registerFile(contentHash: ContentHash, filePath: string): void {
    this.providedFiles.set(contentHash, filePath);
    this.ensureProviderTopicJoined();
  }

  /**
   * Unregister a file
   */
  unregisterFile(contentHash: ContentHash): void {
    this.providedFiles.delete(contentHash);

    if (this.providedFiles.size === 0 && this.swarm && this.providerTopic) {
      this.swarm.leave(this.providerTopic);
      this.providerTopicJoined = false;
      this.providerTopic = null;
    }
  }

  /**
   * Request a file from a provider
   */
  async requestFile(
    contentHash: ContentHash,
    providerPubKey: PublicKeyHex,
    destPath: string,
    rangeStart?: number
  ): Promise<boolean> {
    if (!this.swarm) {
      throw new Error('Transport not initialized');
    }

    // Create topic from provider pubkey
    const topic = Buffer.from(hexToBytes(providerPubKey));

    return new Promise((resolve, reject) => {
      // Create transfer state
      const state: TransferState = {
        contentHash,
        providerPubKey,
        destPath,
        status: 'connecting',
        bytesReceived: rangeStart || 0,
        hasher: new StreamingHasher(),
        startTime: Date.now(),
        resolve,
        reject,
      };

      const transferId = `${contentHash}:${providerPubKey}`;
      this.activeTransfers.set(transferId, state);

      // Join the topic
      this.swarm!.join(topic, { client: true, server: false });

      // Emit progress
      this.emitProgress(state);

      // Set timeout
      setTimeout(() => {
        if (state.status === 'connecting') {
          this.abortTransfer(transferId, new Error('Connection timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Handle an incoming connection
   */
  private handleConnection(socket: any, info: any): void {
    let buffer = Buffer.alloc(0);

    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);

      // Try to parse messages (newline-delimited JSON)
      while (true) {
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx === -1) break;

        const msgData = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        try {
          const msg = deserializeMessage(msgData);
          this.handleMessage(socket, msg, info);
        } catch (err) {
          console.error('Failed to parse message:', err);
        }
      }
    });

    socket.on('error', (err: Error) => {
      console.error('Socket error:', err);
    });

    socket.on('close', () => {
      // Handle cleanup
    });

    this.maybeSendRequest(socket, info);
  }

  /**
   * Send REQUEST when we connect to the intended provider
   */
  private maybeSendRequest(socket: any, info: any): void {
    if (!info?.publicKey || !info.client) return;

    const remotePubKey = bytesToHex(info.publicKey).toLowerCase();

    for (const state of this.activeTransfers.values()) {
      if (state.status !== 'connecting') continue;
      if (state.requestSent) continue;
      if (state.providerPubKey.toLowerCase() !== remotePubKey) continue;

      state.requestSent = true;
      this.sendMessage(socket, {
        type: 'REQUEST',
        contentHash: state.contentHash,
      });
    }
  }

  /**
   * Handle a transfer message
   */
  private async handleMessage(socket: any, msg: TransferMessage, info: any): Promise<void> {
    switch (msg.type) {
      case 'REQUEST':
        await this.handleRequest(socket, msg);
        break;
      case 'METADATA':
        await this.handleMetadata(socket, msg);
        break;
      case 'DATA':
        await this.handleData(socket, msg);
        break;
      case 'COMPLETE':
        await this.handleComplete(socket, msg);
        break;
      case 'ERROR':
        this.handleError(socket, msg);
        break;
      case 'BROWSE_REQUEST':
        this.handleBrowseRequest(socket, msg);
        break;
      case 'BROWSE_RESPONSE':
        this.handleBrowseResponse(socket, msg);
        break;
    }
  }

  /**
   * Handle a file request (as provider)
   */
  private async handleRequest(socket: any, msg: TransferMessage): Promise<void> {
    const { contentHash } = msg;
    if (!contentHash) return;

    const filePath = this.providedFiles.get(contentHash);
    if (!filePath) {
      this.sendMessage(socket, { type: 'ERROR', error: 'File not available', contentHash });
      return;
    }

    try {
      const stats = await stat(filePath);
      const chunkSize = 64 * 1024; // 64KB chunks
      const chunkCount = Math.ceil(stats.size / chunkSize);

      // Send metadata
      const metadata: TransferMetadata = {
        contentHash,
        size: stats.size,
        chunkSize,
        chunkCount,
      };
      this.sendMessage(socket, { type: 'METADATA', metadata });

      // Stream file data
      const stream = createReadStream(filePath, { highWaterMark: chunkSize });
      let chunkIndex = 0;

      stream.on('data', (chunk: Buffer | string) => {
        const bufferChunk = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        this.sendMessage(socket, {
          type: 'DATA',
          contentHash,
          chunk: bufferChunk,
          chunkIndex,
        });
        chunkIndex++;
      });

      stream.on('end', () => {
        this.sendMessage(socket, { type: 'COMPLETE', contentHash });
      });

      stream.on('error', (err) => {
        this.sendMessage(socket, { type: 'ERROR', error: err.message, contentHash });
      });
    } catch (err: any) {
      this.sendMessage(socket, { type: 'ERROR', error: err.message, contentHash });
    }
  }

  /**
   * Join provider topic to receive REQUESTs.
   */
  private ensureProviderTopicJoined(): void {
    if (!this.swarm || !this.myPubKey || this.providerTopicJoined) return;
    if (this.providedFiles.size === 0) return;

    const topic = Buffer.from(hexToBytes(this.myPubKey));
    this.swarm.join(topic, { client: false, server: true });
    this.providerTopic = topic;
    this.providerTopicJoined = true;
  }

  /**
   * Handle metadata response (as requester)
   */
  private async handleMetadata(socket: any, msg: TransferMessage): Promise<void> {
    const { metadata } = msg;
    if (!metadata) return;

    const transferId = this.findTransferByHash(metadata.contentHash);
    if (!transferId) return;

    const state = this.activeTransfers.get(transferId);
    if (!state) return;

    state.metadata = metadata;
    state.status = 'downloading';

    // Create destination directory if needed
    await mkdir(dirname(state.destPath), { recursive: true });

    // Open write stream
    state.writeStream = createWriteStream(state.destPath);

    this.emitProgress(state);
  }

  /**
   * Handle data chunk (as requester)
   */
  private async handleData(socket: any, msg: TransferMessage): Promise<void> {
    const { contentHash, chunk, chunkIndex } = msg;
    if (!contentHash || !chunk) return;

    const transferId = this.findTransferByHash(contentHash);
    if (!transferId) return;

    const state = this.activeTransfers.get(transferId);
    if (!state || !state.writeStream) return;

    // Write chunk
    state.writeStream.write(chunk);
    state.hasher.update(chunk);
    state.bytesReceived += chunk.length;

    this.emitProgress(state);
  }

  /**
   * Handle transfer complete (as requester)
   */
  private async handleComplete(socket: any, msg: TransferMessage): Promise<void> {
    const { contentHash } = msg;
    if (!contentHash) return;

    const transferId = this.findTransferByHash(contentHash);
    if (!transferId) return;

    const state = this.activeTransfers.get(transferId);
    if (!state) return;

    // Close write stream
    if (state.writeStream) {
      state.writeStream.end();
    }

    // Verify hash
    state.status = 'verifying';
    this.emitProgress(state);

    const isValid = await verifyFileHash(state.destPath, state.contentHash);

    if (isValid) {
      state.status = 'completed';
      this.emitProgress(state);
      state.resolve(true);
    } else {
      // Hash mismatch - delete file
      await unlink(state.destPath).catch(() => {});
      state.status = 'failed';
      this.emitProgress(state);
      state.reject(new Error('Hash verification failed'));
    }

    this.activeTransfers.delete(transferId);
  }

  /**
   * Handle error
   */
  private handleError(socket: any, msg: TransferMessage): void {
    const { error, contentHash } = msg;

    if (contentHash) {
      const transferId = this.findTransferByHash(contentHash);
      if (transferId) {
        this.abortTransfer(transferId, new Error(error || 'Unknown error'));
      }
    }
  }

  /**
   * Send a message on a socket
   */
  private sendMessage(socket: any, msg: TransferMessage): void {
    const data = serializeMessage(msg);
    socket.write(data);
    socket.write('\n');
  }

  /**
   * Find transfer by content hash
   */
  private findTransferByHash(contentHash: ContentHash): string | undefined {
    for (const [id, state] of this.activeTransfers) {
      if (state.contentHash === contentHash) {
        return id;
      }
    }
    return undefined;
  }

  /**
   * Abort a transfer
   */
  private abortTransfer(transferId: string, error: Error): void {
    const state = this.activeTransfers.get(transferId);
    if (!state) return;

    state.status = 'failed';
    this.emitProgress(state);

    if (state.writeStream) {
      state.writeStream.end();
    }

    // Clean up partial file
    unlink(state.destPath).catch(() => {});

    state.reject(error);
    this.activeTransfers.delete(transferId);
  }

  /**
   * Emit progress event
   */
  private emitProgress(state: TransferState): void {
    const progress: TransferProgress = {
      contentHash: state.contentHash,
      status: state.status,
      bytesDownloaded: state.bytesReceived,
      totalBytes: state.metadata?.size || 0,
      chunksVerified: 0,
      totalChunks: state.metadata?.chunkCount || 0,
      transport: 'direct',
    };

    this.emit('progress', progress);
  }

  /**
   * Set browse request handler
   */
  setBrowseRequestHandler(handler: BrowseRequestHandler): void {
    this.browseRequestHandler = handler;
  }

  /**
   * Handle browse request (as provider)
   */
  private handleBrowseRequest(socket: any, msg: TransferMessage): void {
    if (!msg.browseRequest) return;

    if (this.browseRequestHandler) {
      const response = this.browseRequestHandler(msg.browseRequest);
      if (response) {
        this.sendMessage(socket, {
          type: 'BROWSE_RESPONSE',
          browseResponse: response,
        });
      }
    }
  }

  /**
   * Handle browse response (as requester)
   */
  private handleBrowseResponse(socket: any, msg: TransferMessage): void {
    if (!msg.browseResponse) return;

    // Emit event for browse manager to handle
    this.emit('browse:response', msg.browseResponse);
  }

  /**
   * Send a browse request to a provider
   */
  async sendBrowseRequest(
    providerPubKey: PublicKeyHex,
    request: BrowseRequestMessage
  ): Promise<void> {
    if (!this.swarm) {
      throw new Error('Transport not initialized');
    }

    // Create topic from provider pubkey
    const topic = Buffer.from(hexToBytes(providerPubKey));

    return new Promise((resolve, reject) => {
      // Join the topic as client
      this.swarm!.join(topic, { client: true, server: false });

      let resolved = false;

      // Use persistent listener that only unregisters after provider match or timeout
      const connectionHandler = (socket: any, info: any) => {
        if (resolved) return;
        if (!info?.publicKey) return;

        const remotePubKey = bytesToHex(info.publicKey).toLowerCase();
        if (remotePubKey === providerPubKey.toLowerCase()) {
          resolved = true;
          this.swarm!.off('connection', connectionHandler);
          this.sendMessage(socket, {
            type: 'BROWSE_REQUEST',
            browseRequest: request,
          });
          resolve();
        }
      };

      this.swarm!.on('connection', connectionHandler);

      // Timeout after 30 seconds
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.swarm!.off('connection', connectionHandler);
          reject(new Error('Browse connection timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Get active transfer count
   */
  getActiveTransferCount(): number {
    return this.activeTransfers.size;
  }
}
