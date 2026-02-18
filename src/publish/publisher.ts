/**
 * Publisher Module - Signed posting creation and publishing
 * PRD Section 6 - Sharing & Publishing Pipeline
 */

import { readdirSync, statSync } from "fs";
import { readdir, stat, writeFile, mkdir, unlink } from "fs/promises";
import { join, basename, dirname, extname } from "path";
import { homedir } from "os";
import { parseFile } from "music-metadata";

import type {
  ContentHash,
  PublicKeyHex,
  SignatureHex,
  FileExtension,
  TokenPosting,
  PublishMessage,
  RefreshMessage,
  TombstoneMessage,
  LocalFileEntry,
  OverlayConfig,
  Collection,
  CollectionItem,
} from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";

import { IdentityManager } from "../identity/index.js";
import { LocalDatabase } from "../localdb/index.js";
import { hashFile, hashBytes } from "./hasher.js";
import {
  tokenizeFile,
  tokenizeFilename,
  parseExtension,
  truncateFilename,
} from "./tokenizer.js";
import {
  getPublishSignableBytes,
  getRefreshSignableBytes,
  getTombstoneSignableBytes,
  getCollectionSignableBytes,
} from "../utils/cbor.js";

/**
 * File scan result
 */
export interface ScanResult {
  path: string;
  filename: string;
  size: number;
  mtime: number;
  ext: FileExtension;
}

/**
 * Publisher class - handles file scanning, hashing, and posting creation
 */
export class Publisher {
  private config: OverlayConfig;

  constructor(
    private identity: IdentityManager,
    private localDb: LocalDatabase,
    config?: Partial<OverlayConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Scan a directory for files
   */
  async scanDirectory(
    dirPath: string,
    recursive: boolean = true,
  ): Promise<ScanResult[]> {
    const results: ScanResult[] = [];

    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory() && recursive) {
        const subResults = await this.scanDirectory(fullPath, recursive);
        results.push(...subResults);
      } else if (entry.isFile()) {
        try {
          const stats = await stat(fullPath);
          const ext = parseExtension(entry.name);

          // Skip all 0-byte files (likely placeholders or trashed files)
          if (stats.size === 0) {
            continue;
          }

          // Skip tiny audio/video files (often placeholders or corrupted)
          const isAudio = [
            "mp3",
            "flac",
            "wav",
            "aac",
            "ogg",
            "opus",
            "wma",
            "m4a",
            "aiff",
          ].includes(ext);
          const isVideo = ["mp4", "mkv", "avi", "mov", "wmv", "webm"].includes(
            ext,
          );
          if ((isAudio || isVideo) && stats.size < 1024) {
            continue;
          }

          results.push({
            path: fullPath,
            filename: entry.name,
            size: stats.size,
            mtime: stats.mtimeMs,
            ext,
          });
        } catch {
          // Skip files we can't stat
        }
      }
    }

