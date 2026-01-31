/**
 * CBOR serialization utilities for deterministic signing
 * Uses cbor-x for canonical CBOR encoding
 */

import { encode, decode } from 'cbor-x';
import type {
  PublishMessage,
  RefreshMessage,
  TombstoneMessage,
  PresenceMessage,
  Profile,
  TokenPosting,
} from '../types.js';

/**
 * Encode data to canonical CBOR bytes for signing
 * cbor-x produces deterministic output by default
 */
export function encodeCanonical(data: unknown): Uint8Array {
  return encode(data);
}

/**
 * Decode CBOR bytes back to data
 */
export function decodeCbor<T>(bytes: Uint8Array): T {
  return decode(bytes) as T;
}

/**
 * Get the signable bytes for a PUBLISH message (excludes sig field)
 */
export function getPublishSignableBytes(msg: Omit<PublishMessage, 'sig' | 'type'>): Uint8Array {
  const signable = {
    type: 'PUBLISH',
    providerPubKey: msg.providerPubKey,
    ts: msg.ts,
    ttlMs: msg.ttlMs,
    postings: msg.postings.map((p: TokenPosting) => ({
      token: p.token,
      contentHash: p.contentHash,
      size: p.size,
      ext: p.ext,
      ...(p.filenameShort && { filenameShort: p.filenameShort }),
    })),
  };
  return encodeCanonical(signable);
}

/**
 * Get the signable bytes for a REFRESH message
 */
export function getRefreshSignableBytes(msg: Omit<RefreshMessage, 'sig' | 'type'>): Uint8Array {
  const signable = {
    type: 'REFRESH',
    providerPubKey: msg.providerPubKey,
    ts: msg.ts,
    ttlMs: msg.ttlMs,
    items: msg.items,
  };
  return encodeCanonical(signable);
}

/**
 * Get the signable bytes for a TOMBSTONE message
 */
export function getTombstoneSignableBytes(msg: Omit<TombstoneMessage, 'sig' | 'type'>): Uint8Array {
  const signable = {
    type: 'TOMBSTONE',
    providerPubKey: msg.providerPubKey,
    ts: msg.ts,
    removals: msg.removals,
  };
  return encodeCanonical(signable);
}

/**
 * Get the signable bytes for a PRESENCE message
 */
export function getPresenceSignableBytes(msg: Omit<PresenceMessage, 'sig' | 'type'>): Uint8Array {
  const signable = {
    type: 'PRESENCE',
    providerPubKey: msg.providerPubKey,
    ts: msg.ts,
    ttlMs: msg.ttlMs,
    capabilities: msg.capabilities,
  };
  return encodeCanonical(signable);
}

/**
 * Get the signable bytes for a Profile
 */
export function getProfileSignableBytes(profile: Omit<Profile, 'sig'>): Uint8Array {
  const signable = {
    providerPubKey: profile.providerPubKey,
    ...(profile.displayName && { displayName: profile.displayName }),
    ...(profile.handle && { handle: profile.handle }),
    capabilities: profile.capabilities,
    ts: profile.ts,
  };
  return encodeCanonical(signable);
}

/**
 * Serialize a message for network transmission (includes sig)
 */
export function serializeMessage(msg: unknown): Uint8Array {
  return encodeCanonical(msg);
}

/**
 * Deserialize a message from network bytes
 */
export function deserializeMessage<T>(bytes: Uint8Array): T {
  return decodeCbor<T>(bytes);
}

/**
 * Utility to convert hex string to Uint8Array
 */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Utility to convert Uint8Array to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
