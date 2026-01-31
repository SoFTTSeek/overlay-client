/**
 * Shard Routing Module
 * PRD Section 5.3-5.4 - Sharding and Replication
 */

import { hashString } from '../publish/hasher.js';
import type { SHARD_COUNT, ShardId } from '../types.js';

/** Number of shards (must match SHARD_COUNT in types.ts) */
const TOTAL_SHARDS = 4096;

/**
 * Compute shard ID for a token
 * shardId = hash(token) & (S-1)
 */
export function getShardForToken(token: string, shardCount: number = TOTAL_SHARDS): ShardId {
  const hash = hashString(token.toLowerCase());
  // Use first 4 bytes of hash as a number
  const num = parseInt(hash.substring(0, 8), 16);
  return num & (shardCount - 1);
}

/**
 * Get discovery topic for a shard
 */
export function getShardTopic(shardId: ShardId): string {
  return `idx-shard-v1:${shardId}`;
}

/**
 * Group tokens by their shard
 */
export function groupTokensByShard(tokens: string[]): Map<ShardId, string[]> {
  const groups = new Map<ShardId, string[]>();

  for (const token of tokens) {
    const shardId = getShardForToken(token);
    const existing = groups.get(shardId) || [];
    existing.push(token);
    groups.set(shardId, existing);
  }

  return groups;
}

/**
 * Shard assignment for indexer nodes
 */
export interface ShardAssignment {
  indexerUrl: string;
  shardIds: ShardId[];
}

/**
 * Compute shard assignments for a set of indexers
 * Each shard is assigned to K indexers (replication factor)
 */
export function computeShardAssignments(
  indexerUrls: string[],
  replicationFactor: number = 5
): Map<ShardId, string[]> {
  const assignments = new Map<ShardId, string[]>();

  if (indexerUrls.length === 0) {
    return assignments;
  }

  const k = Math.min(replicationFactor, indexerUrls.length);

  for (let shardId = 0; shardId < TOTAL_SHARDS; shardId++) {
    // Consistent hashing: use shard ID to deterministically select K indexers
    const selected: string[] = [];
    for (let i = 0; i < k; i++) {
      const index = (shardId + i) % indexerUrls.length;
      selected.push(indexerUrls[index]);
    }
    assignments.set(shardId, selected);
  }

  return assignments;
}

/**
 * Get indexers responsible for a specific token
 */
export function getIndexersForToken(
  token: string,
  shardAssignments: Map<ShardId, string[]>
): string[] {
  const shardId = getShardForToken(token);
  return shardAssignments.get(shardId) || [];
}

/**
 * Get all unique shards needed for a set of tokens
 */
export function getShardsForTokens(tokens: string[]): Set<ShardId> {
  const shards = new Set<ShardId>();
  for (const token of tokens) {
    shards.add(getShardForToken(token));
  }
  return shards;
}

/**
 * Indexer selection with load balancing
 */
export class IndexerSelector {
  private shardAssignments: Map<ShardId, string[]>;
  private indexerLoad: Map<string, number> = new Map();
  private defaultCount: number;

  constructor(indexerUrls: string[], replicationFactor: number = 5) {
    this.shardAssignments = computeShardAssignments(indexerUrls, replicationFactor);
    this.defaultCount = replicationFactor;

    // Initialize load tracking
    for (const url of indexerUrls) {
      this.indexerLoad.set(url, 0);
    }
  }

  /**
   * Get indexers for a shard (convenience method)
   */
  getIndexersForShard(shardId: ShardId): string[] {
    return this.selectIndexers(shardId, this.defaultCount);
  }

  /**
   * Select an indexer for a shard (least loaded)
   */
  selectIndexer(shardId: ShardId): string | null {
    const candidates = this.shardAssignments.get(shardId);
    if (!candidates || candidates.length === 0) {
      return null;
    }

    // Select least loaded
    let minLoad = Infinity;
    let selected = candidates[0];

    for (const url of candidates) {
      const load = this.indexerLoad.get(url) || 0;
      if (load < minLoad) {
        minLoad = load;
        selected = url;
      }
    }

    return selected;
  }

  /**
   * Select multiple indexers for a shard (for redundant queries)
   */
  selectIndexers(shardId: ShardId, count: number): string[] {
    const candidates = this.shardAssignments.get(shardId);
    if (!candidates || candidates.length === 0) {
      return [];
    }

    // Sort by load and take top N
    const sorted = [...candidates].sort((a, b) => {
      const loadA = this.indexerLoad.get(a) || 0;
      const loadB = this.indexerLoad.get(b) || 0;
      return loadA - loadB;
    });

    return sorted.slice(0, count);
  }

  /**
   * Record that an indexer was used
   */
  recordUsage(indexerUrl: string): void {
    const current = this.indexerLoad.get(indexerUrl) || 0;
    this.indexerLoad.set(indexerUrl, current + 1);
  }

  /**
   * Reset load counters (call periodically)
   */
  resetLoad(): void {
    for (const url of this.indexerLoad.keys()) {
      this.indexerLoad.set(url, 0);
    }
  }

  /**
   * Get all indexers needed to query a set of tokens
   */
  getIndexersForQuery(tokens: string[]): Map<string, string[]> {
    const indexerToTokens = new Map<string, string[]>();

    for (const token of tokens) {
      const shardId = getShardForToken(token);
      const indexer = this.selectIndexer(shardId);

      if (indexer) {
        const existing = indexerToTokens.get(indexer) || [];
        existing.push(token);
        indexerToTokens.set(indexer, existing);
        this.recordUsage(indexer);
      }
    }

    return indexerToTokens;
  }
}
