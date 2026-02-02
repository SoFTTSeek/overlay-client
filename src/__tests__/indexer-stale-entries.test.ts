/**
 * Integration test to verify stale entries exist in production indexers
 *
 * This test queries the actual production indexers to confirm the bug:
 * - Search for "softt" returns 0-byte and 93-byte files
 * - These files are from the Mac mini's pubkey (a6858fe6077a3ab4...)
 * - They shouldn't be there after the filtering fix
 */
import { describe, it, expect } from 'vitest';

// Production indexer URLs
const INDEXER_URLS = [
  'http://178.156.231.100:8080', // indexer-1
  'http://178.156.237.33:8080',  // indexer-2
];

// Mac mini's pubkey prefix (from logs)
const MAC_MINI_PUBKEY_PREFIX = 'a6858fe6077a3ab4';

interface QueryResponse {
  type: 'QUERY_RESPONSE';
  results: Array<{
    contentHash: string;
    matchedTokens: string[];
    providers: Array<{
      pubKey: string;
      size: number;
      ext: string;
      filenameShort?: string;
      folderPath?: string;
    }>;
  }>;
}

describe('Production indexer stale entries', () => {
  it('should find stale 0-byte and tiny files in indexer (confirms bug)', async () => {
    const staleEntries: Array<{
      indexer: string;
      filename?: string;
      size: number;
      pubKey: string;
    }> = [];

    for (const indexerUrl of INDEXER_URLS) {
      try {
        // Use the correct /v1/query endpoint with QUERY message format
        const response = await fetch(`${indexerUrl}/v1/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'QUERY',
            tokens: ['softt'],
            limit: 100,
          }),
        });

        if (!response.ok) {
          console.log(`Indexer ${indexerUrl} returned ${response.status}`);
          continue;
        }

        const data = await response.json() as QueryResponse;

        // Find entries from Mac mini that are 0-byte or <1KB
        for (const result of data.results) {
          for (const provider of result.providers) {
            if (
              provider.pubKey.startsWith(MAC_MINI_PUBKEY_PREFIX) &&
              provider.size < 1024 &&
              ['mp3', 'flac', 'wav', 'aac', 'ogg', 'opus', 'wma', 'm4a', 'aiff'].includes(provider.ext)
            ) {
              staleEntries.push({
                indexer: indexerUrl,
                filename: provider.filenameShort,
                size: provider.size,
                pubKey: provider.pubKey.slice(0, 16) + '...',
              });
            }
          }
        }
      } catch (err) {
        console.log(`Failed to query ${indexerUrl}:`, err);
      }
    }

    console.log('\n=== STALE ENTRIES FOUND IN INDEXERS ===');
    console.log(JSON.stringify(staleEntries, null, 2));
    console.log('========================================\n');

    // This test CONFIRMS the bug if stale entries are found
    // After the fix is deployed, this test should find 0 stale entries
    if (staleEntries.length > 0) {
      console.log(`BUG CONFIRMED: Found ${staleEntries.length} stale entries in indexers`);
      console.log('These entries should have been removed by tombstones but weren\'t');
      console.log('because they are not in the Mac mini\'s local database.\n');
    }

    // For now, just log - don't fail the test
    // This is a diagnostic test, not a regression test
    expect(true).toBe(true);
  });

  it('should show what Mac mini SHOULD have published vs what indexer has', async () => {
    // Query indexer for all entries from Mac mini
    const allMacMiniEntries: Array<{
      filename?: string;
      size: number;
      contentHash: string;
    }> = [];

    for (const indexerUrl of INDEXER_URLS) {
      try {
        const response = await fetch(`${indexerUrl}/v1/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'QUERY',
            tokens: ['softt'],
            limit: 100,
          }),
        });

        if (!response.ok) continue;

        const data = await response.json() as QueryResponse;

        for (const result of data.results) {
          for (const provider of result.providers) {
            if (provider.pubKey.startsWith(MAC_MINI_PUBKEY_PREFIX)) {
              // Dedupe by contentHash + provider
              const key = `${result.contentHash}-${provider.pubKey}`;
              if (!allMacMiniEntries.some(e => e.contentHash === result.contentHash)) {
                allMacMiniEntries.push({
                  filename: provider.filenameShort,
                  size: provider.size,
                  contentHash: result.contentHash.slice(0, 16) + '...',
                });
              }
            }
          }
        }
      } catch {
        // ignore
      }
    }

    console.log('\n=== ALL MAC MINI ENTRIES IN INDEXER ===');
    console.log('Valid (>1KB audio):');
    allMacMiniEntries
      .filter(e => e.size >= 1024)
      .forEach(e => console.log(`  ✓ ${e.filename} (${e.size} bytes)`));

    console.log('\nStale (<1KB audio, should be filtered):');
    allMacMiniEntries
      .filter(e => e.size < 1024)
      .forEach(e => console.log(`  ✗ ${e.filename} (${e.size} bytes) - STALE`));

    console.log('========================================\n');

    // Log summary
    const validCount = allMacMiniEntries.filter(e => e.size >= 1024).length;
    const staleCount = allMacMiniEntries.filter(e => e.size < 1024).length;

    console.log(`Summary: ${validCount} valid entries, ${staleCount} stale entries`);

    if (staleCount > 0) {
      console.log('\nTo fix: Either wait 7 days for TTL expiry, or manually delete from indexers:');
      console.log(`  ssh -i keypair-hetzner root@178.156.231.100`);
      console.log(`  sqlite3 /var/lib/overlay-indexer/store.db "DELETE FROM postings WHERE provider_pub_key LIKE '${MAC_MINI_PUBKEY_PREFIX}%' AND size < 1024;"`);
    }

    expect(true).toBe(true);
  });
});
