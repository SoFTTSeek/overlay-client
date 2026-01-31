/**
 * Query Router and Result Merger
 * PRD Section 5.6 - Query routing & merging
 */

import type {
  QueryMessage,
  QueryResponseMessage,
  QueryResultItem,
  QueryFilters,
  SearchResult,
  ContentHash,
  PublicKeyHex,
  OverlayConfig,
} from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';
import { tokenizeQuery, getRarestToken, calculateTokenScore } from '../publish/tokenizer.js';
import { IndexerSelector, getShardForToken, groupTokensByShard } from './sharding.js';

/**
 * Indexer client interface
 */
export interface IndexerClient {
  query(indexerUrl: string, msg: QueryMessage): Promise<QueryResponseMessage>;
}

/**
 * Simple HTTP indexer client
 */
export class HttpIndexerClient implements IndexerClient {
  private timeout: number;

  constructor(timeoutMs: number = 10000) {
    this.timeout = timeoutMs;
  }

  async query(indexerUrl: string, msg: QueryMessage): Promise<QueryResponseMessage> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${indexerUrl}/v1/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Indexer returned ${response.status}`);
      }

      return await response.json() as QueryResponseMessage;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Query result from a single indexer
 */
interface IndexerQueryResult {
  indexerUrl: string;
  tokens: string[];
  response: QueryResponseMessage | null;
  error?: Error;
}

/**
 * Query Router - routes queries to appropriate indexers
 */
export class QueryRouter {
  private selector: IndexerSelector;
  private client: IndexerClient;
  private config: OverlayConfig;

  constructor(
    indexerUrls: string[],
    client?: IndexerClient,
    config?: Partial<OverlayConfig>
  ) {
    this.selector = new IndexerSelector(indexerUrls, config?.indexerReplicationK || 5);
    this.client = client || new HttpIndexerClient(config?.queryTimeoutMs);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute a search query
   */
  async search(
    queryString: string,
    filters?: QueryFilters,
    limit: number = 200
  ): Promise<SearchResult[]> {
    // Tokenize query
    const tokens = tokenizeQuery(queryString);

    if (tokens.length === 0) {
      return [];
    }

    // Use rare-first strategy: query rarest token first for early filtering
    const rarestToken = getRarestToken(tokens);
    const orderedTokens = rarestToken
      ? [rarestToken, ...tokens.filter(t => t !== rarestToken)]
      : tokens;

    // Get indexer assignments for tokens
    const indexerTokens = this.selector.getIndexersForQuery(orderedTokens);

    // Query indexers in parallel
    const queryPromises: Promise<IndexerQueryResult>[] = [];

    for (const [indexerUrl, indexerTokenList] of indexerTokens) {
      const msg: QueryMessage = {
        type: 'QUERY',
        tokens: indexerTokenList,
        filters,
        limit,
      };

      const promise = this.client
        .query(indexerUrl, msg)
        .then(response => ({
          indexerUrl,
          tokens: indexerTokenList,
          response,
        }))
        .catch(error => ({
          indexerUrl,
          tokens: indexerTokenList,
          response: null,
          error,
        }));

      queryPromises.push(promise);
    }

    // Wait for all queries with timeout
    const results = await Promise.all(queryPromises);

    // Merge results
    return this.mergeResults(results, tokens, limit);
  }

  /**
   * Merge results from multiple indexers
   */
  private mergeResults(
    indexerResults: IndexerQueryResult[],
    queryTokens: string[],
    limit: number
  ): SearchResult[] {
    // Collect all results by content hash
    const resultMap = new Map<ContentHash, {
      item: QueryResultItem;
      matchedTokens: Set<string>;
    }>();

    for (const result of indexerResults) {
      if (!result.response) continue;

      for (const item of result.response.results) {
        const existing = resultMap.get(item.contentHash);

        if (existing) {
          // Merge providers
          for (const provider of item.providers) {
            const hasProvider = existing.item.providers.some(
              p => p.pubKey === provider.pubKey
            );
            if (!hasProvider) {
              existing.item.providers.push(provider);
            }
          }

          // Track matched tokens
          for (const token of result.tokens) {
            existing.matchedTokens.add(token);
          }
        } else {
          resultMap.set(item.contentHash, {
            item: { ...item },
            matchedTokens: new Set(result.tokens),
          });
        }
      }
    }

    // Apply AND/min-match semantics
    // If we have more than 2 tokens, require at least 2 matches
    const minMatches = queryTokens.length > 2 ? 2 : 1;

    const filtered = Array.from(resultMap.values())
      .filter(r => r.matchedTokens.size >= minMatches);

    // Score and rank results
    const scored = filtered.map(r => {
      const bestProvider = r.item.providers[0];
      const filenameTokens = bestProvider?.filenameShort
        ? tokenizeQuery(bestProvider.filenameShort)
        : [];

      // Calculate score based on:
      // 1. Number of matched tokens
      // 2. Token match quality (phrase match, etc.)
      // 3. Provider count (more providers = more available)
      let score = r.matchedTokens.size * 10;
      score += calculateTokenScore(queryTokens, filenameTokens, []);
      score += Math.log2(r.item.providers.length + 1);

      return {
        result: r,
        score,
      };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Convert to SearchResult format
    return scored.slice(0, limit).map(({ result, score }) => {
      const bestProvider = result.item.providers[0];

      return {
        id: result.item.contentHash,
        contentHash: result.item.contentHash,
        filename: bestProvider?.filenameShort || 'Unknown',
        size: bestProvider?.size || 0,
        ext: bestProvider?.ext || 'other',
        source: 'overlay' as const,
        connectionQuality: 'unknown' as const,
        providers: result.item.providers.map(p => ({
          pubKey: p.pubKey,
        })),
        score,
      };
    });
  }

  /**
   * Update indexer list
   */
  updateIndexers(indexerUrls: string[]): void {
    this.selector = new IndexerSelector(indexerUrls, this.config.indexerReplicationK);
  }
}

/**
 * Search result deduplication by content hash
 */
export function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];

  for (const result of results) {
    const key = result.contentHash || result.id;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(result);
    }
  }

  return deduped;
}

/**
 * Merge overlay and Soulseek results
 */
export function mergeOverlayAndSoulseek(
  overlayResults: SearchResult[],
  soulseekResults: SearchResult[],
  preferOverlay: boolean = true
): SearchResult[] {
  // Dedupe within each source
  const overlay = dedupeResults(overlayResults);
  const soulseek = dedupeResults(soulseekResults);

  // Try to match by filename/size for cross-source deduplication
  const merged: SearchResult[] = [...overlay];
  const overlayKeys = new Set(overlay.map(r => `${r.filename}:${r.size}`));

  for (const result of soulseek) {
    const key = `${result.filename}:${result.size}`;
    if (!overlayKeys.has(key)) {
      merged.push(result);
    } else if (!preferOverlay) {
      // If we prefer Soulseek for this match, replace
      const idx = merged.findIndex(r => `${r.filename}:${r.size}` === key);
      if (idx >= 0) {
        merged[idx] = result;
      }
    }
  }

  // Sort by score
  merged.sort((a, b) => b.score - a.score);

  return merged;
}
