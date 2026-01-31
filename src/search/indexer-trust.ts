/**
 * Indexer Trust Scoring
 * PRD Section 5.5 - Indexer selection and trust
 */

import type { PublicKeyHex } from '../types.js';

/**
 * Indexer health info
 */
export interface IndexerHealth {
  url: string;
  successCount: number;
  failureCount: number;
  totalLatencyMs: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  trustScore: number;
}

/**
 * Query result for trust tracking
 */
export interface IndexerQueryResult {
  url: string;
  success: boolean;
  latencyMs: number;
  resultCount: number;
}

/**
 * Trust configuration
 */
interface TrustConfig {
  initialTrustScore: number;
  successBonus: number;
  failurePenalty: number;
  latencyWeight: number;
  targetLatencyMs: number;
  minTrustScore: number;
  maxTrustScore: number;
  decayFactor: number;
  decayIntervalMs: number;
}

const DEFAULT_CONFIG: TrustConfig = {
  initialTrustScore: 0.5,
  successBonus: 0.05,
  failurePenalty: 0.15,
  latencyWeight: 0.1,
  targetLatencyMs: 200,
  minTrustScore: 0.0,
  maxTrustScore: 1.0,
  decayFactor: 0.99,
  decayIntervalMs: 60 * 60 * 1000, // 1 hour
};

/**
 * Indexer Trust Manager
 * Tracks indexer reliability and selects best indexers for queries
 */
export class IndexerTrustManager {
  private indexers: Map<string, IndexerHealth> = new Map();
  private config: TrustConfig;
  private lastDecayAt: number = Date.now();