    return results;
  }

  /**
   * Index a single file - hash, tokenize, extract metadata, and store locally
   */
  async indexFile(scanResult: ScanResult): Promise<LocalFileEntry> {
    // Hash the file
    const contentHash = await hashFile(scanResult.path);

    // Tokenize
    const tokenResult = tokenizeFile(
      dirname(scanResult.path),
      scanResult.filename,
      scanResult.ext,
    );

    // Extract parent folder name (privacy-safe - just the folder name, not full path)
    const folderPath = basename(dirname(scanResult.path));

    // Extract media metadata (bitrate, duration, resolution)
    let bitrate: number | undefined;
    let duration: number | undefined;
    let width: number | undefined;
    let height: number | undefined;

    try {
      const metadata = await parseFile(scanResult.path);
      bitrate = metadata.format.bitrate;
      duration = metadata.format.duration;

      // Video resolution - check native format properties first
      const format = metadata.format as any;
      if (format.width && format.height) {
        width = format.width;
        height = format.height;
      }
    } catch {
      // Not a media file or unreadable - that's OK
    }

    const entry: LocalFileEntry = {
      path: scanResult.path,
      contentHash,
      size: scanResult.size,
      mtime: scanResult.mtime,
      ext: scanResult.ext,
      tokens: tokenResult.tokens,
      folderPath,
      bitrate,
      duration,
      width,
      height,
    };

    // Store in local DB
    this.localDb.upsertFile(entry);

    return entry;
  }

  /**
   * Index multiple files
   */
  async indexFiles(scanResults: ScanResult[]): Promise<LocalFileEntry[]> {
    const entries: LocalFileEntry[] = [];
    const failures = new Map<string, { count: number; samples: string[] }>();

    const summarizeError = (err: unknown): string => {
      if (err instanceof Error && err.message) {
        return err.message;
      }
      return String(err);
    };

    for (const result of scanResults) {
      try {
        const entry = await this.indexFile(result);
        entries.push(entry);
      } catch (err) {
        const reason = summarizeError(err);
        const existing = failures.get(reason);
        if (existing) {
          existing.count += 1;
          if (existing.samples.length < 3) {
            existing.samples.push(result.path);
          }
        } else {
          failures.set(reason, { count: 1, samples: [result.path] });
        }
      }
    }

    if (failures.size > 0) {
      const failedCount = scanResults.length - entries.length;
      console.warn(
        `[overlay] Failed to index ${failedCount} file(s) across ${failures.size} error type(s)`,
      );

      for (const [reason, details] of failures) {
        const examples = details.samples.join(", ");
        console.warn(
          `[overlay] ${reason} (${details.count} file(s)); examples: ${examples}`,
        );
      }
    }

    return entries;
  }

  /**
   * Create token postings from a local file entry
   */
  createTokenPostings(entry: LocalFileEntry): TokenPosting[] {
    const filenameShort = truncateFilename(basename(entry.path));

    return entry.tokens.map((token) => ({
      token,
      contentHash: entry.contentHash,
      size: entry.size,
      ext: entry.ext,
      filenameShort,
      folderPath: entry.folderPath,
      bitrate: entry.bitrate,
      duration: entry.duration,
      width: entry.width,
      height: entry.height,
    }));
  }

  /**
   * Create a signed PUBLISH message
   */
  createPublishMessage(entries: LocalFileEntry[]): PublishMessage {
    const providerPubKey = this.identity.getPublicKey();
    const ts = Date.now();
    const ttlMs = this.config.defaultTtlMs;

    // Collect all token postings
    const postings: TokenPosting[] = [];
    for (const entry of entries) {
      postings.push(...this.createTokenPostings(entry));
    }

    // Create signable message (without sig)
    const signableMsg = {
      providerPubKey,
      ts,
      ttlMs,
      postings,
    };

    // Sign
    const signableBytes = getPublishSignableBytes(signableMsg);
    const sig = this.identity.sign(signableBytes);

    return {
      type: "PUBLISH",
      providerPubKey,
      ts,
      ttlMs,
      postings,
      sig,
    };
  }

  /**
   * Create a signed REFRESH message
   */
  createRefreshMessage(entries: LocalFileEntry[]): RefreshMessage {
    const providerPubKey = this.identity.getPublicKey();
    const ts = Date.now();
    const ttlMs = this.config.defaultTtlMs;

    // Collect items to refresh
    const items: Array<{ token: string; contentHash: ContentHash }> = [];
    for (const entry of entries) {
      for (const token of entry.tokens) {
        items.push({ token, contentHash: entry.contentHash });
      }
    }

    // Sign
    const signableMsg = { providerPubKey, ts, ttlMs, items };
    const signableBytes = getRefreshSignableBytes(signableMsg);
    const sig = this.identity.sign(signableBytes);

    return {
      type: "REFRESH",
      providerPubKey,
      ts,
      ttlMs,
      items,
      sig,
    };
  }

  /**
   * Create a signed TOMBSTONE message for deleted files
   */
  createTombstoneMessage(
    contentHashes: ContentHash[],
  ): TombstoneMessage | null {
    const providerPubKey = this.identity.getPublicKey();
    const ts = Date.now();

    // Collect removals from local DB
    const removals: Array<{ token: string; contentHash: ContentHash }> = [];
    for (const contentHash of contentHashes) {
      const tokens = this.localDb.getFileTerms(contentHash);
      for (const token of tokens) {
        removals.push({ token, contentHash });
      }
    }

    if (removals.length === 0) {
      return null;
    }

    // Sign
    const signableMsg = { providerPubKey, ts, removals };
    const signableBytes = getTombstoneSignableBytes(signableMsg);
    const sig = this.identity.sign(signableBytes);

    return {
      type: "TOMBSTONE",
      providerPubKey,
      ts,
      removals,
      sig,
    };
  }

  /**
   * Get files that need to be published (new or stale)
   */
  getFilesNeedingPublish(): LocalFileEntry[] {
    return this.localDb.getFilesNeedingPublish(this.config.refreshIntervalMs);
  }

  /**
   * Mark files as published
   */
  markFilesPublished(entries: LocalFileEntry[]): void {
    for (const entry of entries) {
      this.localDb.markPublished(entry.contentHash);
    }
  }

  /**
   * Handle file deletion - creates tombstone and cleans up
   */
  handleFileDeletion(filePath: string): TombstoneMessage | null {
    const contentHash = this.localDb.deleteFile(filePath);
    if (!contentHash) return null;

    const tombstone = this.createTombstoneMessage([contentHash]);

    // Clean up file terms after tombstone created
    if (tombstone) {
      this.localDb.deleteFileTerms(contentHash);
    }

    return tombstone;
  }

  /**
   * Remove files no longer present on disk and generate tombstones.
   */
  pruneMissingFiles(currentPaths: Set<string>): {
    removed: ContentHash[];
    tombstone: TombstoneMessage | null;
  } {
    const knownFiles = this.localDb.getAllFiles();
    const removed: ContentHash[] = [];

    for (const entry of knownFiles) {
      if (!currentPaths.has(entry.path)) {
        const contentHash = this.localDb.deleteFile(entry.path);
        if (contentHash) {
          removed.push(contentHash);
        }
      }
    }

    const tombstone =
      removed.length > 0 ? this.createTombstoneMessage(removed) : null;

    if (tombstone) {
      for (const contentHash of removed) {
        this.localDb.deleteFileTerms(contentHash);
      }
    }

    return { removed, tombstone };
  }

  /**
   * Batch files into publish messages (to stay under payload limits)
   */
  batchForPublish(
    entries: LocalFileEntry[],
    maxPostingsPerMessage: number = 1000,
  ): PublishMessage[] {
    const messages: PublishMessage[] = [];
    let currentBatch: LocalFileEntry[] = [];
    let currentPostingCount = 0;

    for (const entry of entries) {
      const postingCount = entry.tokens.length;

      if (
        currentPostingCount + postingCount > maxPostingsPerMessage &&
        currentBatch.length > 0
      ) {
        // Create message for current batch
        messages.push(this.createPublishMessage(currentBatch));
        currentBatch = [];
        currentPostingCount = 0;
      }

      currentBatch.push(entry);
      currentPostingCount += postingCount;
    }

    // Final batch
    if (currentBatch.length > 0) {
      messages.push(this.createPublishMessage(currentBatch));
    }

    return messages;
  }

  /**
   * Create a signed Collection manifest from local file entries
   */
  createCollection(
    name: string,
    description: string | undefined,
    entries: LocalFileEntry[],
  ): Collection {
    const providerPubKey = this.identity.getPublicKey();
    const ts = Date.now();
    const ttlMs = this.config.defaultTtlMs;

    // Build items from entries
    const items: CollectionItem[] = entries.map((entry, index) => ({
      contentHash: entry.contentHash,
      filename: basename(entry.path),
      size: entry.size,
      ext: entry.ext,
      order: index,
    }));

    // Build signable bytes (excludes sig and id)
    const signableBytes = getCollectionSignableBytes({
      name,
      description,
      providerPubKey,
      items,
      ts,
      ttlMs,
    });

    // Compute content-addressed ID from signable bytes
    const id = hashBytes(new Uint8Array(signableBytes));

    // Sign
    const sig = this.identity.sign(signableBytes);

    return {
      id,
      name,
      description,
      providerPubKey,
      items,
      ts,
      ttlMs,
      sig,
    };
  }

  // ============================================
  // Buffer Publishing (in-memory data)
  // ============================================

  /** Maximum total size of all buffer files (100 MB) */
  private static readonly MAX_BUFFER_DIR_BYTES = 100 * 1024 * 1024;

  /**
   * Get the directory where buffer files are persisted
   */
  private getBufferDir(): string {
    return join(homedir(), ".softtseek", "buffers");
  }

  /**
   * Compute the total size of all files in the buffer directory
   */
  private async getBufferDirSize(): Promise<number> {
    const bufferDir = this.getBufferDir();
    let total = 0;

    try {
      const files = await readdir(bufferDir);
      for (const file of files) {
        try {
          const stats = await stat(join(bufferDir, file));
          total += stats.size;
        } catch {
          // Skip files we can't stat
        }
      }
    } catch {
      // Buffer directory doesn't exist yet
    }

    return total;
  }

  /**
   * Index a buffer (in-memory data) for publishing.
   * Hashes the data, persists it to disk for serving, tokenizes the name,
   * and stores the entry in the local DB.
   */
  async indexBuffer(
    name: string,
    data: Buffer,
    ext?: FileExtension,
  ): Promise<LocalFileEntry> {
    // Hash the buffer first to check if it already exists on disk
    const contentHash = hashBytes(new Uint8Array(data));

    // Persist to disk for serving
    const bufferDir = this.getBufferDir();
    await mkdir(bufferDir, { recursive: true });
    const bufferPath = join(bufferDir, contentHash);

    // Check existing file size to avoid double-counting in size limit
    let existingFileSize = 0;
    try {
      existingFileSize = (await stat(bufferPath)).size;
    } catch {
      // File doesn't exist yet
    }

    // Enforce total buffer size limit (subtract existing file if re-indexing)
    const currentSize = await this.getBufferDirSize();
    const netNewBytes = data.length - existingFileSize;
    if (netNewBytes > 0 && currentSize + netNewBytes > Publisher.MAX_BUFFER_DIR_BYTES) {
      throw new Error(
        `Buffer size limit exceeded: ${currentSize + netNewBytes} bytes would exceed ${Publisher.MAX_BUFFER_DIR_BYTES} byte limit`,
      );
    }

    await writeFile(bufferPath, data);

    // Tokenize the name
    const tokens = tokenizeFilename(name);
    const fileExt = ext || parseExtension(name);

    const entry: LocalFileEntry = {
      path: bufferPath,
      contentHash,
      size: data.length,
      mtime: Date.now(),
      ext: fileExt,
      tokens,
    };

    // Store in local DB
    this.localDb.upsertFile(entry);
    return entry;
  }

  /**
   * Index and publish multiple buffers
   */
  async publishBuffers(
    items: Array<{ name: string; data: Buffer }>,
  ): Promise<LocalFileEntry[]> {
    const entries: LocalFileEntry[] = [];
    for (const item of items) {
      const entry = await this.indexBuffer(item.name, item.data);
      entries.push(entry);
    }
    return entries;
  }

  /**
   * Clean up buffer files whose postings have expired
   * (i.e., files in the buffer directory that are no longer tracked in the local DB)
   */
  async cleanupBuffers(): Promise<number> {
    const bufferDir = this.getBufferDir();
    let cleaned = 0;

    try {
      const files = await readdir(bufferDir);
      for (const file of files) {
        // Check if file is still in local DB (still published)
        const entry = this.localDb.getFileByHash(file);
        if (!entry) {
          await unlink(join(bufferDir, file)).catch(() => {});
          cleaned++;
        }
      }
    } catch {
      // Buffer directory doesn't exist yet
    }

    return cleaned;
  }
}

