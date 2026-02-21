# @softtseek/overlay-client

TypeScript client library for the [SoFTTSeek](https://softtseek.com) peer-to-peer file-sharing network.

Provides identity management, distributed search, relay-based file transfers, content hashing, and provider browsing. Works in Node.js >= 18 with no Electron dependency.

## Install

```bash
npm install @softtseek/overlay-client
```

## Quick Start

```typescript
import { OverlayClient } from '@softtseek/overlay-client/lite';

const client = await OverlayClient.create();

// Search the network
const results = await client.search('dark side of the moon', { limit: 10 });

// Download a file
await client.download(
  results[0].contentHash,
  results[0].providers[0].pubKey,
  './download.mp3',
  { onProgress: (p) => console.log(`${p.status} ${p.bytesDownloaded}/${p.totalBytes}`) },
);

// Browse a provider's files
const files = await client.browseProvider(results[0].providers[0].pubKey);

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

#### `client.search(query, opts?)`

Search the overlay network. Returns `SearchResult[]`.

```typescript
const results = await client.search('query', {
  limit: 25,
  filters: { ext: ['mp3', 'flac'], minSize: 1000000 },
  signal: AbortSignal.timeout(30000),
  timeoutMs: 30000,
});
```

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

Download a file from a provider via relay. Returns `Promise<boolean>`.

```typescript
const success = await client.download(contentHash, providerPubKey, './file.mp3', {
  onProgress: (progress) => { /* TransferProgress */ },
  signal: controller.signal,
  timeoutMs: 120000,
});
```

**TransferProgress fields:**

| Field | Type | Description |
|-------|------|-------------|
| `contentHash` | `string` | File being transferred |
| `status` | `string` | `'connecting'` \| `'downloading'` \| `'verifying'` \| `'completed'` \| `'failed'` |
| `bytesDownloaded` | `number` | Bytes received so far |
| `totalBytes` | `number` | Total file size |
| `transport` | `string` | Always `'relay'` for this client |

#### `client.browseProvider(pubKey)`

List all files shared by a provider. Returns `Promise<OverlayBrowseFile[]>`.

```typescript
const files = await client.browseProvider('abc123...');
// files[0] = { path, size, ext, contentHash, ... }
```

#### `client.checkHealth()`

Check network infrastructure health.

```typescript
const health = await client.checkHealth();
// { bootstrap: true, indexers: ['http://...'], relays: ['relay://...'] }
```

#### `client.getIdentity()`

Get the current Ed25519 identity.

```typescript
const id = client.getIdentity();
// { publicKey: '...', fingerprint: '...', displayName: 'AnonymousFox42' }
```

#### `client.shutdown()`

Gracefully close all connections.

---

### `IdentityManager`

Ed25519 identity management with BIP-39 mnemonic backup.

```typescript
import { IdentityManager, FileIdentityStorage } from '@softtseek/overlay-client/lite';

const storage = new FileIdentityStorage('~/.softtseek');
const identity = new IdentityManager(storage);
await identity.initialize(); // loads existing or generates new

const id = identity.getIdentity();
// { publicKey, fingerprint, mnemonic }

const sig = identity.sign(Buffer.from('message'));
const valid = IdentityManager.verify(Buffer.from('message'), sig, id.publicKey);
```

**Storage backends:**
- `FileIdentityStorage(dir)` - Persists to disk (production)
- `MemoryIdentityStorage()` - In-memory (testing)

---

### `QueryRouter`

Distributed search across sharded indexer nodes.

```typescript
import { QueryRouter } from '@softtseek/overlay-client/lite';

const router = new QueryRouter(['http://indexer1:8080', 'http://indexer2:8080']);
const results = await router.search('query', filters, limit, signal, timeoutMs);
```

---

### `RelayTransport`

Low-level relay transport for file transfers, direct messages, and browse requests with automatic retry/fallback across relay candidates.

```typescript
import { RelayTransport } from '@softtseek/overlay-client/lite';

const relay = new RelayTransport(['relay://host:9000']);

// Download a file
relay.on('progress', (p) => console.log(p.status, p.bytesDownloaded));
const success = await relay.requestFileFromProvider(
  contentHash, providerPubKey, destPath, undefined,
  { signal, timeoutMs: 120000 },
);

// Register as provider
await relay.registerAsProvider(pubKey, fileMap);

// Send direct message
const ack = await relay.sendDirectMessage(targetPubKey, relayUrl, message);

// Browse provider
const response = await relay.sendBrowseRequest(providerPubKey, browseRequest);
```

---

### Hashing Utilities

BLAKE3 content hashing with automatic native/WASM fallback.

```typescript
import { ensureBlake3, hashFile, hashBytes, hashString, verifyFileHash } from '@softtseek/overlay-client/lite';

// Must call once before hashing
await ensureBlake3();

const meta = await hashFile('/path/to/file');
// { hash: '...', size: 12345 }

const hash = hashBytes(Buffer.from('data'));
const strHash = hashString('hello');
const valid = await verifyFileHash('/path/to/file', expectedHash);
```

---

### Tokenizer

File and query tokenization for the distributed search index.

```typescript
import { tokenizeFile, tokenizeQuery, tokenizeFilename } from '@softtseek/overlay-client/lite';

const result = tokenizeFile('/music/Artist - Album/01 Track.mp3');
// { tokens: ['artist', 'album', 'track', 'mp3'], ... }

const queryTokens = tokenizeQuery('dark side moon');
// ['dark', 'side', 'moon']
```

## Architecture

SoFTTSeek is a decentralized P2P file-sharing network:

```
Client
  ├── Bootstrap Node    → Discovers indexers and relays
  ├── Indexer Nodes     → Distributed full-text search (sharded by BLAKE3)
  └── Relay Node        → NAT traversal for file transfer
        ├── Provider    → Registered provider serves files
        └── Requester   → Downloads via content-addressed relay requests
```

- **Identity**: Ed25519 keypairs with BIP-39 mnemonic backup
- **Content addressing**: BLAKE3 hashes for file identification and integrity verification
- **Search**: Tokenized queries routed to sharded indexer nodes
- **Transport**: Relay-based with automatic retry/fallback across candidates, exponential backoff reconnect, and keepalive
- **Security**: All messages are signed; signatures verified before processing

## License

MIT
