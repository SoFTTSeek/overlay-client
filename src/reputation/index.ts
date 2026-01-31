/**
 * Local Reputation Tracking
 * PRD Section 9.4 - Reputation and trust tracking
 */

import Database from 'better-sqlite3';
import type { PublicKeyHex, ContentHash } from '../types.js';

/**
 * Transfer outcome for reputation scoring
 */
export type TransferOutcome = 'success' | 'timeout' | 'corrupt' | 'refused';

/**
 * Reputation entry for a provider
 */
export interface ReputationEntry {
  pubKey: PublicKeyHex;
  successCount: number;
  failureCount: number;
  totalBytesTransferred: number;
  averageSpeedBps: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  trustScore: number;
}

/**
 * Transfer record for history
 */
export interface TransferRecord {
  id: number;
  pubKey: PublicKeyHex;
  contentHash: ContentHash;
  outcome: TransferOutcome;
  bytesTransferred: number;
  durationMs: number;
  timestamp: number;
}

/**
 * Reputation configuration
 */
interface ReputationConfig {
  decayFactorPerDay: number;
  minTransfersForReliableScore: number;
  successWeight: number;
  failureWeight: number;
  speedBonus: number;
  maxHistoryDays: number;
}

const DEFAULT_CONFIG: ReputationConfig = {
  decayFactorPerDay: 0.95,
  minTransfersForReliableScore: 5,
  successWeight: 1.0,
  failureWeight: -2.0,
  speedBonus: 0.1,
  maxHistoryDays: 30,
};

/**
 * Local Reputation Manager
 */
export class ReputationManager {
  private db: Database.Database;
  private config: ReputationConfig;

  // Prepared statements
  private stmts!: {
    getReputation: Database.Statement;
    upsertReputation: Database.Statement;
    insertTransfer: Database.Statement;
    getRecentTransfers: Database.Statement;
    getTopProviders: Database.Statement;
    getBadProviders: Database.Statement;
    cleanupOldTransfers: Database.Statement;
    getAllReputations: Database.Statement;
  };

  constructor(dbPath: string, config: Partial<ReputationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = new Database(dbPath);
    this.initializeSchema();
    this.prepareStatements();
  }

  /**
   * Initialize database schema
   */
  private initializeSchema(): void {
    this.db.exec(`
      -- Provider reputation
      CREATE TABLE IF NOT EXISTS reputation (
        pub_key TEXT PRIMARY KEY,
        success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0,
        total_bytes INTEGER DEFAULT 0,
        avg_speed_bps REAL DEFAULT 0,
        last_success_at INTEGER,
        last_failure_at INTEGER,
        trust_score REAL DEFAULT 0.5,
        updated_at INTEGER NOT NULL
      );

      -- Transfer history
      CREATE TABLE IF NOT EXISTS transfer_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pub_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        outcome TEXT NOT NULL,
        bytes_transferred INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (pub_key) REFERENCES reputation(pub_key)
      );

      CREATE INDEX IF NOT EXISTS idx_transfer_history_pubkey ON transfer_history(pub_key);
      CREATE INDEX IF NOT EXISTS idx_transfer_history_timestamp ON transfer_history(timestamp);
      CREATE INDEX IF NOT EXISTS idx_reputation_score ON reputation(trust_score DESC);
    `);
  }

  /**
   * Prepare SQL statements
   */
  private prepareStatements(): void {
    this.stmts = {
      getReputation: this.db.prepare(`
        SELECT pub_key, success_count, failure_count, total_bytes,
               avg_speed_bps, last_success_at, last_failure_at, trust_score
        FROM reputation WHERE pub_key = ?
      `),

      upsertReputation: this.db.prepare(`
        INSERT INTO reputation (
          pub_key, success_count, failure_count, total_bytes,
          avg_speed_bps, last_success_at, last_failure_at, trust_score, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(pub_key) DO UPDATE SET
          success_count = excluded.success_count,
          failure_count = excluded.failure_count,
          total_bytes = excluded.total_bytes,
          avg_speed_bps = excluded.avg_speed_bps,
          last_success_at = excluded.last_success_at,
          last_failure_at = excluded.last_failure_at,
          trust_score = excluded.trust_score,
          updated_at = excluded.updated_at
      `),

      insertTransfer: this.db.prepare(`
        INSERT INTO transfer_history (pub_key, content_hash, outcome, bytes_transferred, duration_ms, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `),

      getRecentTransfers: this.db.prepare(`
        SELECT id, pub_key, content_hash, outcome, bytes_transferred, duration_ms, timestamp
        FROM transfer_history
        WHERE pub_key = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `),

      getTopProviders: this.db.prepare(`
        SELECT pub_key, success_count, failure_count, total_bytes,
               avg_speed_bps, last_success_at, last_failure_at, trust_score
        FROM reputation
        WHERE trust_score >= 0.5
        ORDER BY trust_score DESC
        LIMIT ?
      `),

      getBadProviders: this.db.prepare(`
        SELECT pub_key, success_count, failure_count, total_bytes,
               avg_speed_bps, last_success_at, last_failure_at, trust_score
        FROM reputation
        WHERE trust_score < 0.3
        ORDER BY trust_score ASC
        LIMIT ?
      `),

      cleanupOldTransfers: this.db.prepare(`
        DELETE FROM transfer_history
        WHERE timestamp < ?
      `),

      getAllReputations: this.db.prepare(`
        SELECT pub_key, success_count, failure_count, total_bytes,
               avg_speed_bps, last_success_at, last_failure_at, trust_score
        FROM reputation
        ORDER BY trust_score DESC
      `),
    };
  }

