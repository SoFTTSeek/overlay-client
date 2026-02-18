/**
 * Tests for CBOR signing utilities (new message types)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { IdentityManager } from '../identity/index.js';
import {
  getDirectMessageSignableBytes,
  getCollectionSignableBytes,
  getReputationReportSignableBytes,
  getDownloadReceiptSignableBytes,
  encodeCanonical,
  decodeCbor,
} from '../utils/cbor.js';

describe('CBOR Signing Utilities', () => {
  let tempDir: string;
  let identity: IdentityManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cbor-test-'));
    identity = new IdentityManager(tempDir);
    await identity.initialize();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('getDirectMessageSignableBytes', () => {
    it('should produce deterministic bytes', () => {
      const msg = {
        from: 'a'.repeat(64),
        to: 'b'.repeat(64),
        ts: 1700000000000,
        contentType: 'text/plain',
        payload: 'hello',
      };

      const bytes1 = getDirectMessageSignableBytes(msg);
      const bytes2 = getDirectMessageSignableBytes(msg);

      expect(bytes1).toEqual(bytes2);
    });

    it('should produce different bytes for different payloads', () => {
      const base = {
        from: 'a'.repeat(64),
        to: 'b'.repeat(64),
        ts: 1700000000000,
        contentType: 'text/plain',
      };

      const bytes1 = getDirectMessageSignableBytes({ ...base, payload: 'hello' });
      const bytes2 = getDirectMessageSignableBytes({ ...base, payload: 'world' });

      expect(bytes1).not.toEqual(bytes2);
    });

    it('should be signable and verifiable', () => {
      const msg = {
        from: identity.getPublicKey(),
        to: 'b'.repeat(64),
        ts: Date.now(),
        contentType: 'text/plain',
        payload: 'test message',
      };

      const bytes = getDirectMessageSignableBytes(msg);
      const sig = identity.sign(bytes);

      expect(IdentityManager.verify(bytes, sig, identity.getPublicKey())).toBe(true);
    });

    it('should reject tampered message', () => {
      const msg = {
        from: identity.getPublicKey(),
        to: 'b'.repeat(64),
        ts: Date.now(),
        contentType: 'text/plain',
        payload: 'original',
      };

      const bytes = getDirectMessageSignableBytes(msg);
      const sig = identity.sign(bytes);

      // Tamper with message
      const tampered = getDirectMessageSignableBytes({ ...msg, payload: 'tampered' });
      expect(IdentityManager.verify(tampered, sig, identity.getPublicKey())).toBe(false);
    });
  });

  describe('getCollectionSignableBytes', () => {
    it('should produce deterministic bytes', () => {
      const collection = {
        name: 'Jazz Standards',
        description: 'Classic jazz',
        providerPubKey: 'a'.repeat(64),
        items: [
          { contentHash: 'h1'.padEnd(64, '0'), filename: 'track1.flac', size: 1000, ext: 'flac', order: 0 },
          { contentHash: 'h2'.padEnd(64, '0'), filename: 'track2.flac', size: 2000, ext: 'flac', order: 1 },
        ],
        ts: 1700000000000,
        ttlMs: 86400000,
      };

      const bytes1 = getCollectionSignableBytes(collection);
      const bytes2 = getCollectionSignableBytes(collection);

      expect(bytes1).toEqual(bytes2);
    });

    it('should be signable and verifiable', () => {
      const collection = {
        name: 'Test Collection',
        providerPubKey: identity.getPublicKey(),
        items: [
          { contentHash: 'h1'.padEnd(64, '0'), filename: 'file.mp3', size: 500, ext: 'mp3', order: 0 },
        ],
        ts: Date.now(),
        ttlMs: 3600000,
      };

      const bytes = getCollectionSignableBytes(collection);
      const sig = identity.sign(bytes);

      expect(IdentityManager.verify(bytes, sig, identity.getPublicKey())).toBe(true);
    });

    it('should produce different bytes when items change', () => {
      const base = {
        name: 'Same Name',
        providerPubKey: 'a'.repeat(64),
        ts: 1700000000000,
        ttlMs: 86400000,
      };

      const bytes1 = getCollectionSignableBytes({
        ...base,
        items: [{ contentHash: 'h1'.padEnd(64, '0'), filename: 'a.mp3', size: 100, ext: 'mp3', order: 0 }],
      });

      const bytes2 = getCollectionSignableBytes({
        ...base,
        items: [{ contentHash: 'h2'.padEnd(64, '0'), filename: 'b.mp3', size: 200, ext: 'mp3', order: 0 }],
      });

      expect(bytes1).not.toEqual(bytes2);
    });
  });

  describe('getReputationReportSignableBytes', () => {
    it('should produce deterministic bytes', () => {
      const report = {
        reporterPubKey: 'a'.repeat(64),
        subjectPubKey: 'b'.repeat(64),
        outcome: 'success',
        bytes: 50000,
        durationMs: 1000,
        ts: 1700000000000,
      };

      const bytes1 = getReputationReportSignableBytes(report);
      const bytes2 = getReputationReportSignableBytes(report);

      expect(bytes1).toEqual(bytes2);
    });

    it('should be signable and verifiable', () => {
      const report = {
        reporterPubKey: identity.getPublicKey(),
        subjectPubKey: 'b'.repeat(64),
        outcome: 'success',
        bytes: 100000,
        durationMs: 5000,
        ts: Date.now(),
      };

      const bytes = getReputationReportSignableBytes(report);
      const sig = identity.sign(bytes);

      expect(IdentityManager.verify(bytes, sig, identity.getPublicKey())).toBe(true);
    });
  });

  describe('getDownloadReceiptSignableBytes', () => {
    it('should produce deterministic bytes', () => {
      const receipt = {
        contentHash: 'c'.repeat(64),
        downloaderPubKey: 'a'.repeat(64),
        providerPubKey: 'b'.repeat(64),
        ts: 1700000000000,
        bytesReceived: 1048576,
      };

      const bytes1 = getDownloadReceiptSignableBytes(receipt);
      const bytes2 = getDownloadReceiptSignableBytes(receipt);

      expect(bytes1).toEqual(bytes2);
    });

    it('should be signable and verifiable', () => {
      const receipt = {
        contentHash: 'c'.repeat(64),
        downloaderPubKey: identity.getPublicKey(),
        providerPubKey: 'b'.repeat(64),
        ts: Date.now(),
        bytesReceived: 1048576,
      };

      const bytes = getDownloadReceiptSignableBytes(receipt);
      const sig = identity.sign(bytes);

      expect(IdentityManager.verify(bytes, sig, identity.getPublicKey())).toBe(true);
    });
  });

  describe('encodeCanonical / decodeCbor roundtrip', () => {
    it('should roundtrip complex objects', () => {
      const data = {
        name: 'test',
        items: [1, 2, 3],
        nested: { a: true, b: 'hello' },
      };

      const encoded = encodeCanonical(data);
      const decoded = decodeCbor<typeof data>(encoded);

      expect(decoded.name).toBe('test');
      expect(decoded.items).toEqual([1, 2, 3]);
      expect(decoded.nested.a).toBe(true);
      expect(decoded.nested.b).toBe('hello');
    });
  });
});
