# @softtseek/overlay-client

TypeScript client library for the [SoFTTSeek](https://softtseek.com) peer-to-peer file-sharing network.

Provides identity management, distributed search, relay-based file transfers, content hashing, and provider browsing. Works in Node.js >= 18 with no Electron dependency.

## Features

- **High-level `OverlayClient` facade** -- search, download, browse, and check health with a single class
- **Distributed search** across sharded indexer nodes (4096 shards, BLAKE3-based routing)
- **Relay-based file transfer** with automatic retry/fallback across relay candidates
- **Ed25519 identity** with BIP-39 mnemonic backup, file or in-memory storage backends
- **BLAKE3 content hashing** with automatic native/WASM fallback (works everywhere)
- **File tokenization** for indexing and query parsing
- **AbortSignal + timeout support** on all network operations
- **Transfer progress events** with status, bytes downloaded, total size
- **Provider browsing** to list a peer's shared files via relay
- **Direct messaging** with cryptographic signature verification
- **Exponential backoff reconnect** for provider relay connections
- **Zero-config defaults** -- connects to production network out of the box

## Install

```bash
npm install @softtseek/overlay-client
```

Requires Node.js >= 18.

## Quick Start

```typescript
import { OverlayClient } from '@softtseek/overlay-client/lite';

const client = await OverlayClient.create();

// Search the network
const results = await client.search('Artist - Song Title', { limit: 10 });

// Download a file
await client.download(
  results[0].contentHash,
  results[0].providers[0].pubKey,
  './download.mp3',
  { onProgress: (p) => console.log(`${p.status} ${p.bytesDownloaded}/${p.totalBytes}`) },
);

// Browse a provider's files
const files = await client.browseProvider(results[0].providers[0].pubKey);

// Check network health
const health = await client.checkHealth();

// Clean up
await client.shutdown();
```

## Entry Points

| Import | Use case |
|--------|----------|
| `@softtseek/overlay-client/lite` | **Recommended.** Pure-JS modules only (no native C++ deps). Works everywhere. |
| `@softtseek/overlay-client` | Full export including Hyperswarm transport, SQLite local DB, Soulseek bridge. Requires native dependencies. |

The `/lite` entry point exports everything needed for search, download, browse, identity, hashing, and relay transport. Use the full entry point only if you need direct P2P transport (Hyperswarm), local database (better-sqlite3), or the Soulseek bridge.

## API Reference

### `OverlayClient`

High-level facade. Handles bootstrap discovery, identity, search, download, and browse.

#### `OverlayClient.create(opts?)`

Create and initialize a client instance. Discovers network topology from bootstrap nodes automatically.

```typescript
const client = await OverlayClient.create({
  configDir: '~/.softtseek',          // default
  bootstrapNodes: ['http://...'],      // default: production bootstrap
  relayNodes: ['relay://...'],         // default: production relay
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `configDir` | `string` | `~/.softtseek` | Directory for identity keys and config |
| `bootstrapNodes` | `string[]` | Production bootstrap | URLs of bootstrap nodes for discovery |
| `relayNodes` | `string[]` | Production relay | URLs of relay nodes for transfers |

#### `client.search(query, opts?)`

Search the overlay network. Returns `SearchResult[]`.

```typescript
const results = await client.search('Artist - Song Title', {
  limit: 25,
  filters: { ext: ['mp3', 'flac'], minSize: 1000000 },
  signal: AbortSignal.timeout(30000),
  timeoutMs: 30000,
});
```

| Option | Type | Description |
|--------|------|-------------|
| `limit` | `number` | Maximum results to return (default: 25) |
| `filters` | `QueryFilters` | Filter by extension, min/max size |
| `signal` | `AbortSignal` | Cancel the search |
| `timeoutMs` | `number` | Timeout in milliseconds |

**SearchResult fields:**

| Field | Type | Description |
|-------|------|-------------|
| `contentHash` | `string` | BLAKE3 content hash (unique file identifier) |
| `filename` | `string` | Original filename |
| `size` | `number` | File size in bytes |
| `ext` | `string` | File extension |
| `score` | `number` | Relevance score |
| `providers` | `Provider[]` | Available providers (each has `pubKey`, `relayUrl`) |

#### `client.download(contentHash, providerPubKey, destPath, opts?)`

Download a file from a provider via relay. Returns `Promise<boolean>`. The file is automatically verified against its BLAKE3 content hash after download.

```typescript
const controller = new AbortController();

const success = await client.download(contentHash, providerPubKey, './file.mp3', {
  onProgress: (progress) => {
    console.log(`${progress.status}: ${progress.bytesDownloaded}/${progress.totalBytes}`);
  },
  signal: controller.signal,
  timeoutMs: 120000,
});
```

| Option | Type | Description |
|--------|------|-------------|
| `onProgress` | `(p: TransferProgress) => void` | Progress callback |
| `signal` | `AbortSignal` | Cancel the download (partial files are cleaned up) |
| `timeoutMs` | `number` | Whole-operation timeout covering all retry attempts |

**TransferProgress fields:**

| Field | Type | Description |
|-------|------|-------------|
| `contentHash` | `string` | File being transferred |
| `status` | `TransferStatus` | `'connecting'` \| `'downloading'` \| `'verifying'` \| `'completed'` \| `'failed'` |
| `bytesDownloaded` | `number` | Bytes received so far |
| `totalBytes` | `number` | Total file size |
| `transport` | `string` | Always `'relay'` for this client |

#### `client.browseProvider(pubKey)`

List all files shared by a provider. Returns `Promise<OverlayBrowseFile[]>`.

```typescript
const files = await client.browseProvider('abc123...');
for (const file of files) {
  console.log(file.path, file.size, file.ext, file.contentHash);
}
```

#### `client.checkHealth()`

Check network infrastructure health.

```typescript
const health = await client.checkHealth();
console.log('Bootstrap:', health.bootstrap);   // true/false
console.log('Indexers:', health.indexers);       // ['http://...', ...]
console.log('Relays:', health.relays);           // ['relay://...', ...]
```

#### `client.getIdentity()`

Get the current Ed25519 identity.

```typescript
const id = client.getIdentity();
console.log(id.publicKey);     // hex-encoded Ed25519 public key
console.log(id.fingerprint);   // short hash of public key
console.log(id.displayName);   // deterministic anonymous name (e.g. "AnonymousFox42")
```

#### `client.shutdown()`

Gracefully close all connections and unregister from relays.

---

### `IdentityManager`

Ed25519 identity management with BIP-39 mnemonic backup.

```typescript
import { IdentityManager, FileIdentityStorage } from '@softtseek/overlay-client/lite';

const storage = new FileIdentityStorage('~/.softtseek');
const identity = new IdentityManager(storage);
await identity.initialize(); // loads existing or generates new

const id = identity.getIdentity();
console.log(id.publicKey);   // hex-encoded Ed25519 public key
console.log(id.fingerprint); // short fingerprint
console.log(id.mnemonic);    // BIP-39 recovery phrase

// Sign and verify messages
const sig = identity.sign(Buffer.from('message'));
const valid = IdentityManager.verify(Buffer.from('message'), sig, id.publicKey);
```

**Storage backends:**

| Backend | Use case |
|---------|----------|
| `FileIdentityStorage(dir)` | Persists keys to disk with `0700` permissions (production) |
| `MemoryIdentityStorage()` | In-memory, no persistence (testing) |

**Standalone utilities** (no IdentityManager instance needed):

```typescript
import {
  generateIdentity,
  restoreIdentity,
  computeFingerprint,
  getAnonymousDisplayName,
  sign,
  verify,
  isValidPublicKey,
  isValidSignature,
} from '@softtseek/overlay-client/lite';
```

---

### `QueryRouter`

Distributed search across sharded indexer nodes.

```typescript
import { QueryRouter } from '@softtseek/overlay-client/lite';

const router = new QueryRouter(['http://indexer1:8080', 'http://indexer2:8080']);
const results = await router.search(query, filters, limit, signal, timeoutMs);
```

Handles query tokenization, shard routing (BLAKE3-based), parallel indexer queries, and result merging/deduplication.

---

### `RelayTransport`

Low-level relay transport for file transfers, direct messages, and browse requests.

```typescript
import { RelayTransport } from '@softtseek/overlay-client/lite';

const relay = new RelayTransport(['relay://host:9000']);
```

#### File download with progress

```typescript
relay.on('progress', (p) => console.log(p.status, p.bytesDownloaded));

const success = await relay.requestFileFromProvider(
  contentHash, providerPubKey, destPath, preferredRelayUrl,
  { signal: controller.signal, timeoutMs: 120000 },
);
```

The `timeoutMs` is a **whole-operation deadline** covering all retry attempts, not per-attempt.

#### Provider registration

```typescript
// Register as a file provider (long-lived connection with auto-reconnect)
const fileMap = new Map([['contentHash123', '/path/to/file.mp3']]);
await relay.registerAsProvider(pubKey, fileMap);

// Update shared files without reconnecting
relay.updateProvidedFiles(updatedFileMap);

// Unregister
relay.unregisterProvider();
```

#### Browse and direct message

```typescript
// Browse a provider's files
const response = await relay.sendBrowseRequest(providerPubKey, browseRequest);

// Send a signed direct message
const ack = await relay.sendDirectMessage(targetPubKey, relayUrl, message);
// ack.status: 'delivered' | 'rejected' | 'undeliverable'
```

#### Event handlers (provider side)

```typescript
// Handle browse requests from other peers
relay.setBrowseRequestHandler((request) => {
  return { files: [...] }; // or null to reject
});

// Handle direct messages from other peers
relay.setDirectMessageHandler((message) => {
  console.log('Message from:', message.from);
});
```

**Reliability features:**
- Automatic retry/fallback across all relay candidates
- Exponential backoff with jitter on provider reconnect
- Provider registration ACK handshake with timeout
- TCP keepalive (`15s`) and Nagle disabled on all sockets
- Settled guards prevent double-resolve on concurrent events

---

### Hashing Utilities

BLAKE3 content hashing with automatic native/WASM fallback.

```typescript
import {
  ensureBlake3, hashFile, hashBytes, hashString, verifyFileHash, StreamingHasher,
} from '@softtseek/overlay-client/lite';

// Initialize once before hashing (loads native blake3 or falls back to WASM)
await ensureBlake3();

// Hash a file (returns { hash, size })
const meta = await hashFile('/path/to/file.mp3');

// Hash raw bytes or strings
const hash = hashBytes(Buffer.from('data'));
const strHash = hashString('hello');

// Verify a downloaded file matches its expected hash
const valid = await verifyFileHash('/path/to/file.mp3', expectedHash);

// Streaming hasher for incremental hashing
const hasher = new StreamingHasher();
hasher.update(chunk1);
hasher.update(chunk2);
const finalHash = hasher.digest();
```

---

### Tokenizer

File and query tokenization for the distributed search index.

```typescript
import {
  tokenizeFile, tokenizeQuery, tokenizeFilename, tokenizePath, parseExtension,
} from '@softtseek/overlay-client/lite';

// Tokenize a file path for indexing
const result = tokenizeFile('/music/Artist - Album/01 - Song Title.mp3');
// { tokens: ['artist', 'album', 'song', 'title', 'mp3'], ... }

// Tokenize a search query
const queryTokens = tokenizeQuery('Artist Song Title');
// ['artist', 'song', 'title']

// Tokenize just the filename
const nameTokens = tokenizeFilename('01 - Song Title.mp3');

// Parse extension
const ext = parseExtension('file.flac'); // 'flac'
```

---

### CBOR / Signing Utilities

Canonical CBOR encoding and hex conversion for protocol messages.

```typescript
import { encodeCanonical, hexToBytes, bytesToHex } from '@softtseek/overlay-client/lite';

const encoded = encodeCanonical({ type: 'MESSAGE', data: '...' });
const bytes = hexToBytes('abcdef');
const hex = bytesToHex(new Uint8Array([171, 205, 239]));
```

## Architecture

SoFTTSeek is a decentralized P2P file-sharing network:

```
Client
  ├── Bootstrap Node    --> Discovers indexers and relays
  ├── Indexer Nodes     --> Distributed full-text search (4096 shards)
  └── Relay Node        --> NAT traversal for file transfer
        ├── Provider    --> Registered provider serves files
        └── Requester   --> Downloads via content-addressed relay requests
```

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Identity | Ed25519 + BIP-39 | Keypair generation, signing, mnemonic backup |
| Content addressing | BLAKE3 | File hashing, integrity verification, shard routing |
| Search | HTTP + tokenization | Sharded full-text search across indexer nodes |
| Transport | TCP relay | NAT traversal, file transfer, messaging, browsing |
| Security | Ed25519 signatures | All protocol messages signed and verified |

## Related

- [`softtseek`](https://www.npmjs.com/package/softtseek) -- CLI tool (built on this library)
- [SoFTTSeek Desktop App](https://softtseek.com) -- Full GUI application with Electron

## License

MIT
