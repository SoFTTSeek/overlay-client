/**
 * Tests for zero-byte file filtering during publish and browse
 *
 * Bug context: Search was showing 0-byte/trashed files because:
 * 1. Publisher wasn't filtering 0-byte files at scan time
 * 2. Browse manager wasn't filtering 0-byte entries in responses
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { IdentityManager } from '../identity/index.js';
import { LocalDatabase } from '../localdb/index.js';
import { Publisher } from '../publish/publisher.js';
import { BrowseManager } from '../browse/manager.js';

function seedFixtureFiles(baseDir: string): void {
  writeFileSync(join(baseDir, 'Valid Song.mp3'), 'v'.repeat(2048));
  writeFileSync(join(baseDir, 'Second Valid.aiff'), 'a'.repeat(4096));
  writeFileSync(join(baseDir, 'Tiny Song.mp3'), 'tiny');
  writeFileSync(join(baseDir, 'Zero Song.mp3'), '');
  writeFileSync(join(baseDir, '.DS_Store'), 'dotfile');
}

describe('Zero-byte file filtering', () => {
  let testDir: string;
  let dbPath: string;
  let identityDir: string;
  let fixtureDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `overlay-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    dbPath = join(testDir, 'localfiles.db');
    identityDir = join(testDir, 'identity');
    fixtureDir = join(testDir, 'fixtures');
    mkdirSync(identityDir, { recursive: true });
    mkdirSync(fixtureDir, { recursive: true });
    seedFixtureFiles(fixtureDir);
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('Publisher.scanDirectory', () => {
    it('should find valid audio files and skip dotfiles/zero-byte/tiny audio files', async () => {
      const identity = new IdentityManager(identityDir);
      await identity.initialize();

      const localDb = new LocalDatabase(dbPath);
      const publisher = new Publisher(identity, localDb);

      const scanResults = await publisher.scanDirectory(fixtureDir);

      // Should find some files
      expect(scanResults.length).toBeGreaterThan(0);

      // Should NOT include any dotfiles
      const dotfiles = scanResults.filter(r => r.filename.startsWith('.'));
      expect(dotfiles).toEqual([]);

      // Should NOT include any 0-byte files
      const zeroByteFiles = scanResults.filter(r => r.size === 0);
      expect(zeroByteFiles).toEqual([]);

      // All audio files should be > 1KB (production filter)
      const audioExtensions = ['mp3', 'flac', 'wav', 'aac', 'ogg', 'opus', 'wma', 'm4a', 'aiff'];
      const tinyAudioFiles = scanResults.filter(r =>
        audioExtensions.includes(r.ext) && r.size < 1024
      );
      expect(tinyAudioFiles).toEqual([]);

      // Verify we found valid audio files
      const audioFiles = scanResults.filter(r =>
        audioExtensions.includes(r.ext)
      );
      expect(audioFiles.length).toBeGreaterThan(0);
    });

    it('should index files and create valid browse response', async () => {
      const identity = new IdentityManager(identityDir);
      await identity.initialize();

      const localDb = new LocalDatabase(dbPath);
      const publisher = new Publisher(identity, localDb);
      const browseManager = new BrowseManager(identity, localDb);

      // Scan and index fixture files
      const scanResults = await publisher.scanDirectory(fixtureDir);
      expect(scanResults.length).toBeGreaterThan(0);

      await publisher.indexFiles(scanResults);

      // Create browse response
      const response = browseManager.createBrowseResponse();

      // Should have files in the response
      expect(response.files.length).toBeGreaterThan(0);

      // No 0-byte files in browse response
      const zeroByteInBrowse = response.files.filter(f => f.size === 0);
      expect(zeroByteInBrowse).toEqual([]);

      // All files should have valid content hashes
      const invalidHashes = response.files.filter(f => !f.contentHash || f.contentHash.length !== 64);
      expect(invalidHashes).toEqual([]);
    });
  });

  describe('BrowseManager filters stale 0-byte entries', () => {
    it('should filter out manually inserted 0-byte entries from browse response', async () => {
      const identity = new IdentityManager(identityDir);
      await identity.initialize();

      const localDb = new LocalDatabase(dbPath);
      const publisher = new Publisher(identity, localDb);
      const browseManager = new BrowseManager(identity, localDb);

      // Index fixture files first
      const scanResults = await publisher.scanDirectory(fixtureDir);
      const subset = scanResults.slice(0, 5); // Just index a few for speed
      await publisher.indexFiles(subset);

      const fileCountBefore = localDb.getAllFiles().length;

      // Simulate stale 0-byte entry (file was deleted after being published)
      localDb.upsertFile({
        path: '/fake/path/deleted-track.mp3',
        contentHash: 'deadbeef'.repeat(8) as any, // 64 char hash
        size: 0,
        mtime: Date.now(),
        ext: 'mp3' as any,
        tokens: ['deleted', 'track'],
      });

      // DB should have one more entry
      expect(localDb.getAllFiles().length).toBe(fileCountBefore + 1);

      // But browse response should filter it out
      const response = browseManager.createBrowseResponse();
      const zeroByteInBrowse = response.files.filter(f => f.size === 0);
      expect(zeroByteInBrowse).toEqual([]);

      // Should still have the real files
      expect(response.files.length).toBe(fileCountBefore);
    });
  });
});
