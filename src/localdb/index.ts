/**
 * Local Database Module
 * PRD Section 6.3 - Term tracking for deletions
 * PRD Section 10.1 - Local reputation signals
 */

import Database from 'better-sqlite3';
import type {
  ContentHash,
  PublicKeyHex,
  FileExtension,
  LocalFileEntry,
  ProviderReputation,
} from '../types.js';

/**
 * Initialize the local database
 */
export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    -- File entries with content hashes
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime REAL NOT NULL,
      ext TEXT NOT NULL,
      last_published INTEGER
    );

    -- Token to content hash mapping (for deletion tombstones)
    CREATE TABLE IF NOT EXISTS file_terms (
      content_hash TEXT NOT NULL,
      token TEXT NOT NULL,
      PRIMARY KEY (content_hash, token)
    );

    -- Provider reputation tracking
    CREATE TABLE IF NOT EXISTS reputation (
      pub_key TEXT PRIMARY KEY,
      successful_transfers INTEGER DEFAULT 0,
      failed_transfers INTEGER DEFAULT 0,
      total_bytes_received INTEGER DEFAULT 0,
      avg_time_to_first_byte REAL DEFAULT 0,
      direct_connections INTEGER DEFAULT 0,
      relay_connections INTEGER DEFAULT 0,
      last_seen INTEGER,
      blocked INTEGER DEFAULT 0
    );

    -- Hash cache for avoiding re-hashing
    CREATE TABLE IF NOT EXISTS hash_cache (
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime REAL NOT NULL,
      content_hash TEXT NOT NULL,
      PRIMARY KEY (path, size, mtime)
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);
    CREATE INDEX IF NOT EXISTS idx_file_terms_hash ON file_terms(content_hash);
    CREATE INDEX IF NOT EXISTS idx_file_terms_token ON file_terms(token);
  `);

  return db;
}

/**
 * Local Database class
 */
export class LocalDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = initDatabase(dbPath);
  }

  /**
   * Close the database
   */
  close(): void {
    this.db.close();
  }

  // ============================================
  // File Entry Operations
  // ============================================

  /**
   * Add or update a file entry
   */
  upsertFile(entry: LocalFileEntry): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO files (path, content_hash, size, mtime, ext, last_published)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.path,
      entry.contentHash,
      entry.size,
      entry.mtime,
      entry.ext,
      entry.lastPublished || null
    );

    // Update file_terms
    this.setFileTerms(entry.contentHash, entry.tokens);
  }

  /**
   * Get a file entry by path
   */
  getFile(path: string): LocalFileEntry | null {
    const stmt = this.db.prepare(`
      SELECT path, content_hash, size, mtime, ext, last_published FROM files WHERE path = ?
    `);
    const row = stmt.get(path) as any;
    if (!row) return null;

    // Get tokens
    const tokens = this.getFileTerms(row.content_hash);

    return {
      path: row.path,
      contentHash: row.content_hash,
      size: row.size,
      mtime: row.mtime,
      ext: row.ext as FileExtension,
      tokens,
      lastPublished: row.last_published || undefined,
    };
  }

  /**
   * Get a file entry by content hash
   */
  getFileByHash(contentHash: ContentHash): LocalFileEntry | null {
    const stmt = this.db.prepare(`
      SELECT path, content_hash, size, mtime, ext, last_published FROM files WHERE content_hash = ?
    `);
    const row = stmt.get(contentHash) as any;
    if (!row) return null;

    const tokens = this.getFileTerms(row.content_hash);

    return {
      path: row.path,
      contentHash: row.content_hash,
      size: row.size,
      mtime: row.mtime,
      ext: row.ext as FileExtension,
      tokens,
      lastPublished: row.last_published || undefined,
    };
  }

  /**
   * Delete a file entry
   */
  deleteFile(path: string): ContentHash | null {
    // Get content hash first (for tombstone generation)
    const file = this.getFile(path);
    if (!file) return null;

    const stmt = this.db.prepare('DELETE FROM files WHERE path = ?');
    stmt.run(path);

    // Note: We keep file_terms for tombstone generation
    // They will be cleaned up after tombstone is sent

    return file.contentHash;
  }

  /**
   * Get all files that need publishing (not published or stale)
   */
  getFilesNeedingPublish(maxAge: number): LocalFileEntry[] {
    const cutoff = Date.now() - maxAge;
    const stmt = this.db.prepare(`
      SELECT path, content_hash, size, mtime, ext, last_published
      FROM files
      WHERE last_published IS NULL OR last_published < ?
    `);
    const rows = stmt.all(cutoff) as any[];

    return rows.map(row => {
      const tokens = this.getFileTerms(row.content_hash);
      return {
        path: row.path,
        contentHash: row.content_hash,
        size: row.size,
        mtime: row.mtime,
        ext: row.ext as FileExtension,
        tokens,
        lastPublished: row.last_published || undefined,
      };
    });
  }

  /**
   * Mark file as published
   */
  markPublished(contentHash: ContentHash): void {
    const stmt = this.db.prepare(`
      UPDATE files SET last_published = ? WHERE content_hash = ?
    `);
    stmt.run(Date.now(), contentHash);
  }

  // ============================================
  // File Terms Operations (for tombstones)
  // ============================================

  /**
   * Set tokens for a content hash
   */
  setFileTerms(contentHash: ContentHash, tokens: string[]): void {
    // Delete existing terms
    const deleteStmt = this.db.prepare('DELETE FROM file_terms WHERE content_hash = ?');
    deleteStmt.run(contentHash);

    // Insert new terms
    const insertStmt = this.db.prepare(`
      INSERT INTO file_terms (content_hash, token) VALUES (?, ?)
    `);
    for (const token of tokens) {
      insertStmt.run(contentHash, token);
    }
  }

  /**
   * Get tokens for a content hash
   */
  getFileTerms(contentHash: ContentHash): string[] {
    const stmt = this.db.prepare('SELECT token FROM file_terms WHERE content_hash = ?');
    const rows = stmt.all(contentHash) as any[];
    return rows.map(row => row.token);
  }

  /**
   * Delete file terms (after tombstone sent)
   */
  deleteFileTerms(contentHash: ContentHash): void {
    const stmt = this.db.prepare('DELETE FROM file_terms WHERE content_hash = ?');
    stmt.run(contentHash);
  }

  // ============================================
  // Reputation Operations
  // ============================================

  /**
   * Get reputation for a provider
   */
  getReputation(pubKey: PublicKeyHex): ProviderReputation | null {
    const stmt = this.db.prepare('SELECT * FROM reputation WHERE pub_key = ?');
    const row = stmt.get(pubKey) as any;
    if (!row) return null;

    return {
      pubKey: row.pub_key,
      successfulTransfers: row.successful_transfers,
      failedTransfers: row.failed_transfers,
      totalBytesReceived: row.total_bytes_received,
      avgTimeToFirstByte: row.avg_time_to_first_byte,
      directConnections: row.direct_connections,
      relayConnections: row.relay_connections,
      lastSeen: row.last_seen,
      blocked: row.blocked === 1,
    };
  }

  /**
   * Record a successful transfer
   */
  recordSuccessfulTransfer(
    pubKey: PublicKeyHex,
    bytesReceived: number,
    timeToFirstByte: number,
    usedRelay: boolean
  ): void {
    const existing = this.getReputation(pubKey);

    if (existing) {
      // Update existing
      const newAvgTtfb =
        (existing.avgTimeToFirstByte * existing.successfulTransfers + timeToFirstByte) /
        (existing.successfulTransfers + 1);

      const stmt = this.db.prepare(`
        UPDATE reputation SET
          successful_transfers = successful_transfers + 1,
          total_bytes_received = total_bytes_received + ?,
          avg_time_to_first_byte = ?,
          direct_connections = direct_connections + ?,
          relay_connections = relay_connections + ?,
          last_seen = ?
        WHERE pub_key = ?
      `);
      stmt.run(
        bytesReceived,
        newAvgTtfb,
        usedRelay ? 0 : 1,
        usedRelay ? 1 : 0,
        Date.now(),
        pubKey
      );
    } else {
      // Insert new
      const stmt = this.db.prepare(`
        INSERT INTO reputation (
          pub_key, successful_transfers, total_bytes_received, avg_time_to_first_byte,
          direct_connections, relay_connections, last_seen
        ) VALUES (?, 1, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        pubKey,
        bytesReceived,
        timeToFirstByte,
        usedRelay ? 0 : 1,
        usedRelay ? 1 : 0,
        Date.now()
      );
    }
  }

  /**
   * Record a failed transfer
   */
  recordFailedTransfer(pubKey: PublicKeyHex): void {
    const existing = this.getReputation(pubKey);

    if (existing) {
      const stmt = this.db.prepare(`
        UPDATE reputation SET failed_transfers = failed_transfers + 1, last_seen = ?
        WHERE pub_key = ?
      `);
      stmt.run(Date.now(), pubKey);
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO reputation (pub_key, failed_transfers, last_seen) VALUES (?, 1, ?)
      `);
      stmt.run(pubKey, Date.now());
    }
  }

  /**
   * Block a provider
   */
  blockProvider(pubKey: PublicKeyHex): void {
    const stmt = this.db.prepare(`
      INSERT INTO reputation (pub_key, blocked) VALUES (?, 1)
      ON CONFLICT(pub_key) DO UPDATE SET blocked = 1
    `);
    stmt.run(pubKey);
  }

  /**
   * Unblock a provider
   */
  unblockProvider(pubKey: PublicKeyHex): void {
    const stmt = this.db.prepare('UPDATE reputation SET blocked = 0 WHERE pub_key = ?');
    stmt.run(pubKey);
  }

  /**
   * Check if provider is blocked
   */
  isBlocked(pubKey: PublicKeyHex): boolean {
    const rep = this.getReputation(pubKey);
    return rep?.blocked === true;
  }

  // ============================================
  // Hash Cache Operations
  // ============================================

  /**
   * Get cached hash for a file
   */
  getCachedHash(path: string, size: number, mtime: number): ContentHash | null {
    const stmt = this.db.prepare(`
      SELECT content_hash FROM hash_cache WHERE path = ? AND size = ? AND mtime = ?
    `);
    const row = stmt.get(path, size, mtime) as any;
    return row?.content_hash || null;
  }

  /**
   * Cache a hash
   */
  cacheHash(path: string, size: number, mtime: number, contentHash: ContentHash): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO hash_cache (path, size, mtime, content_hash) VALUES (?, ?, ?, ?)
    `);
    stmt.run(path, size, mtime, contentHash);
  }

  /**
   * Clear stale cache entries (files that no longer exist or have changed)
   */
  clearStaleCache(): number {
    // This would need filesystem checks - for now just return 0
    return 0;
  }
}