/**
 * Verify a PUBLISH message signature
 */
export function verifyPublishMessage(msg: PublishMessage): boolean {
  const signableBytes = getPublishSignableBytes({
    providerPubKey: msg.providerPubKey,
    ts: msg.ts,
    ttlMs: msg.ttlMs,
    postings: msg.postings,
  });
  return IdentityManager.verify(signableBytes, msg.sig, msg.providerPubKey);
}

/**
 * Verify a REFRESH message signature
 */
export function verifyRefreshMessage(msg: RefreshMessage): boolean {
  const signableBytes = getRefreshSignableBytes({
    providerPubKey: msg.providerPubKey,
    ts: msg.ts,
    ttlMs: msg.ttlMs,
    items: msg.items,
  });
  return IdentityManager.verify(signableBytes, msg.sig, msg.providerPubKey);
}

/**
 * Verify a TOMBSTONE message signature
 */
export function verifyTombstoneMessage(msg: TombstoneMessage): boolean {
  const signableBytes = getTombstoneSignableBytes({
    providerPubKey: msg.providerPubKey,
    ts: msg.ts,
    removals: msg.removals,
  });
  return IdentityManager.verify(signableBytes, msg.sig, msg.providerPubKey);
}

/**
 * Verify a Collection signature
 */
export function verifyCollectionSignature(collection: Collection): boolean {
  const signableBytes = getCollectionSignableBytes({
    name: collection.name,
    description: collection.description,
    providerPubKey: collection.providerPubKey,
    items: collection.items,
    ts: collection.ts,
    ttlMs: collection.ttlMs,
  });
  return IdentityManager.verify(
    signableBytes,
    collection.sig,
    collection.providerPubKey,
  );
}
