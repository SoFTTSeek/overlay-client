/**
 * Tests for Collection creation and signature verification
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { IdentityManager, MemoryIdentityStorage } from '../identity/index.js';
import { Publisher, verifyCollectionSignature } from '../publish/publisher.js';
import { LocalDatabase } from '../localdb/index.js';
import type { LocalFileEntry } from '../types.js';

describe('Collection Signing', () => {
  let tempDir: string;
  let identity: IdentityManager;
  let localDb: LocalDatabase;
  let publisher: Publisher;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'collection-sign-test-'));
    identity = new IdentityManager(new MemoryIdentityStorage());
    await identity.initialize();
    localDb = new LocalDatabase(join(tempDir, 'local.db'));
    publisher = new Publisher(identity, localDb);
  });

  afterEach(async () => {
    localDb.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const createEntry = (idx: number): LocalFileEntry => ({
    path: `/tmp/file${idx}.flac`,
    contentHash: `h${idx}`.padEnd(64, '0'),
    size: 50000 + idx * 1000,
    mtime: Date.now(),
    ext: 'flac',
    tokens: ['jazz', `track${idx}`],
  });

  describe('createCollection', () => {
    it('should create a signed collection', () => {
      const entries = [createEntry(1), createEntry(2)];
      const collection = publisher.createCollection('Jazz Standards', 'Classic jazz', entries);

      expect(collection.name).toBe('Jazz Standards');
      expect(collection.description).toBe('Classic jazz');
      expect(collection.providerPubKey).toBe(identity.getPublicKey());
      expect(collection.items).toHaveLength(2);
      expect(collection.id.length).toBe(64); // BLAKE3 hash
      expect(collection.sig.length).toBe(128); // Ed25519 signature
    });

    it('should order items by entry order', () => {
      const entries = [createEntry(1), createEntry(2), createEntry(3)];
      const collection = publisher.createCollection('Test', undefined, entries);

      expect(collection.items[0].order).toBe(0);
      expect(collection.items[1].order).toBe(1);
      expect(collection.items[2].order).toBe(2);
    });

    it('should extract filename from path', () => {
      const entries = [createEntry(1)];
      const collection = publisher.createCollection('Test', undefined, entries);

      expect(collection.items[0].filename).toBe('file1.flac');
    });

    it('should produce different IDs for different content', () => {
      const entries1 = [createEntry(1)];
      const entries2 = [createEntry(2)];

      const c1 = publisher.createCollection('Same Name', 'Same Desc', entries1);
      const c2 = publisher.createCollection('Same Name', 'Same Desc', entries2);

      expect(c1.id).not.toBe(c2.id);
    });
  });

  describe('verifyCollectionSignature', () => {
    it('should verify a valid collection signature', () => {
      const entries = [createEntry(1), createEntry(2)];
      const collection = publisher.createCollection('Jazz', 'Nice jazz', entries);

      expect(verifyCollectionSignature(collection)).toBe(true);
    });

    it('should reject tampered collection name', () => {
      const entries = [createEntry(1)];
      const collection = publisher.createCollection('Original', undefined, entries);

      const tampered = { ...collection, name: 'Tampered' };
      expect(verifyCollectionSignature(tampered)).toBe(false);
    });

    it('should reject tampered items', () => {
      const entries = [createEntry(1)];
      const collection = publisher.createCollection('Test', undefined, entries);

      const tampered = {
        ...collection,
        items: [{ ...collection.items[0], size: 999999 }],
      };
      expect(verifyCollectionSignature(tampered)).toBe(false);
    });

    it('should reject collection signed by different identity', async () => {
      const entries = [createEntry(1)];
      const collection = publisher.createCollection('Test', undefined, entries);

      // Create different identity
      const otherIdentity = new IdentityManager(new MemoryIdentityStorage());
      await otherIdentity.initialize();

      // Replace pubkey (but keep original sig)
      const tampered = { ...collection, providerPubKey: otherIdentity.getPublicKey() };
      expect(verifyCollectionSignature(tampered)).toBe(false);
    });
  });
});
