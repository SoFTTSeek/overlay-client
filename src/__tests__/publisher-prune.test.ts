import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { IdentityManager } from '../identity/index.js';
import { LocalDatabase } from '../localdb/index.js';
import { Publisher } from '../publish/publisher.js';

describe('Publisher pruneMissingFiles', () => {
  let testDir: string;
  let dbPath: string;
  let identityDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `overlay-prune-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    dbPath = join(testDir, 'localfiles.db');
    identityDir = join(testDir, 'identity');
    mkdirSync(identityDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('removes missing files and creates a tombstone', async () => {
    const identity = new IdentityManager(identityDir);
    await identity.initialize();

    const localDb = new LocalDatabase(dbPath);
    const publisher = new Publisher(identity, localDb);

    const existingFile = join(testDir, 'Existing Song.mp3');
    const missingFile = join(testDir, 'Missing Song.mp3');
    writeFileSync(existingFile, 'exists');
    writeFileSync(missingFile, 'missing');

    const scanResults = await publisher.scanDirectory(testDir);
    const entries = await publisher.indexFiles(scanResults);

    const missingEntry = entries.find((e) => e.path === missingFile);
    const existingEntry = entries.find((e) => e.path === existingFile);
    expect(missingEntry).toBeTruthy();
    expect(existingEntry).toBeTruthy();

    unlinkSync(missingFile);

    const currentPaths = new Set([existingFile]);
    const { removed, tombstone } = publisher.pruneMissingFiles(currentPaths);

    expect(removed).toContain(missingEntry!.contentHash);
    expect(localDb.getFileByHash(missingEntry!.contentHash)).toBeNull();
    expect(localDb.getFileByHash(existingEntry!.contentHash)).not.toBeNull();
    expect(tombstone).toBeTruthy();
    expect(tombstone!.removals.some((r) => r.contentHash === missingEntry!.contentHash)).toBe(true);
  });
});
