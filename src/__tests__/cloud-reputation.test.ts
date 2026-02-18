/**
 * Tests for Cloud Reputation (blended scoring, global score cache)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { ReputationManager } from '../reputation/index.js';
import { IdentityManager, MemoryIdentityStorage } from '../identity/index.js';
import type { GlobalReputationScore } from '../types.js';

describe('ReputationManager - Cloud Reputation', () => {
  let tempDir: string;
  let manager: ReputationManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cloud-rep-test-'));
    manager = new ReputationManager(join(tempDir, 'reputation.db'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    manager.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('setAuthServiceUrl', () => {
    it('should affect subsequent auth-service requests', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          pubKey: 'a'.repeat(64),
          globalTrustScore: 0.8,
          totalReports: 5,
          successfulReports: 4,
          totalBytes: 10000,
          reporterCount: 2,
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      manager.setAuthServiceUrl('http://localhost:8081');
      await manager.fetchGlobalScore('a'.repeat(64));

      expect(fetchMock).toHaveBeenCalledWith(
        `http://localhost:8081/v1/reputation/${'a'.repeat(64)}`
      );
    });
  });

  describe('getBlendedTrustScore', () => {
    it('should return local score when no global score', () => {
      const pubKey = 'a'.repeat(64);
      const score = manager.getBlendedTrustScore(pubKey);
      expect(score).toBe(0.5); // Default neutral for unknown
    });

    it('should return local score when global score is null', () => {
      const pubKey = 'a'.repeat(64);
      const score = manager.getBlendedTrustScore(pubKey, null);
      expect(score).toBe(0.5);
    });

    it('should return local score when global has zero reports', () => {
      const pubKey = 'a'.repeat(64);
      const globalScore: GlobalReputationScore = {
        pubKey,
        globalTrustScore: 0.9,
        totalReports: 0,
        successfulReports: 0,
        totalBytes: 0,
        reporterCount: 0,
      };

      const score = manager.getBlendedTrustScore(pubKey, globalScore);
      expect(score).toBe(0.5); // No global data, use local only
    });

    it('should blend 70% local + 30% global when global has reports', () => {
      const pubKey = 'a'.repeat(64);

      // Record some local successes to move local score above 0.5
      for (let i = 0; i < 10; i++) {
        manager.recordTransfer(pubKey, `h${i}`.padEnd(64, '0'), 'success', 10000, 100);
      }

      const localScore = manager.getTrustScore(pubKey);
      expect(localScore).toBeGreaterThan(0.5);

      const globalScore: GlobalReputationScore = {
        pubKey,
        globalTrustScore: 0.9,
        totalReports: 10,
        successfulReports: 9,
        totalBytes: 100000,
        reporterCount: 5,
      };

      const blendedScore = manager.getBlendedTrustScore(pubKey, globalScore);
      const expected = 0.7 * localScore + 0.3 * 0.9;
      expect(blendedScore).toBeCloseTo(expected, 5);
    });

    it('should blend correctly for low global score', () => {
      const pubKey = 'a'.repeat(64);

      // Unknown local = 0.5
      const globalScore: GlobalReputationScore = {
        pubKey,
        globalTrustScore: 0.1,
        totalReports: 20,
        successfulReports: 2,
        totalBytes: 50000,
        reporterCount: 10,
      };

      const blendedScore = manager.getBlendedTrustScore(pubKey, globalScore);
      const expected = 0.7 * 0.5 + 0.3 * 0.1;
      expect(blendedScore).toBeCloseTo(expected, 5);
    });
  });

  describe('fetchGlobalScore', () => {
    it('should return null when no auth service URL', async () => {
      const score = await manager.fetchGlobalScore('a'.repeat(64));
      expect(score).toBeNull();
    });
  });

  describe('submitReport', () => {
    it('should no-op when no auth service URL is configured', async () => {
      const identity = new IdentityManager(new MemoryIdentityStorage());
      await identity.initialize();

      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      manager.submitReport(identity, 'b'.repeat(64), 'success', 1000, 500);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should post signed reports when auth service URL is configured', async () => {
      const identity = new IdentityManager(new MemoryIdentityStorage());
      await identity.initialize();

      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      manager.setAuthServiceUrl('http://localhost:8081');

      manager.submitReport(identity, 'b'.repeat(64), 'success', 50000, 1000);

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:8081/v1/reputation/report');
      expect(init.method).toBe('POST');

      const body = JSON.parse(init.body as string) as {
        reporterPubKey: string;
        subjectPubKey: string;
        outcome: string;
        bytes: number;
        durationMs: number;
        ts: number;
        signature: string;
      };

      expect(body.reporterPubKey).toBe(identity.getPublicKey());
      expect(body.subjectPubKey).toBe('b'.repeat(64));
      expect(body.outcome).toBe('success');
      expect(body.bytes).toBe(50000);
      expect(body.durationMs).toBe(1000);
      expect(typeof body.ts).toBe('number');
      expect(body.signature).toHaveLength(128);
    });
  });
});
