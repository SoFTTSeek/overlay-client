/**
 * BLAKE3 Content Hashing Pipeline
 * PRD Section 6.1 - Content Addressing
 *
 * Uses a lazy loader to avoid top-level native imports.
 * Tries native blake3 first, falls back to blake3-wasm.
 * Call ensureBlake3() once at startup before using sync functions.
 */

import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import type { ContentHash } from '../types.js';

// Lazy-loaded createHash reference (initialized on first use)
let _createHash: (() => { update(data: Uint8Array | Buffer): void; digest(encoding: 'hex'): string }) | null = null;

/**
 * Initialize blake3 (native or wasm fallback). Safe to call multiple times.
 * Must be called before any sync hashing functions (hashBytes, hashString,
 * StreamingHasher, ChunkHasher). Async functions call this internally.
 */
export async function ensureBlake3(): Promise<void> {
  if (_createHash) return;
  try {
    const mod = await import('blake3');
    _createHash = mod.createHash;
  } catch {
    const mod = await import('blake3-wasm');
    _createHash = mod.createHash;
  }
}

/**
 * Get the loaded createHash function. Throws if ensureBlake3() hasn't been called.
 */
function getCreateHash() {
  if (!_createHash) throw new Error('blake3 not initialized. Call ensureBlake3() first.');
  return _createHash;
}

/**
 * Hash file metadata for cache invalidation
 */
export interface FileHashMeta {
  path: string;
  contentHash: ContentHash;
  size: number;
  mtime: number;
}

/**
 * In-memory hash cache
 */
const hashCache = new Map<string, FileHashMeta>();

/**
 * Generate cache key from file path, size, and mtime
 */
function getCacheKey(path: string, size: number, mtime: number): string {
  return `${path}:${size}:${mtime}`;
}

/**
 * Check if cached hash is still valid
 */
function isCacheValid(path: string, size: number, mtime: number): FileHashMeta | null {
  const key = getCacheKey(path, size, mtime);
  const cached = hashCache.get(key);
  if (cached && cached.path === path && cached.size === size && cached.mtime === mtime) {
    return cached;
  }
  return null;
}

/**
 * Store hash in cache
 */
function cacheHash(meta: FileHashMeta): void {
  const key = getCacheKey(meta.path, meta.size, meta.mtime);
  hashCache.set(key, meta);

  // Limit cache size (LRU would be better, but this is simple)
  if (hashCache.size > 10000) {
    const firstKey = hashCache.keys().next().value;
    if (firstKey) hashCache.delete(firstKey);
  }
}

/**
 * Compute BLAKE3 hash of a file
 * Uses streaming for memory efficiency with large files
 */
export async function hashFile(filePath: string): Promise<ContentHash> {
  await ensureBlake3();

  const stats = await stat(filePath);
  const size = stats.size;
  const mtime = stats.mtimeMs;

  // Check cache
  const cached = isCacheValid(filePath, size, mtime);
  if (cached) {
    return cached.contentHash;
  }

  // Compute hash
  const contentHash = await computeFileHash(filePath);

  // Cache result
  cacheHash({
    path: filePath,
    contentHash,
    size,
    mtime,
  });

  return contentHash;
}

/**
 * Compute BLAKE3 hash using streaming
 */
async function computeFileHash(filePath: string): Promise<ContentHash> {
  return new Promise((resolve, reject) => {
    const hash = getCreateHash()();
    const stream = createReadStream(filePath);

    stream.on('data', (chunk: Buffer | string) => {
      if (typeof chunk === 'string') {
        hash.update(Buffer.from(chunk));
      } else {
        hash.update(chunk);
      }
    });

    stream.on('end', () => {
      const digest = hash.digest('hex');
      resolve(digest);
    });

    stream.on('error', reject);
  });
}

/**
 * Compute BLAKE3 hash of bytes (for small data)
 * Requires ensureBlake3() to have been called.
 */
export function hashBytes(data: Uint8Array): ContentHash {
  const hash = getCreateHash()();
  hash.update(data);
  return hash.digest('hex');
}

/**
 * Compute BLAKE3 hash of a string
 * Requires ensureBlake3() to have been called.
 */
export function hashString(data: string): ContentHash {
  return hashBytes(Buffer.from(data, 'utf-8'));
}

/**
 * Verify file hash matches expected
 */
export async function verifyFileHash(
  filePath: string,
  expectedHash: ContentHash
): Promise<boolean> {
  const actualHash = await hashFile(filePath);
  return actualHash === expectedHash;
}

/**
 * Streaming hasher for download verification
 * Supports chunk-by-chunk hashing during download
 * Requires ensureBlake3() to have been called.
 */
export class StreamingHasher {
  private hash = getCreateHash()();
  private bytesProcessed = 0;

  /**
   * Update hash with new chunk
   */
  update(chunk: Uint8Array): void {
    this.hash.update(chunk);
    this.bytesProcessed += chunk.length;
  }

  /**
   * Get current bytes processed
   */
  getBytesProcessed(): number {
    return this.bytesProcessed;
  }

  /**
   * Finalize and get the hash
   */
  finalize(): ContentHash {
    return this.hash.digest('hex');
  }

  /**
   * Verify final hash matches expected
   */
  verify(expectedHash: ContentHash): boolean {
    return this.finalize() === expectedHash;
  }
}

/**
 * Chunk hasher for partial verification during download
 * Hashes each chunk independently for early failure detection
 * Requires ensureBlake3() to have been called.
 */
export class ChunkHasher {
  private chunkSize: number;
  private chunkHashes: ContentHash[] = [];
  private currentChunk: Uint8Array[] = [];
  private currentChunkBytes = 0;

  constructor(chunkSize: number = 1024 * 1024) {
    // Default 1MB chunks
    this.chunkSize = chunkSize;
  }

  /**
   * Add data to current chunk
   */
  update(data: Uint8Array): void {
    let offset = 0;

    while (offset < data.length) {
      const remaining = this.chunkSize - this.currentChunkBytes;
      const toAdd = Math.min(remaining, data.length - offset);

      this.currentChunk.push(data.slice(offset, offset + toAdd));
      this.currentChunkBytes += toAdd;
      offset += toAdd;

      if (this.currentChunkBytes >= this.chunkSize) {
        this.finalizeCurrentChunk();
      }
    }
  }

  /**
   * Finalize current chunk and compute its hash
   */
  private finalizeCurrentChunk(): void {
    if (this.currentChunk.length === 0) return;

    // Combine chunks
    const totalLength = this.currentChunk.reduce((sum, c) => sum + c.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of this.currentChunk) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    // Hash
    const hash = hashBytes(combined);
    this.chunkHashes.push(hash);

    // Reset
    this.currentChunk = [];
    this.currentChunkBytes = 0;
  }

  /**
   * Finalize all remaining data and return chunk hashes
   */
  finalize(): ContentHash[] {
    this.finalizeCurrentChunk();
    return this.chunkHashes;
  }

  /**
   * Get number of completed chunks
   */
  getCompletedChunks(): number {
    return this.chunkHashes.length;
  }

  /**
   * Get hash of a specific chunk
   */
  getChunkHash(index: number): ContentHash | undefined {
    return this.chunkHashes[index];
  }
}

/**
 * Clear the hash cache
 */
export function clearHashCache(): void {
  hashCache.clear();
}

/**
 * Get hash cache size
 */
export function getHashCacheSize(): number {
  return hashCache.size;
}

/**
 * Alias for hashBytes (for backward compatibility)
 */
export const hashBuffer = hashBytes;
