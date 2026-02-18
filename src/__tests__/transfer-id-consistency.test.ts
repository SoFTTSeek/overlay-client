/**
 * Tests for transfer ID consistency in the download flow
 *
 * Bug context: Transfer IDs were inconsistent between:
 * - How transfers are stored (contentHash ?? id)
 * - How transfers are looked up (progress.contentHash)
 * - How transfers are deleted (result.id - WRONG!)
 *
 * This caused "ghost" downloads and memory leaks.
 *
 * Production timing notes:
 * - Direct transport has 30s timeout per connection attempt
 * - maxRetries defaults to 3
 * - Worst case: 3 attempts × 30s = 90s per transfer method
 * - Tests need sufficient timeout to complete full retry cycle
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SoulseekBridge, UnifiedSearchResult } from '../bridge/soulseek.js';
import { DirectTransport } from '../transport/direct.js';
import { IdentityManager } from '../identity/index.js';
import { LocalDatabase } from '../localdb/index.js';

// Production-realistic timeout: 30s timeout × 3 retries + buffer
const REALISTIC_TEST_TIMEOUT = 100000; // 100 seconds

describe('Transfer ID consistency', () => {
  let testDir: string;
  let identityDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `overlay-transfer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    identityDir = join(testDir, 'identity');
    mkdirSync(identityDir, { recursive: true });
    dbPath = join(testDir, 'db.sqlite');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('SoulseekBridge transfer ID handling', () => {
    it('should use contentHash as transfer ID and complete download attempt', async () => {
      vi.spyOn(DirectTransport.prototype, 'requestFile').mockRejectedValue(
        new Error('timeout')
      );

      const identity = new IdentityManager(identityDir);
      await identity.initialize();
      const localDb = new LocalDatabase(dbPath);
      const myPubKey = identity.getPublicKey();

      const bridge = new SoulseekBridge({
        relayUrls: [],
        soulseekFallbackEnabled: false,
        maxRetries: 1, // Single retry for faster test
        directTimeoutMs: 200,
        relayTimeoutMs: 200,
      });

      await bridge.initialize({
        myPubKey,
        indexerUrls: [],
        dbPath: join(testDir, 'reputation.db'),
        identity,
        localDb,
        soulseekCallbacks: {
          search: async () => [],
          download: async () => false,
        },
      });

      // Create a result where id !== contentHash (the bug scenario)
      const result: UnifiedSearchResult = {
        id: 'search-result-uuid-12345', // Different from contentHash!
        contentHash: 'abc123def456'.repeat(5) + 'abcd', // 64 char hash
        filename: 'test.mp3',
        size: 1024,
        source: 'overlay',
        overlayProviders: [{ pubKey: myPubKey }],
        score: 0,
        connectionQuality: 'unknown',
      };

      const destPath = join(testDir, 'test.mp3');

      // Collect progress events
      const progressEvents: any[] = [];
      bridge.on('transfer:progress', (p) => {
        progressEvents.push({ id: p.id, status: p.status });
      });

      // Download will fail (no real provider), but we verify ID consistency
      const success = await bridge.download(result, destPath);

      // Download should fail (no real provider)
      expect(success).toBe(false);

      // All progress events should use contentHash as the ID
      expect(progressEvents.length).toBeGreaterThan(0);
      for (const event of progressEvents) {
        expect(event.id).toBe(result.contentHash);
        expect(event.id).not.toBe('search-result-uuid-12345');
      }

      // Transfer should be cleaned up properly
      const stateAfter = bridge.getTransferState(result.contentHash!);
      expect(stateAfter).toBeNull();

      await bridge.shutdown();
    }, REALISTIC_TEST_TIMEOUT);

    it('should cleanup transfers using the correct ID after failed download', async () => {
      vi.spyOn(DirectTransport.prototype, 'requestFile').mockRejectedValue(
        new Error('timeout')
      );

      const identity = new IdentityManager(identityDir);
      await identity.initialize();
      const localDb = new LocalDatabase(dbPath);
      const myPubKey = identity.getPublicKey();

      const bridge = new SoulseekBridge({
        relayUrls: [],
        soulseekFallbackEnabled: false,
        maxRetries: 1,
        directTimeoutMs: 200,
        relayTimeoutMs: 200,
      });

      await bridge.initialize({
        myPubKey,
        indexerUrls: [],
        dbPath: join(testDir, 'reputation.db'),
        identity,
        localDb,
        soulseekCallbacks: {
          search: async () => [],
          download: async () => false,
        },
      });

      const contentHash = 'contenthash123'.repeat(4) + '1234567890123456'; // 64 chars
      const result: UnifiedSearchResult = {
        id: 'uuid-that-differs-from-hash',
        contentHash,
        filename: 'test.mp3',
        size: 1024,
        source: 'overlay',
        overlayProviders: [{ pubKey: myPubKey }],
        score: 0,
        connectionQuality: 'unknown',
      };

      const destPath = join(testDir, 'test.mp3');

      await bridge.download(result, destPath);

      // The transfer should be cleaned up using the correct ID (contentHash)
      // BUG: if cleanup uses result.id instead of transferId, state remains
      const stateByContentHash = bridge.getTransferState(contentHash);
      const stateByOriginalId = bridge.getTransferState(result.id);

      // Both should be null if cleanup worked correctly
      expect(stateByContentHash).toBeNull();
      expect(stateByOriginalId).toBeNull();

      await bridge.shutdown();
    }, REALISTIC_TEST_TIMEOUT);
  });
});
