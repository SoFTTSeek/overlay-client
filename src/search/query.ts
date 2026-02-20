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
  SearchSubscription,
  SubscriptionNotification,
  ContentHash,
  PublicKeyHex,
  OverlayConfig,
} from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';
import { tokenizeQuery, tokenizeFilename, getRarestToken, calculateTokenScore } from '../publish/tokenizer.js';
import { IndexerSelector, getShardForToken, groupTokensByShard } from './sharding.js';

/**
 * Indexer client interface
 */
export interface IndexerClient {
  query(indexerUrl: string, msg: QueryMessage, signal?: AbortSignal): Promise<QueryResponseMessage>;
}

/**
 * Simple HTTP indexer client
 */
export class HttpIndexerClient implements IndexerClient {
  private timeout: number;

  constructor(timeoutMs: number = 10000) {
    this.timeout = timeoutMs;
  }

  async query(indexerUrl: string, msg: QueryMessage, signal?: AbortSignal): Promise<QueryResponseMessage> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    // Combine internal timeout signal with external signal if provided
    const combinedSignal = signal
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal;

    try {
      const response = await fetch(`${indexerUrl}/v1/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
        signal: combinedSignal,
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
  /** Active SSE connections keyed by subscription ID */
  private sseConnections: Map<string, { controller: AbortController; indexerUrl: string }> = new Map();
  /** Indexer URL for each active subscription (for DELETE on unsubscribe) */
  private subscriptionIndexers: Map<string, string> = new Map();

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
    limit: number = 200,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<SearchResult[]> {
    // Tokenize query
    const tokens = tokenizeQuery(queryString);

    if (tokens.length === 0) {
      return [];
    }

    // Build a combined signal from caller signal + per-query timeout
    const querySignal = timeoutMs
      ? (signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs))
      : signal;

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
        .query(indexerUrl, msg, querySignal)
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
        // Verify which tokens ACTUALLY match this result's filename
        const bestProvider = item.providers[0];
        const filename = bestProvider?.filenameShort || '';
        const filenameTokens = new Set(tokenizeFilename(filename));

        // Only count tokens that are actually in the filename
        const verifiedMatches = queryTokens.filter(qt => filenameTokens.has(qt));

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

          // Add verified matches
          for (const token of verifiedMatches) {
            existing.matchedTokens.add(token);
          }
        } else {
          resultMap.set(item.contentHash, {
            item: { ...item },
            matchedTokens: new Set(verifiedMatches),
          });
        }
      }
    }

    // Require verified token matches based on query length
    // Note: Files may be indexed by path tokens we can't verify from filenameShort alone
    // - 1 token: trust indexer (token may be from path)
    // - 2-3 tokens: require at least 1 verified match
    // - 4+ tokens: require at least 2 verified matches
    const minMatches = queryTokens.length <= 1
      ? 0  // Trust indexer for single-token (may match path)
      : queryTokens.length <= 3
        ? 1
        : 2;

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
        folderPath: bestProvider?.folderPath,
        size: bestProvider?.size || 0,
        ext: bestProvider?.ext || 'other',
        source: 'overlay' as const,
        connectionQuality: 'unknown' as const,
        providers: result.item.providers.map(p => ({
          pubKey: p.pubKey,
        })),
        score,
        bitrate: bestProvider?.bitrate,
        duration: bestProvider?.duration,
        width: bestProvider?.width,
        height: bestProvider?.height,
      };
    });
  }

  /**
   * Subscribe to search results matching a query.
   * Tokenizes the query, POSTs a subscription to the indexer(s),
   * and opens an SSE connection for real-time notifications.
   *
   * @returns The subscription ID
   */
  async subscribe(
    query: string,
    filters?: QueryFilters,
    callback?: (notification: SubscriptionNotification) => void,
  ): Promise<string> {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) {
      throw new Error('Query produced no tokens');
    }

    // Find the indexer for the first (rarest) token to register the subscription
    const rarestToken = getRarestToken(tokens) || tokens[0];
    const indexerTokens = this.selector.getIndexersForQuery([rarestToken]);
    const first = indexerTokens.entries().next();
    if (first.done) {
      throw new Error('No indexers available for subscription');
    }
    const [indexerUrl] = first.value;

    // POST subscription to indexer
    const response = await fetch(`${indexerUrl}/v1/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pubKey: 'anonymous', // Subscriptions don't require identity
        tokens,
        filters,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create subscription: ${response.status}`);
    }

    const subscription = await response.json() as SearchSubscription;

    // Track which indexer owns this subscription (needed for unsubscribe DELETE)
    this.subscriptionIndexers.set(subscription.id, indexerUrl);

    // Open SSE connection if callback provided
    if (callback) {
      const controller = new AbortController();
      this.sseConnections.set(subscription.id, { controller, indexerUrl });

      // Start SSE listener in background (fire-and-forget)
      this.listenSSE(indexerUrl, subscription.id, callback, controller.signal).catch(() => {
        // SSE connection ended or failed, clean up
        this.sseConnections.delete(subscription.id);
      });
    }

    return subscription.id;
  }

  /**
   * Listen to SSE stream for subscription notifications
   */
  private async listenSSE(
    indexerUrl: string,
    subscriptionId: string,
    callback: (notification: SubscriptionNotification) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const url = `${indexerUrl}/v1/subscriptions/stream?id=${encodeURIComponent(subscriptionId)}`;

    const response = await fetch(url, {
      headers: { 'Accept': 'text/event-stream' },
      signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE connection failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        let eventType = '';
        let dataLines: string[] = [];

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            dataLines.push(line.slice(6));
          } else if (line === '') {
            // Empty line = end of event
            if (eventType === 'notification' && dataLines.length > 0) {
              try {
                const notification = JSON.parse(dataLines.join('\n')) as SubscriptionNotification;
                callback(notification);
              } catch {
                // Ignore malformed events
              }
            }
            eventType = '';
            dataLines = [];
          }
        }
      }
    } finally {
      // Clean up SSE connection state but preserve subscriptionIndexers
      // so unsubscribe() can still resolve the indexer URL for the DELETE request
      this.sseConnections.delete(subscriptionId);
    }
  }

  /**
   * Unsubscribe from a search subscription
   */
  async unsubscribe(subscriptionId: string): Promise<void> {
    // Close SSE connection if active
    const connection = this.sseConnections.get(subscriptionId);
    if (connection) {
      connection.controller.abort();
      this.sseConnections.delete(subscriptionId);
    }

    // DELETE subscription on the indexer
    const indexerUrl = connection?.indexerUrl ?? this.subscriptionIndexers.get(subscriptionId);
    this.subscriptionIndexers.delete(subscriptionId);
    if (indexerUrl) {
      await fetch(`${indexerUrl}/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: 'DELETE',
      }).catch(() => {
        // Silent failure for cleanup
      });
    }
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
