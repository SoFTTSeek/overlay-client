/**
 * Tests for Reputation Module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { ReputationManager } from '../reputation/index.js';

describe('ReputationManager', () => {
  let tempDir: string;
  let manager: ReputationManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reputation-test-'));
    manager = new ReputationManager(join(tempDir, 'reputation.db'));
  });

  afterEach(async () => {
    manager.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('recordTransfer', () => {
    it('should record successful transfers', () => {
      const pubKey = '0'.repeat(64);
      const contentHash = '1'.repeat(64);

      manager.recordTransfer(pubKey, contentHash, 'success', 1000000, 5000);

      const rep = manager.getReputation(pubKey);
      expect(rep).not.toBeNull();
      expect(rep!.successCount).toBe(1);
      expect(rep!.failureCount).toBe(0);
      expect(rep!.totalBytesTransferred).toBe(1000000);
    });

    it('should record failed transfers', () => {
      const pubKey = '0'.repeat(64);
      const contentHash = '1'.repeat(64);

      manager.recordTransfer(pubKey, contentHash, 'timeout', 0, 0);

      const rep = manager.getReputation(pubKey);
      expect(rep!.successCount).toBe(0);
      expect(rep!.failureCount).toBe(1);
    });

    it('should update trust score based on outcomes', () => {
      const pubKey = '0'.repeat(64);
      const contentHash = '1'.repeat(64);

      // Start with a neutral score
      manager.recordTransfer(pubKey, contentHash, 'success', 1000, 100);
      const rep1 = manager.getReputation(pubKey)!;

      // Add more successes
      for (let i = 0; i < 5; i++) {
        manager.recordTransfer(pubKey, `${i}`.repeat(64), 'success', 1000, 100);
      }
      const rep2 = manager.getReputation(pubKey)!;

      expect(rep2.trustScore).toBeGreaterThan(rep1.trustScore);
    });
  });

  describe('getTrustScore', () => {
    it('should return 0.5 for unknown providers', () => {
      const score = manager.getTrustScore('unknown'.padEnd(64, '0'));
      expect(score).toBe(0.5);
    });

    it('should return calculated score for known providers', () => {
      const pubKey = '0'.repeat(64);
      manager.recordTransfer(pubKey, '1'.repeat(64), 'success', 1000, 100);

      const score = manager.getTrustScore(pubKey);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  describe('isTrusted', () => {
    it('should return true for providers above threshold', () => {
      const pubKey = '0'.repeat(64);

      // Add many successful transfers
      for (let i = 0; i < 10; i++) {
        manager.recordTransfer(pubKey, `${i}`.repeat(64), 'success', 10000, 100);
      }

      expect(manager.isTrusted(pubKey)).toBe(true);
    });

    it('should return true for unknown providers (neutral score)', () => {
      expect(manager.isTrusted('unknown'.padEnd(64, '0'))).toBe(true);
    });
  });

  describe('isBlocked', () => {
    it('should return false for unknown providers', () => {
      expect(manager.isBlocked('unknown'.padEnd(64, '0'))).toBe(false);
    });

    it('should block providers with many failures', () => {
      const pubKey = '0'.repeat(64);

      // Add many failures
      for (let i = 0; i < 10; i++) {
        manager.recordTransfer(pubKey, `${i}`.repeat(64), 'timeout', 0, 0);
      }

      expect(manager.isBlocked(pubKey)).toBe(true);
    });
  });

  describe('sortByReputation', () => {
    it('should sort providers by trust score', () => {
      const goodProvider = 'good'.padEnd(64, '0');
      const badProvider = 'bad0'.padEnd(64, '0');

      // Good provider with successes
      for (let i = 0; i < 10; i++) {
        manager.recordTransfer(goodProvider, `g${i}`.repeat(32), 'success', 1000, 100);
      }

      // Bad provider with failures
      for (let i = 0; i < 10; i++) {
        manager.recordTransfer(badProvider, `b${i}`.repeat(32), 'timeout', 0, 0);
      }

      const sorted = manager.sortByReputation([badProvider, goodProvider]);
      expect(sorted[0]).toBe(goodProvider);
      expect(sorted[1]).toBe(badProvider);
    });
  });

  describe('filterBlocked', () => {
    it('should filter out blocked providers', () => {
      const goodProvider = 'good'.padEnd(64, '0');
      const badProvider = 'bad0'.padEnd(64, '0');

      // Bad provider with many failures
      for (let i = 0; i < 10; i++) {
        manager.recordTransfer(badProvider, `${i}`.repeat(64), 'timeout', 0, 0);
      }

      const filtered = manager.filterBlocked([goodProvider, badProvider]);
      expect(filtered).toContain(goodProvider);
      expect(filtered).not.toContain(badProvider);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      const pub1 = 'pub1'.padEnd(64, '0');
      const pub2 = 'pub2'.padEnd(64, '0');

      manager.recordTransfer(pub1, 'h1'.padEnd(64, '0'), 'success', 1000, 100);
      manager.recordTransfer(pub2, 'h2'.padEnd(64, '0'), 'timeout', 0, 0);

      const stats = manager.getStats();
      expect(stats.totalProviders).toBe(2);
      expect(stats.totalTransfers).toBe(2);
    });
  });
});