  /**
   * Record a transfer outcome
   */
  recordTransfer(
    pubKey: PublicKeyHex,
    contentHash: ContentHash,
    outcome: TransferOutcome,
    bytesTransferred: number,
    durationMs: number
  ): void {
    const timestamp = Date.now();

    // Ensure reputation entry exists first (for FK constraint)
    // Use prepared statement to prevent SQL injection
    this.db.prepare('INSERT OR IGNORE INTO reputation (pub_key, updated_at) VALUES (?, ?)').run(pubKey, timestamp);

    // Insert transfer record
    this.stmts.insertTransfer.run(
      pubKey,
      contentHash,
      outcome,
      bytesTransferred,
      durationMs,
      timestamp
    );

    // Update reputation
    this.updateReputation(pubKey, outcome, bytesTransferred, durationMs, timestamp);
  }

  /**
   * Update provider reputation
   */
  private updateReputation(
    pubKey: PublicKeyHex,
    outcome: TransferOutcome,
    bytesTransferred: number,
    durationMs: number,
    timestamp: number
  ): void {
    // Get current reputation
    const row = this.stmts.getReputation.get(pubKey) as any;

    let successCount = row?.success_count || 0;
    let failureCount = row?.failure_count || 0;
    let totalBytes = row?.total_bytes || 0;
    let avgSpeedBps = row?.avg_speed_bps || 0;
    let lastSuccessAt = row?.last_success_at || null;
    let lastFailureAt = row?.last_failure_at || null;

    // Update counts
    const isSuccess = outcome === 'success';
    if (isSuccess) {
      successCount++;
      lastSuccessAt = timestamp;
      totalBytes += bytesTransferred;

      // Update average speed (exponential moving average)
      if (durationMs > 0) {
        const speedBps = (bytesTransferred / durationMs) * 1000;
        avgSpeedBps = avgSpeedBps === 0 ? speedBps : avgSpeedBps * 0.8 + speedBps * 0.2;
      }
    } else {
      failureCount++;
      lastFailureAt = timestamp;
    }

    // Calculate trust score
    const trustScore = this.calculateTrustScore(
      successCount,
      failureCount,
      avgSpeedBps,
      lastSuccessAt,
      lastFailureAt
    );

    // Save reputation
    this.stmts.upsertReputation.run(
      pubKey,
      successCount,
      failureCount,
      totalBytes,
      avgSpeedBps,
      lastSuccessAt,
      lastFailureAt,
      trustScore,
      timestamp
    );
  }

