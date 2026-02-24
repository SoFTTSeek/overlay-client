/**
 * Test: Shard routing mismatch between client and indexers
 *
 * Bug: The client's IndexerSelector uses synthetic round-robin shard assignment
 * (computeShardAssignments) which doesn't match the actual shard ranges on the
 * indexers (set via SHARD_START/SHARD_END env vars). This causes ~50% of search
 * tokens to be routed to the wrong indexer, which filters them out via
 * handlesShard() and returns 0 results.
 *
 * The bootstrap already returns { url, shardStart, shardEnd } per indexer, but
 * overlay-client.ts:96 strips it to just URLs.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ensureBlake3 } from '../publish/hasher.js';
import { getShardForToken, IndexerSelector, type IndexerInfo } from '../search/sharding.js';

// Simulate real deployment: 2 indexers with non-overlapping shard ranges
const INDEXER_1 = 'http://178.156.231.100:8080';  // shards 0-2047
const INDEXER_2 = 'http://178.156.237.33:8080';    // shards 2048-4095

const INDEXER_1_SHARDS = { start: 0, end: 2047 };
const INDEXER_2_SHARDS = { start: 2048, end: 4095 };

const INDEXER_INFOS: IndexerInfo[] = [
  { url: INDEXER_1, shardStart: 0, shardEnd: 2047 },
  { url: INDEXER_2, shardStart: 2048, shardEnd: 4095 },
];

const SEARCH_TERMS = [
  'samples', 'kick', 'cymbol', 'snare', 'piano',
  'guitar', 'bass', 'vocal', 'ambient', 'drums',
  'loop', 'synth', 'pad', 'strings', 'brass',
  'flute', 'harp', 'organ', 'choir', 'percussion',
];

/** Simulate indexer's handlesShard() check */
function indexerHandlesShard(indexerUrl: string, token: string): boolean {
  const shardId = getShardForToken(token);
  if (indexerUrl === INDEXER_1) {
    return shardId >= INDEXER_1_SHARDS.start && shardId <= INDEXER_1_SHARDS.end;
  }
  if (indexerUrl === INDEXER_2) {
    return shardId >= INDEXER_2_SHARDS.start && shardId <= INDEXER_2_SHARDS.end;
  }
  return false;
}

function findMisrouted(selector: IndexerSelector, tokens: string[]) {
  const misrouted: Array<{ token: string; sentTo: string; shardId: number; correctIndexer: string }> = [];

  for (const token of tokens) {
    const routing = selector.getIndexersForQuery([token]);
    for (const [indexerUrl, routedTokens] of routing) {
      for (const t of routedTokens) {
        if (!indexerHandlesShard(indexerUrl, t)) {
          const shardId = getShardForToken(t);
          const correctIndexer = shardId <= 2047 ? INDEXER_1 : INDEXER_2;
          misrouted.push({ token: t, sentTo: indexerUrl, shardId, correctIndexer });
        }
      }
    }
  }
  return misrouted;
}

describe('Shard routing: client vs indexer agreement', () => {
  beforeAll(async () => {
    await ensureBlake3();
  });

  describe('with real shard ranges (IndexerInfo[])', () => {
    it('should route every token to an indexer that actually handles its shard', () => {
      const selector = new IndexerSelector(INDEXER_INFOS);
      const misrouted = findMisrouted(selector, SEARCH_TERMS);
      expect(misrouted).toEqual([]);
    });

    it('should send "samples" to the indexer that owns shard 2208', () => {
      const selector = new IndexerSelector(INDEXER_INFOS);
      const token = 'samples';
      const shardId = getShardForToken(token);
      const expectedIndexer = shardId <= 2047 ? INDEXER_1 : INDEXER_2;

      const routing = selector.getIndexersForQuery([token]);
      const tokensForExpected = routing.get(expectedIndexer) || [];
      expect(tokensForExpected).toContain(token);
    });

    it('should not send tokens to indexers that cannot handle them', () => {
      const selector = new IndexerSelector(INDEXER_INFOS);
      // Multi-token query: each token should only go to its owner
      const routing = selector.getIndexersForQuery(SEARCH_TERMS);

      for (const [indexerUrl, tokens] of routing) {
        for (const token of tokens) {
          expect(indexerHandlesShard(indexerUrl, token)).toBe(true);
        }
      }
    });
  });

  describe('legacy URL-only mode (proves the bug)', () => {
    it('misroutes tokens with synthetic assignment', () => {
      const selector = new IndexerSelector([INDEXER_1, INDEXER_2]);
      const misrouted = findMisrouted(selector, SEARCH_TERMS);
      // This documents the bug: URL-only mode misroutes tokens
      expect(misrouted.length).toBeGreaterThan(0);
    });
  });
});
