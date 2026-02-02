/**
 * Relay Transport Integration Tests
 * Tests end-to-end file transfer via relay server
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Socket, Server } from 'net';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { RelayTransport } from '../transport/relay.js';
import { hashFile } from '../publish/hasher.js';

/**
 * Minimal relay server for testing (mirrors production relay behavior)
 */
class TestRelayServer {
  private server: Server | null = null;
  private providers: Map<string, Socket> = new Map();
  private sessions: Map<string, { requester: Socket; providerPubKey: string }> = new Map();

  async start(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((socket) => this.handleConnection(socket));
      this.server.listen(port, '127.0.0.1', () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }

  getConnectedProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  private handleConnection(socket: Socket): void {
    let buffer = Buffer.alloc(0);
    let providerPubKey: string | null = null;
    let isRequester = false;
    let sessionId: string | null = null;

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);

      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) break;

        const frame = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);

        try {
          const msg = JSON.parse(frame.toString());

          // Provider registration
          if (msg.type === 'PROVIDER_REGISTER' && msg.pubKey) {
            providerPubKey = msg.pubKey;
            this.providers.set(msg.pubKey, socket);
            this.writeFrame(socket, { type: 'PROVIDER_REGISTERED' });
            continue;
          }

          // Requester requesting file
          if (msg.type === 'RELAY_REQUEST' && msg.providerPubKey && msg.contentHash) {
            isRequester = true;
            const provider = this.providers.get(msg.providerPubKey);
            if (!provider || provider.destroyed) {
              this.writeFrame(socket, { type: 'ERROR', error: 'Provider not connected to relay' });
              socket.destroy();
              return;
            }

            sessionId = `${msg.providerPubKey}:${msg.contentHash}:${Date.now()}`;
            this.sessions.set(sessionId, { requester: socket, providerPubKey: msg.providerPubKey });

            // Forward FILE_REQUEST to provider
            this.writeFrame(provider, {
              type: 'FILE_REQUEST',
              contentHash: msg.contentHash,
              requesterSessionId: sessionId,
            });
            continue;
          }

          // Provider responding with FILE_RESPONSE, DATA, COMPLETE, or ERROR
          if (providerPubKey && msg.requesterSessionId) {
            const session = this.sessions.get(msg.requesterSessionId);
            if (session && session.requester && !session.requester.destroyed) {
              // Forward frame to requester
              this.writeFrame(session.requester, msg);

              if (msg.type === 'COMPLETE' || msg.type === 'ERROR') {
                // Clean up session after a delay
                setTimeout(() => this.sessions.delete(msg.requesterSessionId), 1000);
              }
            }
          }
        } catch {
          // Not JSON - ignore
        }
      }
    });

    socket.on('close', () => {
      if (providerPubKey) {
        this.providers.delete(providerPubKey);
      }
    });

    socket.on('error', () => {});
  }

  private writeFrame(socket: Socket, data: object): void {
    const json = Buffer.from(JSON.stringify(data));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(json.length, 0);
    socket.write(Buffer.concat([header, json]));
  }
}

describe('RelayTransport Integration', () => {
  let relayServer: TestRelayServer;
  let relayPort: number;
  let testDir: string;

  beforeAll(async () => {
    // Create temp directory for test files
    testDir = join(tmpdir(), `relay-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Start test relay server on random port
    relayPort = 19000 + Math.floor(Math.random() * 1000);
    relayServer = new TestRelayServer();
    await relayServer.start(relayPort);
  });

  afterAll(async () => {
    if (relayServer) {
      await relayServer.stop();
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }, 30000); // 30 second timeout for cleanup

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

      // Verify provider is registered
      expect(relayServer.getConnectedProviders()).toContain(providerPubKey);

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
    }, 60000);

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

      // Verify file
      const downloadedContent = readFileSync(destPath);
      expect(downloadedContent.equals(testFileContent)).toBe(true);

      providerRelay.unregisterProvider();
    }, 30000);

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

      // First transfer
      const requester1 = new RelayTransport([`127.0.0.1:${relayPort}`]);
      const dest1 = join(testDir, 'multi-1-downloaded.bin');
      const result1 = await requester1.requestFileFromProvider(hash1, providerPubKey, dest1);
      expect(result1).toBe(true);
      expect(readFileSync(dest1).equals(file1Content)).toBe(true);

      // Provider should still be connected
      expect(providerRelay.isProviderRegistered()).toBe(true);

      // Second transfer
      const requester2 = new RelayTransport([`127.0.0.1:${relayPort}`]);
      const dest2 = join(testDir, 'multi-2-downloaded.bin');
      const result2 = await requester2.requestFileFromProvider(hash2, providerPubKey, dest2);
      expect(result2).toBe(true);
      expect(readFileSync(dest2).equals(file2Content)).toBe(true);

      // Provider should STILL be registered after both transfers
      expect(providerRelay.isProviderRegistered()).toBe(true);

      providerRelay.unregisterProvider();
    }, 60000);
  });
});