  constructor(config: Partial<TrustConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize indexers from bootstrap
   */
  initializeIndexers(urls: string[]): void {
    for (const url of urls) {
      if (!this.indexers.has(url)) {
        this.indexers.set(url, {
          url,
          successCount: 0,
          failureCount: 0,
          totalLatencyMs: 0,
          lastSuccessAt: null,
          lastFailureAt: null,
          trustScore: this.config.initialTrustScore,
        });
      }
    }
  }

  /**
   * Record a query result
   */
  recordQueryResult(result: IndexerQueryResult): void {
    let health = this.indexers.get(result.url);

    if (!health) {
      health = {
        url: result.url,
        successCount: 0,
        failureCount: 0,
        totalLatencyMs: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        trustScore: this.config.initialTrustScore,
      };
      this.indexers.set(result.url, health);
    }

    const now = Date.now();

    if (result.success) {
      health.successCount++;
      health.lastSuccessAt = now;
      health.totalLatencyMs += result.latencyMs;

      // Calculate trust score adjustment
      let bonus = this.config.successBonus;

      // Bonus for good latency
      if (result.latencyMs < this.config.targetLatencyMs) {
        const latencyBonus = (1 - result.latencyMs / this.config.targetLatencyMs) * this.config.latencyWeight;
        bonus += latencyBonus;
      }

      // Bonus for returning results
      if (result.resultCount > 0) {
        bonus += 0.02;
      }

      health.trustScore = Math.min(
        this.config.maxTrustScore,
        health.trustScore + bonus
      );
    } else {
      health.failureCount++;
      health.lastFailureAt = now;

      // Apply failure penalty
      health.trustScore = Math.max(
        this.config.minTrustScore,
        health.trustScore - this.config.failurePenalty
      );
    }

    // Apply time-based decay
    this.applyDecay();
  }

  /**
   * Apply time-based decay to all scores
   */
  private applyDecay(): void {
    const now = Date.now();
    const elapsed = now - this.lastDecayAt;

    if (elapsed < this.config.decayIntervalMs) return;

    const decayPeriods = Math.floor(elapsed / this.config.decayIntervalMs);
    const totalDecay = Math.pow(this.config.decayFactor, decayPeriods);

    for (const health of this.indexers.values()) {
      // Decay toward initial score
      const diff = health.trustScore - this.config.initialTrustScore;
      health.trustScore = this.config.initialTrustScore + diff * totalDecay;
    }

    this.lastDecayAt = now;
  }

  /**
   * Get trust score for an indexer
   */
  getTrustScore(url: string): number {
    return this.indexers.get(url)?.trustScore ?? this.config.initialTrustScore;
  }

  /**
   * Get health info for an indexer
   */
  getHealth(url: string): IndexerHealth | null {
    return this.indexers.get(url) || null;
  }

  /**
   * Get all indexers sorted by trust score
   */
  getSortedIndexers(): IndexerHealth[] {
    return Array.from(this.indexers.values()).sort(
      (a, b) => b.trustScore - a.trustScore
    );
  }

  /**
   * Get best indexers for a query (top N by trust score)
   */
  getBestIndexers(count: number): string[] {
    return this.getSortedIndexers()
      .slice(0, count)
      .map(h => h.url);
  }

  /**
   * Select indexers using weighted random selection
   * Higher trust = higher probability of selection
   */
  selectIndexersWeighted(count: number, fromUrls?: string[]): string[] {
    const candidates = fromUrls
      ? fromUrls.map(url => this.indexers.get(url)).filter(Boolean) as IndexerHealth[]
      : Array.from(this.indexers.values());

    if (candidates.length <= count) {
      return candidates.map(h => h.url);
    }

    // Calculate total weight
    const totalWeight = candidates.reduce((sum, h) => sum + h.trustScore, 0);

    if (totalWeight === 0) {
      // All scores are 0, use random selection
      return this.shuffleArray(candidates)
        .slice(0, count)
        .map(h => h.url);
    }

    // Weighted random selection without replacement
    const selected: string[] = [];
    const remaining = [...candidates];

    while (selected.length < count && remaining.length > 0) {
      const totalRemaining = remaining.reduce((sum, h) => sum + h.trustScore, 0);
      let random = Math.random() * totalRemaining;

      for (let i = 0; i < remaining.length; i++) {
        random -= remaining[i].trustScore;
        if (random <= 0) {
          selected.push(remaining[i].url);
          remaining.splice(i, 1);
          break;
        }
      }
    }

    return selected;
  }

  /**
   * Check if indexer is healthy enough to use
   */
  isHealthy(url: string, threshold: number = 0.3): boolean {
    const health = this.indexers.get(url);
    if (!health) return true; // Unknown indexers get benefit of doubt

    return health.trustScore >= threshold;
  }

  /**
   * Get average latency for an indexer
   */
  getAverageLatency(url: string): number {
    const health = this.indexers.get(url);
    if (!health || health.successCount === 0) return Infinity;

    return health.totalLatencyMs / health.successCount;
  }

  /**
   * Filter to only healthy indexers
   */
  filterHealthy(urls: string[], threshold: number = 0.3): string[] {
    return urls.filter(url => this.isHealthy(url, threshold));
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalIndexers: number;
    healthyIndexers: number;
    averageTrustScore: number;
    totalQueries: number;
    totalFailures: number;
  } {
    const indexers = Array.from(this.indexers.values());
    const healthy = indexers.filter(h => h.trustScore >= 0.3);
    const totalQueries = indexers.reduce((sum, h) => sum + h.successCount + h.failureCount, 0);
    const totalFailures = indexers.reduce((sum, h) => sum + h.failureCount, 0);
    const avgScore = indexers.length > 0
      ? indexers.reduce((sum, h) => sum + h.trustScore, 0) / indexers.length
      : 0;

    return {
      totalIndexers: indexers.length,
      healthyIndexers: healthy.length,
      averageTrustScore: avgScore,
      totalQueries,
      totalFailures,
    };
  }

  /**
   * Shuffle array (Fisher-Yates)
   */
  private shuffleArray<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  /**
   * Export state for persistence
   */
  exportState(): Map<string, IndexerHealth> {
    return new Map(this.indexers);
  }

  /**
   * Import state from persistence
   */
  importState(state: Map<string, IndexerHealth>): void {
    this.indexers = new Map(state);
  }

  /**
   * Remove an indexer
   */
  removeIndexer(url: string): void {
    this.indexers.delete(url);
  }

  /**
   * Clear all indexers
   */
  clear(): void {
    this.indexers.clear();
  }
}
