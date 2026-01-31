/**
 * Tests for Sharding Module
 */

import { describe, it, expect } from 'vitest';
import {
  getShardForToken,
  groupTokensByShard,
  IndexerSelector,
} from '../search/sharding.js';

describe('Sharding', () => {
  describe('getShardForToken', () => {
    it('should return consistent shard for same token', () => {
      const shard1 = getShardForToken('test');
      const shard2 = getShardForToken('test');
      expect(shard1).toBe(shard2);
    });

    it('should return shard within range', () => {
      const shard = getShardForToken('test', 4096);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(4096);
    });

    it('should distribute tokens across shards', () => {
      const tokens = ['apple', 'banana', 'cherry', 'date', 'elderberry'];
      const shards = new Set(tokens.map(t => getShardForToken(t)));
      // Expect at least some distribution (not all same shard)
      expect(shards.size).toBeGreaterThan(1);
    });
  });

  describe('groupTokensByShard', () => {
    it('should group tokens by their shard', () => {
      const tokens = ['apple', 'banana', 'cherry'];
      const groups = groupTokensByShard(tokens);

      // All tokens should be in some group
      let totalTokens = 0;
      for (const [, groupTokens] of groups) {
        totalTokens += groupTokens.length;
      }
      expect(totalTokens).toBe(tokens.length);
    });

    it('should handle empty token list', () => {
      const groups = groupTokensByShard([]);
      expect(groups.size).toBe(0);
    });
  });

  describe('IndexerSelector', () => {
    const indexerUrls = [
      'http://indexer1.example.com',
      'http://indexer2.example.com',
      'http://indexer3.example.com',
    ];

    it('should select indexers for a shard', () => {
      const selector = new IndexerSelector(indexerUrls, 2);
      const selected = selector.getIndexersForShard(100);

      expect(selected.length).toBeLessThanOrEqual(2);
      expect(selected.length).toBeGreaterThan(0);
      selected.forEach(url => {
        expect(indexerUrls).toContain(url);
      });
    });

    it('should return consistent indexers for same shard', () => {
      const selector = new IndexerSelector(indexerUrls, 2);
      const selected1 = selector.getIndexersForShard(500);
      const selected2 = selector.getIndexersForShard(500);

      expect(selected1).toEqual(selected2);
    });

    it('should get indexers for query tokens', () => {
      const selector = new IndexerSelector(indexerUrls, 2);
      const tokens = ['beatles', 'abbey', 'road'];
      const result = selector.getIndexersForQuery(tokens);

      // Should return map of indexer -> tokens
      expect(result.size).toBeGreaterThan(0);

      // All tokens should be covered
      const allTokens = new Set<string>();
      for (const [, toks] of result) {
        toks.forEach(t => allTokens.add(t));
      }
      tokens.forEach(t => {
        expect(allTokens.has(t)).toBe(true);
      });
    });

    it('should handle single indexer', () => {
      const selector = new IndexerSelector(['http://single.example.com'], 5);
      const selected = selector.getIndexersForShard(100);

      expect(selected.length).toBe(1);
      expect(selected[0]).toBe('http://single.example.com');
    });
  });
});
