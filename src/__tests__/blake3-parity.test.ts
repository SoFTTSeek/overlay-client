/**
 * blake3 vs blake3-wasm parity test
 * Verifies both implementations produce identical output for the same input.
 */

import { describe, it, expect } from 'vitest';

const testVectors = [
  { label: 'empty', input: Buffer.from('') },
  { label: 'hello world', input: Buffer.from('hello world') },
  { label: '1MB zeros', input: Buffer.alloc(1024 * 1024, 0x00) },
  { label: '1MB pattern', input: Buffer.alloc(1024 * 1024, 0xAB) },
];

describe('blake3 parity', () => {
  for (const { label, input } of testVectors) {
    it(`produces identical hashes for "${label}" (${input.length} bytes)`, async () => {
      const native = await import('blake3').catch(() => null);
      const wasm = await import('blake3-wasm').catch(() => null);

      if (!native || !wasm) {
        // Skip if either is unavailable in the test environment
        return;
      }

      const nativeHash = native.createHash();
      nativeHash.update(input);
      const nativeDigest = nativeHash.digest('hex');

      const wasmHash = wasm.createHash();
      wasmHash.update(input);
      const wasmDigest = wasmHash.digest('hex');

      expect(nativeDigest).toBe(wasmDigest);
    });
  }

  it('produces identical hashes when fed in chunks', async () => {
    const native = await import('blake3').catch(() => null);
    const wasm = await import('blake3-wasm').catch(() => null);

    if (!native || !wasm) return;

    const data = Buffer.alloc(256 * 1024, 0xCD);
    const chunkSize = 16 * 1024;

    const nativeHash = native.createHash();
    const wasmHash = wasm.createHash();

    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const chunk = data.subarray(offset, offset + chunkSize);
      nativeHash.update(chunk);
      wasmHash.update(chunk);
    }

    expect(nativeHash.digest('hex')).toBe(wasmHash.digest('hex'));
  });
});
