/**
 * Tests for BLAKE3 Hashing Module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { hashFile, hashBuffer, StreamingHasher, verifyFileHash } from '../publish/hasher.js';

describe('Hasher', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hasher-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('hashBuffer', () => {
    it('should hash a buffer correctly', () => {
      const data = Buffer.from('hello world');
      const hash = hashBuffer(data);

      expect(hash).toBeDefined();
      expect(hash.length).toBe(64); // 32 bytes hex
    });

    it('should produce consistent hashes', () => {
      const data = Buffer.from('test data');
      const hash1 = hashBuffer(data);
      const hash2 = hashBuffer(data);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different data', () => {
      const hash1 = hashBuffer(Buffer.from('data 1'));
      const hash2 = hashBuffer(Buffer.from('data 2'));

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('hashFile', () => {
    it('should hash a file correctly', async () => {
      const filePath = join(tempDir, 'test.txt');
      await writeFile(filePath, 'file content');

      const hash = await hashFile(filePath);

      expect(hash).toBeDefined();
      expect(hash.length).toBe(64);
    });

    it('should produce same hash for same content', async () => {
      const file1 = join(tempDir, 'file1.txt');
      const file2 = join(tempDir, 'file2.txt');
      await writeFile(file1, 'same content');
      await writeFile(file2, 'same content');

      const hash1 = await hashFile(file1);
      const hash2 = await hashFile(file2);

      expect(hash1).toBe(hash2);
    });
  });

  describe('StreamingHasher', () => {
    it('should hash data incrementally', () => {
      const hasher = new StreamingHasher();

      hasher.update(Buffer.from('hello'));
      hasher.update(Buffer.from(' '));
      hasher.update(Buffer.from('world'));

      const streamHash = hasher.finalize();
      const directHash = hashBuffer(Buffer.from('hello world'));

      expect(streamHash).toBe(directHash);
    });
  });

  describe('verifyFileHash', () => {
    it('should verify correct hash', async () => {
      const filePath = join(tempDir, 'verify.txt');
      await writeFile(filePath, 'verification test');

      const hash = await hashFile(filePath);
      const isValid = await verifyFileHash(filePath, hash);

      expect(isValid).toBe(true);
    });

    it('should reject incorrect hash', async () => {
      const filePath = join(tempDir, 'verify.txt');
      await writeFile(filePath, 'verification test');

      const isValid = await verifyFileHash(filePath, 'invalid_hash_0000000000000000000000000000000000000000000000000000000000000000');

      expect(isValid).toBe(false);
    });
  });
});
