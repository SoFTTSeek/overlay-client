/**
 * Tests for stale indexer entries bug
 *
 * Bug context: After adding 0-byte and <1KB audio filtering to publisher.ts,
 * search still shows stale entries (93B and 0B mp3 files) that were published
 * before the filter fix.
 *
 * Root cause: pruneMissingFiles() only knows about files in the local DB.
 * If stale entries exist in the indexer but NOT in the local DB, there's
 * no way to generate tombstones for them.
 *
 * This test reproduces the scenario:
 * 1. Simulate files being published to indexer (tracked in local DB)
 * 2. Clear the local DB (simulating app reset or DB migration)
 * 3. Run scan + prune flow
 * 4. Verify NO tombstone is generated (proving the bug)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { IdentityManager } from '../identity/index.js';
import { LocalDatabase } from '../localdb/index.js';
import { Publisher } from '../publish/publisher.js';

describe('Stale indexer entries bug', () => {
  let testDir: string;
  let dbPath: string;
  let identityDir: string;
  let dataDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `overlay-stale-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    dbPath = join(testDir, 'localfiles.db');
    identityDir = join(testDir, 'identity');
    dataDir = join(testDir, 'data');
    mkdirSync(identityDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('BUG REPRODUCTION: no tombstone generated for entries not in local DB', async () => {
    const identity = new IdentityManager(identityDir);
    await identity.initialize();

    // === PHASE 1: Simulate old version publishing files (including tiny ones) ===
    // Create files that WOULD have been published before the filter fix
    const validFile = join(dataDir, 'Valid Song.mp3');
    const tinyFile = join(dataDir, 'Tiny Song.mp3'); // 93 bytes - should be filtered
    const zeroFile = join(dataDir, 'Zero Song.mp3'); // 0 bytes - should be filtered

    writeFileSync(validFile, 'valid-audio-content-' + 'x'.repeat(2048)); // >1KB
    writeFileSync(tinyFile, 'tiny'); // 4 bytes (simulating 93B file)
    writeFileSync(zeroFile, ''); // 0 bytes

    // First, let's manually add entries to local DB as if they were published
    // by an old version that didn't filter
    const localDb1 = new LocalDatabase(dbPath);

    // Manually insert entries that an old version would have created
    // (bypassing the filter by inserting directly into DB)
    localDb1.upsertFile({
      path: validFile,
      contentHash: 'validhash'.repeat(7) + '1234567' as any, // 64 chars
      size: 2068,
      mtime: Date.now(),
      ext: 'mp3' as any,
      tokens: ['valid', 'song'],
    });
    localDb1.upsertFile({
      path: tinyFile,
      contentHash: 'tinyhash'.repeat(8) as any, // 64 chars
      size: 93,
      mtime: Date.now(),
      ext: 'mp3' as any,
      tokens: ['tiny', 'song'],
    });
    localDb1.upsertFile({
      path: zeroFile,
      contentHash: 'zerohash'.repeat(8) as any, // 64 chars
      size: 0,
      mtime: Date.now(),
      ext: 'mp3' as any,
      tokens: ['zero', 'song'],
    });

    // Verify all 3 are in the DB (simulating successful old publish)
    expect(localDb1.getAllFiles().length).toBe(3);

    // === PHASE 2: Simulate DB being cleared (app reset, migration, etc.) ===
    // Close and delete the DB, create a fresh one
    // This simulates what happens when a user's local DB gets cleared
    // but the indexer still has the old entries
    rmSync(dbPath, { force: true });

    // === PHASE 3: New version with filters runs scan + prune ===
    const localDb2 = new LocalDatabase(dbPath);
    const publisher = new Publisher(identity, localDb2);

    // Scan the directory (filters will skip tiny and zero files)
    const scanResults = await publisher.scanDirectory(dataDir);

    // Should only find the valid file (tiny and zero are filtered)
    expect(scanResults.length).toBe(1);
    expect(scanResults[0].filename).toBe('Valid Song.mp3');

    // Index the scanned files
    await publisher.indexFiles(scanResults);

    // === PHASE 4: Run prune - this is where the bug manifests ===
    const currentPaths = new Set(scanResults.map(f => f.path));
    const { removed, tombstone } = publisher.pruneMissingFiles(currentPaths);

    // BUG: No tombstones generated because tiny/zero files aren't in the NEW local DB!
    // The indexer still has them, but we can't generate tombstones for them.
    expect(removed.length).toBe(0);
    expect(tombstone).toBeNull();

    // This proves the bug: stale entries in indexer can't be cleaned up
    // because pruneMissingFiles() only knows about files in local DB
  });

  it('CONTRAST: tombstone IS generated when file exists in local DB then disappears', async () => {
    const identity = new IdentityManager(identityDir);
    await identity.initialize();

    const localDb = new LocalDatabase(dbPath);
    const publisher = new Publisher(identity, localDb);

    // Create two valid files
    const file1 = join(dataDir, 'Song One.mp3');
    const file2 = join(dataDir, 'Song Two.mp3');

    writeFileSync(file1, 'content-one-' + 'x'.repeat(2048));
    writeFileSync(file2, 'content-two-' + 'x'.repeat(2048));

    // Scan and index both files
    const scanResults = await publisher.scanDirectory(dataDir);
    expect(scanResults.length).toBe(2);
    const entries = await publisher.indexFiles(scanResults);
    expect(entries.length).toBe(2);

    const file2Hash = entries.find(e => e.path === file2)!.contentHash;

    // Delete file2 from disk
    rmSync(file2);

    // Scan again - only file1 remains
    const scanResults2 = await publisher.scanDirectory(dataDir);
    expect(scanResults2.length).toBe(1);

    // Run prune - this SHOULD generate a tombstone because file2 is in local DB
    const currentPaths = new Set(scanResults2.map(f => f.path));
    const { removed, tombstone } = publisher.pruneMissingFiles(currentPaths);

    // Tombstone IS generated because file2 was in local DB
    expect(removed.length).toBe(1);
    expect(removed[0]).toBe(file2Hash);
    expect(tombstone).not.toBeNull();
    expect(tombstone!.removals.some(r => r.contentHash === file2Hash)).toBe(true);
  });

  it('PROPOSED FIX: should generate tombstones for filtered files that exist on disk but not in scan', async () => {
    // This test documents the DESIRED behavior after the fix
    // Currently this will fail - it shows what we need to implement

    const identity = new IdentityManager(identityDir);
    await identity.initialize();

    const localDb = new LocalDatabase(dbPath);
    const publisher = new Publisher(identity, localDb);

    // Create files including tiny ones
    const validFile = join(dataDir, 'Valid Song.mp3');
    const tinyFile = join(dataDir, 'Tiny Song.mp3');

    writeFileSync(validFile, 'valid-content-' + 'x'.repeat(2048));
    writeFileSync(tinyFile, 'tiny'); // Will be filtered by scan

    // First, manually add the tiny file to DB (simulating old publish)
    localDb.upsertFile({
      path: tinyFile,
      contentHash: 'tinyhash'.repeat(8) as any,
      size: 4,
      mtime: Date.now(),
      ext: 'mp3' as any,
      tokens: ['tiny', 'song'],
    });

    // Scan directory - tiny file will be filtered out
    const scanResults = await publisher.scanDirectory(dataDir);
    expect(scanResults.length).toBe(1); // Only valid file

    // Index valid file
    await publisher.indexFiles(scanResults);

    // Prune should detect that tiny file is in DB but not in scan results
    const currentPaths = new Set(scanResults.map(f => f.path));
    const { removed, tombstone } = publisher.pruneMissingFiles(currentPaths);

    // This SHOULD work - tiny file is in DB, not in currentPaths
    // The key difference from the first test: the file IS in the DB here
    expect(removed.length).toBe(1);
    expect(tombstone).not.toBeNull();
    expect(tombstone!.removals.some(r => r.contentHash === 'tinyhash'.repeat(8))).toBe(true);
  });
});
