/**
 * Tests for PoW Module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PowVerifier, PowSolver, estimateSolveTime } from '../security/pow.js';

describe('PoW', () => {
  describe('PowVerifier', () => {
    let verifier: PowVerifier;

    beforeEach(() => {
      verifier = new PowVerifier({
        normalDifficulty: 8, // Low difficulty for testing
        elevatedDifficulty: 10,
        emergencyDifficulty: 12,
        requestsPerMinuteThreshold: 100,
        circuitBreakerThreshold: 500,
      });
      verifier.start();
    });

    afterEach(() => {
      verifier.stop();
    });

    it('should generate valid challenges', () => {
      const challenge = verifier.generateChallenge();

      expect(challenge.id).toBeDefined();
      expect(challenge.prefix).toBeDefined();
      expect(challenge.difficulty).toBeGreaterThan(0);
      expect(challenge.expiresAt).toBeGreaterThan(Date.now());
    });

    it('should not require PoW initially', () => {
      expect(verifier.isPowRequired('192.168.1.1')).toBe(false);
    });

    it('should require PoW after many requests', () => {
      const ip = '192.168.1.100';

      // Simulate many requests
      for (let i = 0; i < 20; i++) {
        verifier.recordRequest(ip);
      }

      expect(verifier.isPowRequired(ip)).toBe(true);
    });

    it('should verify valid solutions', async () => {
      const challenge = verifier.generateChallenge('test-ip');
      const solver = new PowSolver();

      const solution = await solver.solve(challenge);
      expect(solution).not.toBeNull();

      const isValid = verifier.verifySolution(solution!);
      expect(isValid).toBe(true);
    });

    it('should reject invalid solutions', () => {
      verifier.generateChallenge('test-ip');

      const fakeSolution = {
        challengeId: 'fake-id',
        nonce: 'fake-nonce',
        hash: 'fake-hash',
      };

      expect(verifier.verifySolution(fakeSolution)).toBe(false);
    });

    it('should reject reused solutions', async () => {
      const challenge = verifier.generateChallenge('test-ip');
      const solver = new PowSolver();

      const solution = await solver.solve(challenge);
      expect(solution).not.toBeNull();

      // First verification should succeed
      expect(verifier.verifySolution(solution!)).toBe(true);

      // Second verification should fail (challenge consumed)
      expect(verifier.verifySolution(solution!)).toBe(false);
    });

    it('should provide stats', () => {
      verifier.generateChallenge('test-ip');
      verifier.recordRequest('192.168.1.1');

      const stats = verifier.getStats();
      expect(stats.pendingChallenges).toBe(1);
      expect(stats.totalRecentRequests).toBe(1);
      expect(stats.circuitState).toBe('closed');
    });
  });

  describe('PowSolver', () => {
    it('should solve challenges', async () => {
      const challenge = {
        id: 'test-challenge',
        prefix: 'test-prefix-12345',
        difficulty: 8, // Low difficulty for testing
        expiresAt: Date.now() + 60000,
      };

      const solver = new PowSolver();
      const solution = await solver.solve(challenge);

      expect(solution).not.toBeNull();
      expect(solution!.challengeId).toBe(challenge.id);
      expect(solution!.nonce).toBeDefined();
      expect(solution!.hash).toBeDefined();
    });

    it('should emit progress events', async () => {
      const challenge = {
        id: 'test',
        prefix: 'prefix',
        difficulty: 12, // Higher difficulty
        expiresAt: Date.now() + 60000,
      };

      const solver = new PowSolver();
      let progressEmitted = false;

      solver.on('progress', () => {
        progressEmitted = true;
      });

      await solver.solve(challenge);
      expect(progressEmitted).toBe(true);
    });

    it('should abort when requested', async () => {
      const challenge = {
        id: 'test',
        prefix: 'prefix',
        difficulty: 30, // Very high difficulty
        expiresAt: Date.now() + 60000,
      };

      const solver = new PowSolver();

      // Abort after a short delay
      setTimeout(() => solver.abort(), 100);

      const solution = await solver.solve(challenge);
      expect(solution).toBeNull();
    });
  });

  describe('estimateSolveTime', () => {
    it('should estimate solve time', () => {
      const time8 = estimateSolveTime(8, 100000);
      const time16 = estimateSolveTime(16, 100000);

      expect(time16).toBeGreaterThan(time8);
    });
  });
});
