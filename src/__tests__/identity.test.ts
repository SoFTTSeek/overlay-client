/**
 * Tests for Identity Module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { IdentityManager } from '../identity/index.js';

describe('IdentityManager', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'identity-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('initialization', () => {
    it('should generate a new identity if none exists', async () => {
      const manager = new IdentityManager(tempDir);
      await manager.initialize();

      const pubKey = manager.getPublicKey();
      expect(pubKey).toBeDefined();
      expect(pubKey.length).toBe(64); // 32 bytes hex
    });

    it('should load existing identity on subsequent initialization', async () => {
      const manager1 = new IdentityManager(tempDir);
      await manager1.initialize();
      const pubKey1 = manager1.getPublicKey();

      const manager2 = new IdentityManager(tempDir);
      await manager2.initialize();
      const pubKey2 = manager2.getPublicKey();

      expect(pubKey1).toBe(pubKey2);
    });
  });

  describe('signing', () => {
    it('should sign data correctly', async () => {
      const manager = new IdentityManager(tempDir);
      await manager.initialize();

      const data = Buffer.from('test data');
      const signature = manager.sign(data);

      expect(signature).toBeDefined();
      expect(signature.length).toBe(128); // 64 bytes hex
    });

    it('should produce different signatures for different data', async () => {
      const manager = new IdentityManager(tempDir);
      await manager.initialize();

      const sig1 = manager.sign(Buffer.from('data 1'));
      const sig2 = manager.sign(Buffer.from('data 2'));

      expect(sig1).not.toBe(sig2);
    });
  });

  describe('verification', () => {
    it('should verify valid signatures', async () => {
      const manager = new IdentityManager(tempDir);
      await manager.initialize();

      const data = Buffer.from('test data');
      const signature = manager.sign(data);

      const isValid = manager.verify(data, signature, manager.getPublicKey());
      expect(isValid).toBe(true);
    });

    it('should reject invalid signatures', async () => {
      const manager = new IdentityManager(tempDir);
      await manager.initialize();

      const data = Buffer.from('test data');
      const signature = manager.sign(data);

      const isValid = manager.verify(Buffer.from('different data'), signature, manager.getPublicKey());
      expect(isValid).toBe(false);
    });
  });

  describe('export/import', () => {
    it('should export and import seed phrase', async () => {
      const manager1 = new IdentityManager(tempDir);
      await manager1.initialize();
      const pubKey1 = manager1.getPublicKey();

      const seedPhrase = manager1.exportSeedPhrase();
      expect(seedPhrase.split(' ').length).toBe(24);

      const tempDir2 = await mkdtemp(join(tmpdir(), 'identity-test2-'));
      try {
        const manager2 = new IdentityManager(tempDir2);
        await manager2.importFromSeedPhrase(seedPhrase);
        const pubKey2 = manager2.getPublicKey();

        expect(pubKey1).toBe(pubKey2);
      } finally {
        await rm(tempDir2, { recursive: true, force: true });
      }
    });
  });
});