  /**
   * Calculate trust score
   */
  private calculateTrustScore(
    successCount: number,
    failureCount: number,
    avgSpeedBps: number,
    lastSuccessAt: number | null,
    lastFailureAt: number | null
  ): number {
    const totalTransfers = successCount + failureCount;

    if (totalTransfers === 0) {
      return 0.5; // Neutral for unknown providers
    }

    // Base score from success rate
    const successRate = successCount / totalTransfers;
    let score = successRate;

    // Apply penalty for failures (weighted more heavily)
    const weightedSuccess = successCount * this.config.successWeight;
    const weightedFailure = failureCount * Math.abs(this.config.failureWeight);
    const weightedScore = weightedSuccess / (weightedSuccess + weightedFailure + 1);

    score = (score + weightedScore) / 2;

    // Speed bonus
    const speedMBps = avgSpeedBps / (1024 * 1024);
    if (speedMBps >= 1) {
      score += Math.min(this.config.speedBonus, speedMBps * 0.01);
    }

    // Time decay - recent failures hurt more
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    if (lastFailureAt) {
      const daysSinceFailure = (now - lastFailureAt) / dayMs;
      if (daysSinceFailure < 1) {
        // Recent failure - apply penalty
        score *= 0.9;
      }
    }

    if (lastSuccessAt) {
      const daysSinceSuccess = (now - lastSuccessAt) / dayMs;
      if (daysSinceSuccess > 7) {
        // Stale provider - decay score
        const decayDays = Math.min(daysSinceSuccess - 7, 30);
        score *= Math.pow(this.config.decayFactorPerDay, decayDays);
      }
    }

    // Confidence adjustment for low sample sizes
    if (totalTransfers < this.config.minTransfersForReliableScore) {
      // Regress toward neutral
      const confidence = totalTransfers / this.config.minTransfersForReliableScore;
      score = score * confidence + 0.5 * (1 - confidence);
    }

    // Clamp to [0, 1]
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Get reputation for a provider
   */
  getReputation(pubKey: PublicKeyHex): ReputationEntry | null {
    const row = this.stmts.getReputation.get(pubKey) as any;

    if (!row) return null;

    return {
      pubKey: row.pub_key,
      successCount: row.success_count,
      failureCount: row.failure_count,
      totalBytesTransferred: row.total_bytes,
      averageSpeedBps: row.avg_speed_bps,
      lastSuccessAt: row.last_success_at,
      lastFailureAt: row.last_failure_at,
      trustScore: row.trust_score,
    };
  }

  /**
   * Get trust score for a provider (returns 0.5 for unknown)
   */
  getTrustScore(pubKey: PublicKeyHex): number {
    const rep = this.getReputation(pubKey);
    return rep?.trustScore ?? 0.5;
  }

  /**
   * Check if provider is trusted
   */
  isTrusted(pubKey: PublicKeyHex, threshold: number = 0.5): boolean {
    return this.getTrustScore(pubKey) >= threshold;
  }

  /**
   * Check if provider is blocked
   */
  isBlocked(pubKey: PublicKeyHex, threshold: number = 0.2): boolean {
    const rep = this.getReputation(pubKey);
    if (!rep) return false;

    // Block if low score AND has enough history
    const totalTransfers = rep.successCount + rep.failureCount;
    return rep.trustScore < threshold && totalTransfers >= this.config.minTransfersForReliableScore;
  }

  /**
   * Get recent transfers for a provider
   */
  getRecentTransfers(pubKey: PublicKeyHex, limit: number = 10): TransferRecord[] {
    const rows = this.stmts.getRecentTransfers.all(pubKey, limit) as any[];

    return rows.map(row => ({
      id: row.id,
      pubKey: row.pub_key,
      contentHash: row.content_hash,
      outcome: row.outcome as TransferOutcome,
      bytesTransferred: row.bytes_transferred,
      durationMs: row.duration_ms,
      timestamp: row.timestamp,
    }));
  }

  /**
   * Get top trusted providers
   */
  getTopProviders(limit: number = 100): ReputationEntry[] {
    const rows = this.stmts.getTopProviders.all(limit) as any[];

    return rows.map(row => ({
      pubKey: row.pub_key,
      successCount: row.success_count,
      failureCount: row.failure_count,
      totalBytesTransferred: row.total_bytes,
      averageSpeedBps: row.avg_speed_bps,
      lastSuccessAt: row.last_success_at,
      lastFailureAt: row.last_failure_at,
      trustScore: row.trust_score,
    }));
  }

  /**
   * Get bad/blocked providers
   */
  getBadProviders(limit: number = 100): ReputationEntry[] {
    const rows = this.stmts.getBadProviders.all(limit) as any[];

    return rows.map(row => ({
      pubKey: row.pub_key,
      successCount: row.success_count,
      failureCount: row.failure_count,
      totalBytesTransferred: row.total_bytes,
      averageSpeedBps: row.avg_speed_bps,
      lastSuccessAt: row.last_success_at,
      lastFailureAt: row.last_failure_at,
      trustScore: row.trust_score,
    }));
  }

  /**
   * Sort providers by reputation
   */
  sortByReputation(pubKeys: PublicKeyHex[]): PublicKeyHex[] {
    const scores = new Map<PublicKeyHex, number>();

    for (const pubKey of pubKeys) {
      scores.set(pubKey, this.getTrustScore(pubKey));
    }

    return [...pubKeys].sort((a, b) => {
      return (scores.get(b) || 0.5) - (scores.get(a) || 0.5);
    });
  }

  /**
   * Filter out blocked providers
   */
  filterBlocked(pubKeys: PublicKeyHex[]): PublicKeyHex[] {
    return pubKeys.filter(pk => !this.isBlocked(pk));
  }

  /**
   * Cleanup old transfer history
   */
  cleanup(): void {
    const cutoff = Date.now() - this.config.maxHistoryDays * 24 * 60 * 60 * 1000;
    this.stmts.cleanupOldTransfers.run(cutoff);
  }

  /**
   * Get all reputations
   */
  getAllReputations(): ReputationEntry[] {
    const rows = this.stmts.getAllReputations.all() as any[];

    return rows.map(row => ({
      pubKey: row.pub_key,
      successCount: row.success_count,
      failureCount: row.failure_count,
      totalBytesTransferred: row.total_bytes,
      averageSpeedBps: row.avg_speed_bps,
      lastSuccessAt: row.last_success_at,
      lastFailureAt: row.last_failure_at,
      trustScore: row.trust_score,
    }));
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalProviders: number;
    trustedProviders: number;
    blockedProviders: number;
    totalTransfers: number;
  } {
    const all = this.getAllReputations();
    const trusted = all.filter(r => r.trustScore >= 0.5);
    const blocked = all.filter(r => this.isBlocked(r.pubKey));
    const totalTransfers = all.reduce((sum, r) => sum + r.successCount + r.failureCount, 0);

    return {
      totalProviders: all.length,
      trustedProviders: trusted.length,
      blockedProviders: blocked.length,
      totalTransfers,
    };
  }

  /**
   * Close the database
   */
  close(): void {
    this.db.close();
  }
}
