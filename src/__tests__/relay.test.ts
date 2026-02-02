/**
 * Relay Transport Integration Tests
 * Tests end-to-end file transfer via ACTUAL production relay server
 */

// Set NODE_ENV before any imports to prevent pino-pretty from loading
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { RelayTransport } from '../transport/relay.js';
import { hashFile } from '../publish/hasher.js';
// Import the ACTUAL production relay server
import { RelayServer } from '@softtseek/overlay-relay';

describe('RelayTransport Integration (Production RelayServer)', () => {
  let relayServer: RelayServer;
  let relayPort: number;
  let testDir: string;

  beforeAll(async () => {
    // Create temp directory for test files
    testDir = join(tmpdir(), `relay-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Start ACTUAL production relay server on random port
    relayPort = 19000 + Math.floor(Math.random() * 1000);
    relayServer = new RelayServer({ port: relayPort, host: '127.0.0.1' });
    await relayServer.start();
  }, 30000);

  afterAll(async () => {
    if (relayServer) {
      await relayServer.stop();
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }, 30000);

  describe('End-to-End File Transfer', () => {
    it('should transfer a small file (10KB) via relay', async () => {
      // Create test file
      const testFilePath = join(testDir, 'small-file.bin');
      const testFileContent = randomBytes(10 * 1024); // 10KB
      writeFileSync(testFilePath, testFileContent);

      // Create content hash using the actual hasher (Blake3)
      const contentHash = await hashFile(testFilePath);
      const destPath = join(testDir, 'small-file-downloaded.bin');

      // Create provider
      const providerRelay = new RelayTransport([`127.0.0.1:${relayPort}`]);
      const providerPubKey = randomBytes(32).toString('hex');
      const providedFiles = new Map<string, string>();
      providedFiles.set(contentHash, testFilePath);

      await providerRelay.registerAsProvider(providerPubKey, providedFiles);
      await new Promise(resolve => setTimeout(resolve, 200));

      // Verify provider is registered with the ACTUAL relay server
      const connectedProviders = relayServer.getConnectedProviders();
      expect(connectedProviders).toContain(providerPubKey);

      // Create requester and transfer file
      const requesterRelay = new RelayTransport([`127.0.0.1:${relayPort}`]);
      const result = await requesterRelay.requestFileFromProvider(
        contentHash,
        providerPubKey,
        destPath
      );

      expect(result).toBe(true);

      // Verify file content matches
      expect(existsSync(destPath)).toBe(true);
      const downloadedContent = readFileSync(destPath);
      expect(downloadedContent.length).toBe(testFileContent.length);
      expect(downloadedContent.equals(testFileContent)).toBe(true);

      providerRelay.unregisterProvider();
    }, 30000);

    it('should transfer a large file (5MB) via relay with backpressure', async () => {
      const testFilePath = join(testDir, 'large-file.bin');
      const testFileContent = randomBytes(5 * 1024 * 1024); // 5MB
      writeFileSync(testFilePath, testFileContent);

      const contentHash = await hashFile(testFilePath);
      const destPath = join(testDir, 'large-file-downloaded.bin');

      const providerRelay = new RelayTransport([`127.0.0.1:${relayPort}`]);
      const providerPubKey = randomBytes(32).toString('hex');
      const providedFiles = new Map<string, string>();
      providedFiles.set(contentHash, testFilePath);

      await providerRelay.registerAsProvider(providerPubKey, providedFiles);
      await new Promise(resolve => setTimeout(resolve, 200));

      // Verify with actual relay server
      expect(relayServer.getConnectedProviders()).toContain(providerPubKey);

      const requesterRelay = new RelayTransport([`127.0.0.1:${relayPort}`]);

      // Track progress
      const progressEvents: any[] = [];
      requesterRelay.on('progress', (progress) => progressEvents.push(progress));

      const result = await requesterRelay.requestFileFromProvider(
        contentHash,
        providerPubKey,
        destPath
      );

      expect(result).toBe(true);

      // Verify content
      const downloadedContent = readFileSync(destPath);
      expect(downloadedContent.length).toBe(testFileContent.length);
      expect(downloadedContent.equals(testFileContent)).toBe(true);

      // Verify progress events
      expect(progressEvents.length).toBeGreaterThan(0);
      expect(progressEvents[progressEvents.length - 1].status).toBe('completed');

      providerRelay.unregisterProvider();
    }, 120000); // 2 minute timeout for large file

    it('should fail gracefully when provider is not connected', async () => {
      const contentHash = randomBytes(32).toString('hex');
      const nonExistentPubKey = randomBytes(32).toString('hex');
      const destPath = join(testDir, 'should-not-exist.bin');

      const requesterRelay = new RelayTransport([`127.0.0.1:${relayPort}`]);

      await expect(
        requesterRelay.requestFileFromProvider(contentHash, nonExistentPubKey, destPath)
      ).rejects.toThrow('Provider not connected to relay');

      expect(existsSync(destPath)).toBe(false);
    }, 10000);

    it('should fail gracefully when file is not available on provider', async () => {
      const providerRelay = new RelayTransport([`127.0.0.1:${relayPort}`]);
      const providerPubKey = randomBytes(32).toString('hex');
      const providedFiles = new Map<string, string>(); // Empty!

      await providerRelay.registerAsProvider(providerPubKey, providedFiles);
      await new Promise(resolve => setTimeout(resolve, 200));

      // Verify with actual relay server
      expect(relayServer.getConnectedProviders()).toContain(providerPubKey);

      const requesterRelay = new RelayTransport([`127.0.0.1:${relayPort}`]);
      const contentHash = randomBytes(32).toString('hex');
      const destPath = join(testDir, 'should-not-exist-2.bin');

      await expect(
        requesterRelay.requestFileFromProvider(contentHash, providerPubKey, destPath)
      ).rejects.toThrow('File not available');

      expect(existsSync(destPath)).toBe(false);
      providerRelay.unregisterProvider();
    }, 10000);
  });

  describe('Provider Connection Stability', () => {
    it('should maintain provider connection during file transfer (reproduces original bug)', async () => {
      // This specifically tests the bug: connection closing during streaming
      const testFilePath = join(testDir, 'stability-test.bin');
      const testFileContent = randomBytes(1024 * 1024); // 1MB
      writeFileSync(testFilePath, testFileContent);

      const contentHash = await hashFile(testFilePath);
      const destPath = join(testDir, 'stability-test-downloaded.bin');

      const providerRelay = new RelayTransport([`127.0.0.1:${relayPort}`]);
      const providerPubKey = randomBytes(32).toString('hex');
      const providedFiles = new Map<string, string>();
      providedFiles.set(contentHash, testFilePath);

      await providerRelay.registerAsProvider(providerPubKey, providedFiles);
      await new Promise(resolve => setTimeout(resolve, 200));

      // Verify provider is registered BEFORE transfer
      expect(providerRelay.isProviderRegistered()).toBe(true);
      expect(relayServer.getConnectedProviders()).toContain(providerPubKey);

      const requesterRelay = new RelayTransport([`127.0.0.1:${relayPort}`]);
      const result = await requesterRelay.requestFileFromProvider(
        contentHash,
        providerPubKey,
        destPath
      );

      expect(result).toBe(true);

      // CRITICAL: Provider should STILL be registered AFTER transfer
      // This was the original bug - connection closed during streaming
      expect(providerRelay.isProviderRegistered()).toBe(true);
      expect(relayServer.getConnectedProviders()).toContain(providerPubKey);

      // Verify file
      const downloadedContent = readFileSync(destPath);
      expect(downloadedContent.equals(testFileContent)).toBe(true);

      providerRelay.unregisterProvider();
    }, 60000);

    it('should allow multiple sequential transfers from same provider', async () => {
      // Create two test files
      const file1Path = join(testDir, 'multi-1.bin');
      const file1Content = randomBytes(100 * 1024); // 100KB
      writeFileSync(file1Path, file1Content);
      const hash1 = await hashFile(file1Path);

      const file2Path = join(testDir, 'multi-2.bin');
      const file2Content = randomBytes(150 * 1024); // 150KB
      writeFileSync(file2Path, file2Content);
      const hash2 = await hashFile(file2Path);

      const providerRelay = new RelayTransport([`127.0.0.1:${relayPort}`]);
      const providerPubKey = randomBytes(32).toString('hex');
      const providedFiles = new Map<string, string>();
      providedFiles.set(hash1, file1Path);
      providedFiles.set(hash2, file2Path);

      await providerRelay.registerAsProvider(providerPubKey, providedFiles);
      await new Promise(resolve => setTimeout(resolve, 200));

      // Verify with actual relay server
      expect(relayServer.getConnectedProviders()).toContain(providerPubKey);

      // First transfer
      const requester1 = new RelayTransport([`127.0.0.1:${relayPort}`]);
      const dest1 = join(testDir, 'multi-1-downloaded.bin');
      const result1 = await requester1.requestFileFromProvider(hash1, providerPubKey, dest1);
      expect(result1).toBe(true);
      expect(readFileSync(dest1).equals(file1Content)).toBe(true);

      // Provider should still be connected (check both client and server)
      expect(providerRelay.isProviderRegistered()).toBe(true);
      expect(relayServer.getConnectedProviders()).toContain(providerPubKey);

      // Second transfer
      const requester2 = new RelayTransport([`127.0.0.1:${relayPort}`]);
      const dest2 = join(testDir, 'multi-2-downloaded.bin');
      const result2 = await requester2.requestFileFromProvider(hash2, providerPubKey, dest2);
      expect(result2).toBe(true);
      expect(readFileSync(dest2).equals(file2Content)).toBe(true);

      // Provider should STILL be registered after both transfers
      expect(providerRelay.isProviderRegistered()).toBe(true);
      expect(relayServer.getConnectedProviders()).toContain(providerPubKey);

      providerRelay.unregisterProvider();
    }, 60000);
  });

  describe('Relay Server Metrics', () => {
    it('should track session metrics correctly', async () => {
      const initialMetrics = relayServer.getMetrics();

      const testFilePath = join(testDir, 'metrics-test.bin');
      const testFileContent = randomBytes(50 * 1024); // 50KB
      writeFileSync(testFilePath, testFileContent);
      const contentHash = await hashFile(testFilePath);
      const destPath = join(testDir, 'metrics-test-downloaded.bin');

      const providerRelay = new RelayTransport([`127.0.0.1:${relayPort}`]);
      const providerPubKey = randomBytes(32).toString('hex');
      const providedFiles = new Map<string, string>();
      providedFiles.set(contentHash, testFilePath);

      await providerRelay.registerAsProvider(providerPubKey, providedFiles);
      await new Promise(resolve => setTimeout(resolve, 200));

      const requesterRelay = new RelayTransport([`127.0.0.1:${relayPort}`]);
      await requesterRelay.requestFileFromProvider(contentHash, providerPubKey, destPath);

      // Wait for session cleanup
      await new Promise(resolve => setTimeout(resolve, 6000));

      const finalMetrics = relayServer.getMetrics();

      // Should have created at least one new session
      expect(finalMetrics.totalSessions).toBeGreaterThan(initialMetrics.totalSessions);
      // Should have relayed bytes
      expect(finalMetrics.totalBytesRelayed).toBeGreaterThan(initialMetrics.totalBytesRelayed);

      providerRelay.unregisterProvider();
    }, 30000);
  });
});
