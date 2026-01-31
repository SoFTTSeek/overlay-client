/**
 * Browse Manager - Handle browse requests and responses
 * PRD Section 8 - Browse functionality for overlay network
 */

import { basename, dirname } from 'path';
import { EventEmitter } from 'events';
import type {
  PublicKeyHex,
  SignatureHex,
  ContentHash,
  FileExtension,
  BrowseRequestMessage,
  BrowseResponseMessage,
  OverlayBrowseFile,
  LocalFileEntry,
} from '../types.js';
import { IdentityManager } from '../identity/index.js';
import { LocalDatabase } from '../localdb/index.js';

/**
 * Pending browse request state
 */
interface PendingBrowse {
  providerPubKey: PublicKeyHex;
  startTime: number;
  resolve: (files: OverlayBrowseFile[]) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Browse Manager - handles browse requests and responses
 */
export class BrowseManager extends EventEmitter {
  private pendingBrowses: Map<string, PendingBrowse> = new Map();
  private browseTimeoutMs: number = 30000; // 30 second timeout

  constructor(
    private identity: IdentityManager,
    private localDb: LocalDatabase
  ) {
    super();
  }

  /**
   * Create a signed browse request message
   */
  createBrowseRequest(): BrowseRequestMessage {
    const requesterPubKey = this.identity.getPublicKey();
    const ts = Date.now();

    // Sign the request
    const signableData = Buffer.from(JSON.stringify({
      type: 'BROWSE_REQUEST',
      requesterPubKey,
      ts,
    }));
    const sig = this.identity.sign(signableData);

    return {
      type: 'BROWSE_REQUEST',
      requesterPubKey,
      ts,
      sig,
    };
  }

  /**
   * Create a signed browse response message
   */
  createBrowseResponse(): BrowseResponseMessage {
    const providerPubKey = this.identity.getPublicKey();
    const ts = Date.now();

    // Get all files from local database
    const localFiles = this.localDb.getAllFiles();

    // Convert to browse files with privacy-safe paths
    const files = this.convertToBrowseFiles(localFiles);

    // Sign the response
    const signableData = Buffer.from(JSON.stringify({
      type: 'BROWSE_RESPONSE',
      providerPubKey,
      ts,
      files,
    }));
    const sig = this.identity.sign(signableData);

    return {
      type: 'BROWSE_RESPONSE',
      providerPubKey,
      ts,
      files,
      sig,
    };
  }

  /**
   * Convert local file entries to browse files with privacy-safe paths
   */
  private convertToBrowseFiles(entries: LocalFileEntry[]): OverlayBrowseFile[] {
    // Group files by their shared folder prefix to create relative paths
    const files: OverlayBrowseFile[] = [];

    for (const entry of entries) {
      // Extract relative path - use last 2 path segments for privacy
      const fullPath = entry.path;
      const pathParts = fullPath.split(/[/\\]/);

      // Take parent folder and filename for relative path
      const parentFolder = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : '';
      const filename = pathParts[pathParts.length - 1] || '';
      const relativePath = parentFolder ? `${parentFolder}/${filename}` : filename;

      files.push({
        path: relativePath,
        filename,
        size: entry.size,
        contentHash: entry.contentHash,
        ext: entry.ext,
        bitrate: entry.bitrate,
        duration: entry.duration,
        width: entry.width,
        height: entry.height,
      });
    }

    return files;
  }

  /**
   * Register a pending browse request
   * Returns a promise that resolves when the response is received
   */
  registerPendingBrowse(providerPubKey: PublicKeyHex): Promise<OverlayBrowseFile[]> {
    const requestId = `browse:${providerPubKey}:${Date.now()}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingBrowses.delete(requestId);
        reject(new Error('Browse request timed out'));
      }, this.browseTimeoutMs);

      this.pendingBrowses.set(requestId, {
        providerPubKey,
        startTime: Date.now(),
        resolve,
        reject,
        timeout,
      });
    });
  }

  /**
   * Handle an incoming browse request (as provider)
   */
  handleBrowseRequest(msg: BrowseRequestMessage): BrowseResponseMessage | null {
    // Verify signature
    const signableData = Buffer.from(JSON.stringify({
      type: 'BROWSE_REQUEST',
      requesterPubKey: msg.requesterPubKey,
      ts: msg.ts,
    }));

    if (!IdentityManager.verify(signableData, msg.sig, msg.requesterPubKey)) {
      console.error('Invalid browse request signature');
      return null;
    }

    // Check timestamp is recent (within 5 minutes)
    const now = Date.now();
    if (Math.abs(now - msg.ts) > 5 * 60 * 1000) {
      console.error('Browse request timestamp too old or in future');
      return null;
    }

    // Create and return response
    return this.createBrowseResponse();
  }

  /**
   * Handle an incoming browse response (as requester)
   */
  handleBrowseResponse(msg: BrowseResponseMessage): boolean {
    // Find pending browse request
    for (const [requestId, pending] of this.pendingBrowses) {
      if (pending.providerPubKey === msg.providerPubKey) {
        // Verify signature
        const signableData = Buffer.from(JSON.stringify({
          type: 'BROWSE_RESPONSE',
          providerPubKey: msg.providerPubKey,
          ts: msg.ts,
          files: msg.files,
        }));

        if (!IdentityManager.verify(signableData, msg.sig, msg.providerPubKey)) {
          console.error('Invalid browse response signature');
          pending.reject(new Error('Invalid browse response signature'));
          clearTimeout(pending.timeout);
          this.pendingBrowses.delete(requestId);
          return false;
        }

        // Check timestamp is recent
        const now = Date.now();
        if (Math.abs(now - msg.ts) > 5 * 60 * 1000) {
          console.error('Browse response timestamp too old or in future');
          pending.reject(new Error('Browse response timestamp invalid'));
          clearTimeout(pending.timeout);
          this.pendingBrowses.delete(requestId);
          return false;
        }

        // Success - resolve the promise
        pending.resolve(msg.files);
        clearTimeout(pending.timeout);
        this.pendingBrowses.delete(requestId);
        return true;
      }
    }

    return false;
  }

  /**
   * Get pending browse count
   */
  getPendingCount(): number {
    return this.pendingBrowses.size;
  }

  /**
   * Cancel all pending browses
   */
  cancelAll(): void {
    for (const [requestId, pending] of this.pendingBrowses) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Browse cancelled'));
    }
    this.pendingBrowses.clear();
  }
}
