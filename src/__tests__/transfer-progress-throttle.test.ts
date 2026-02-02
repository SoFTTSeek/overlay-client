/**
 * Tests for throttling transfer progress events
 *
 * Bug context: Overlay relay transfers emit progress events for every data chunk.
 * When forwarded to the main process and persisted to SQLite on each update,
 * the UI can become unresponsive due to event/IPC/DB churn.
 *
 * Fix: Throttle progress events in SoulseekBridge.handleProgress().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SoulseekBridge, UnifiedSearchResult } from '../bridge/soulseek.js';

describe('Transfer progress throttling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should throttle rapid progress events to avoid UI churn', () => {
    const bridge = new SoulseekBridge();

    const contentHash = 'efce13062058a5512a7ab56651a3d4583ce44fb73ad069c72792e8f6c3332a4e';
    const result: UnifiedSearchResult = {
      id: contentHash,
      contentHash,
      filename: 'test.mp3',
      size: 100,
      source: 'overlay',
      score: 0,
      connectionQuality: 'unknown',
      overlayProviders: [{ pubKey: 'a'.repeat(64) }],
    };

    const state: any = {
      id: contentHash,
      result,
      destPath: '/tmp/test.mp3',
      status: 'connecting',
      method: null,
      bytesTransferred: 0,
      totalBytes: result.size,
      startTime: Date.now(),
      attempts: 0,
    };

    (bridge as any).activeTransfers.set(contentHash, state);

    const events: any[] = [];
    bridge.on('transfer:progress', (event) => events.push(event));

    for (let i = 0; i < 10; i++) {
      (bridge as any).handleProgress({
        contentHash,
        status: 'downloading',
        bytesDownloaded: i + 1,
        totalBytes: result.size,
        chunksVerified: 0,
        totalChunks: 0,
        transport: 'relay',
      });
    }

    expect(events.length).toBe(1);

    vi.advanceTimersByTime(200);

    (bridge as any).handleProgress({
      contentHash,
      status: 'downloading',
      bytesDownloaded: 50,
      totalBytes: result.size,
      chunksVerified: 0,
      totalChunks: 0,
      transport: 'relay',
    });

    expect(events.length).toBe(2);
  });
});
