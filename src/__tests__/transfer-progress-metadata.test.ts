/**
 * Tests for transfer progress event metadata
 *
 * Bug context: Progress events emitted by SoulseekBridge.emitTransferProgress()
 * were missing critical metadata fields:
 * - filename (shows hash instead of real name in UI)
 * - localPath (prevents "reveal in folder" from working)
 * - remotePath (for display purposes)
 * - username (shows "unknown" instead of provider info)
 *
 * All this data exists in TransferState but wasn't being included in the emitted event.
 *
 * Symptoms:
 * - Downloads show hash as filename (e.g., "efce13062058a5512a7ab56651...")
 * - Username shows "overlay:unknown"
 * - Reveal in Finder button doesn't work (empty localPath)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SoulseekBridge, UnifiedSearchResult } from '../bridge/soulseek.js';
import { DirectTransport } from '../transport/direct.js';
import { IdentityManager } from '../identity/index.js';
import { LocalDatabase } from '../localdb/index.js';

const TEST_TIMEOUT = 100000;

describe('Transfer progress metadata', () => {
  let testDir: string;
  let identityDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `overlay-progress-meta-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  describe('SoulseekBridge progress events should include metadata', () => {
    it('should include filename in progress events', async () => {
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

      const realFilename = 'SofTT 2018.04.14 Fort Esther (Toledo, OH).mp3';
      const contentHash = 'efce13062058a5512a7ab56651a3d4583ce44fb73ad069c72792e8f6c3332a4e';

      const result: UnifiedSearchResult = {
        id: 'search-result-uuid',
        contentHash,
        filename: realFilename,
        size: 45719680,
        source: 'overlay',
        overlayProviders: [{ pubKey: myPubKey }],
        folderPath: '2018.04.14 Fort Esther (Toledo, OH)/3 SofTT',
        score: 100,
        connectionQuality: 'relay',
      };

      const destPath = join(testDir, 'downloads', realFilename);
      mkdirSync(join(testDir, 'downloads'), { recursive: true });

      // Collect ALL progress events
      const progressEvents: any[] = [];
      bridge.on('transfer:progress', (p) => {
        progressEvents.push(p);
      });

      // Download will fail (no real provider), but we verify metadata in progress events
      await bridge.download(result, destPath);

      // Verify we got progress events
      expect(progressEvents.length).toBeGreaterThan(0);

      // CRITICAL: Every progress event should include filename
      // This is the bug - currently filename is NOT included
      for (const event of progressEvents) {
        expect(event.filename).toBeDefined();
        expect(event.filename).toBe(realFilename);
        // Should NOT be the hash
        expect(event.filename).not.toBe(contentHash);
      }

      await bridge.shutdown();
    }, TEST_TIMEOUT);

    it('should include localPath in progress events for reveal-in-folder', async () => {
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

      const result: UnifiedSearchResult = {
        id: 'search-result-uuid',
        contentHash: 'abc123def456'.repeat(5) + 'abcd',
        filename: 'test-file.mp3',
        size: 1024000,
        source: 'overlay',
        overlayProviders: [{ pubKey: myPubKey }],
        score: 100,
        connectionQuality: 'relay',
      };

      const destPath = join(testDir, 'downloads', 'test-file.mp3');
      mkdirSync(join(testDir, 'downloads'), { recursive: true });

      const progressEvents: any[] = [];
      bridge.on('transfer:progress', (p) => {
        progressEvents.push(p);
      });

      await bridge.download(result, destPath);

      expect(progressEvents.length).toBeGreaterThan(0);

      // CRITICAL: Every progress event should include localPath
      // This is needed for "Reveal in Finder" to work
      for (const event of progressEvents) {
        expect(event.localPath).toBeDefined();
        expect(event.localPath).toBe(destPath);
      }

      await bridge.shutdown();
    }, TEST_TIMEOUT);

    it('should include username in progress events for overlay providers', async () => {
      vi.spyOn(DirectTransport.prototype, 'requestFile').mockRejectedValue(
        new Error('timeout')
      );

      const identity = new IdentityManager(identityDir);
      await identity.initialize();
      const localDb = new LocalDatabase(dbPath);
      const myPubKey = identity.getPublicKey();
      const providerPubKey = 'a6858fe6077a3ab4' + '0'.repeat(48); // Fake provider key

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

      const result: UnifiedSearchResult = {
        id: 'search-result-uuid',
        contentHash: 'contenthash123'.repeat(4) + '1234567890123456',
        filename: 'test-file.mp3',
        size: 1024000,
        source: 'overlay',
        overlayProviders: [{ pubKey: providerPubKey }],
        score: 100,
        connectionQuality: 'relay',
      };

      const destPath = join(testDir, 'downloads', 'test-file.mp3');
      mkdirSync(join(testDir, 'downloads'), { recursive: true });

      const progressEvents: any[] = [];
      bridge.on('transfer:progress', (p) => {
        progressEvents.push(p);
      });

      await bridge.download(result, destPath);

      expect(progressEvents.length).toBeGreaterThan(0);

      // CRITICAL: Progress events should include username
      // For overlay providers, it should be "overlay:<pubKey>"
      for (const event of progressEvents) {
        expect(event.username).toBeDefined();
        expect(event.username).toContain('overlay:');
        expect(event.username).not.toBe('overlay:unknown');
      }

      await bridge.shutdown();
    }, TEST_TIMEOUT);

    it('should include remotePath in progress events', async () => {
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

      const folderPath = '2018.04.14 Fort Esther (Toledo, OH)/3 SofTT';
      const filename = 'test-file.mp3';

      const result: UnifiedSearchResult = {
        id: 'search-result-uuid',
        contentHash: 'contenthash123'.repeat(4) + '1234567890123456',
        filename,
        size: 1024000,
        source: 'overlay',
        overlayProviders: [{ pubKey: myPubKey }],
        folderPath,
        score: 100,
        connectionQuality: 'relay',
      };

      const destPath = join(testDir, 'downloads', filename);
      mkdirSync(join(testDir, 'downloads'), { recursive: true });

      const progressEvents: any[] = [];
      bridge.on('transfer:progress', (p) => {
        progressEvents.push(p);
      });

      await bridge.download(result, destPath);

      expect(progressEvents.length).toBeGreaterThan(0);

      // CRITICAL: Progress events should include remotePath
      for (const event of progressEvents) {
        expect(event.remotePath).toBeDefined();
        // Should be folderPath + filename or just filename
        expect(event.remotePath).toContain(filename);
      }

      await bridge.shutdown();
    }, TEST_TIMEOUT);

    it('should include soulseek username for soulseek-source results', async () => {
      const identity = new IdentityManager(identityDir);
      await identity.initialize();
      const localDb = new LocalDatabase(dbPath);
      const myPubKey = identity.getPublicKey();

      const bridge = new SoulseekBridge({
        relayUrls: [],
        soulseekFallbackEnabled: true,
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
          download: async () => false, // Will fail but we check progress events
        },
      });

      const soulseekUsername = 'mortymachine';

      const result: UnifiedSearchResult = {
        id: 'ss:mortymachine:test.mp3',
        filename: 'test-file.mp3',
        size: 1024000,
        source: 'soulseek',
        soulseekUsername,
        soulseekPath: '/music/test-file.mp3',
        score: 50,
        connectionQuality: 'soulseek',
      };

      const destPath = join(testDir, 'downloads', 'test-file.mp3');
      mkdirSync(join(testDir, 'downloads'), { recursive: true });

      const progressEvents: any[] = [];
      bridge.on('transfer:progress', (p) => {
        progressEvents.push(p);
      });

      await bridge.download(result, destPath);

      expect(progressEvents.length).toBeGreaterThan(0);

      // For soulseek results, username should be "soulseek:<username>"
      for (const event of progressEvents) {
        expect(event.username).toBeDefined();
        expect(event.username).toContain('soulseek:');
        expect(event.username).toBe(`soulseek:${soulseekUsername}`);
      }

      await bridge.shutdown();
    }, TEST_TIMEOUT);
  });
});
