/**
 * Identity Module - Ed25519 keypair management
 * PRD Section 4 - Identity Model
 */

import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { bytesToHex, hexToBytes } from '../utils/cbor.js';
import { writeFile, readFile, access } from 'fs/promises';
import { join } from 'path';
import type { PublicKeyHex, SignatureHex, Fingerprint } from '../types.js';

// Configure ed25519 to use sha512
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

/**
 * Identity keypair
 */
export interface Identity {
  /** Private key (32 bytes hex) - keep secret! */
  privateKey: string;
  /** Public key (32 bytes hex) - canonical overlay identity */
  publicKey: PublicKeyHex;
  /** User fingerprint for display (first 8 chars of SHA-256(pubkey)) */
  fingerprint: Fingerprint;
}

/**
 * Generate a new Ed25519 keypair
 */
export function generateIdentity(): Identity {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = ed.getPublicKey(privateKey);

  const privateKeyHex = bytesToHex(privateKey);
  const publicKeyHex = bytesToHex(publicKey);
  const fingerprint = computeFingerprint(publicKeyHex);

  return {
    privateKey: privateKeyHex,
    publicKey: publicKeyHex,
    fingerprint,
  };
}

/**
 * Restore identity from private key
 */
export function restoreIdentity(privateKeyHex: string): Identity {
  const privateKey = hexToBytes(privateKeyHex);
  const publicKey = ed.getPublicKey(privateKey);

  const publicKeyHex = bytesToHex(publicKey);
  const fingerprint = computeFingerprint(publicKeyHex);

  return {
    privateKey: privateKeyHex,
    publicKey: publicKeyHex,
    fingerprint,
  };
}

/**
 * Compute fingerprint from public key
 * First 8 chars of SHA-256(pubkey) for display as user_<fingerprint>
 */
export function computeFingerprint(publicKeyHex: PublicKeyHex): Fingerprint {
  const pubKeyBytes = hexToBytes(publicKeyHex);
  const hash = sha256(pubKeyBytes);
  return bytesToHex(hash).substring(0, 8);
}

/**
 * Get display name for anonymous user
 */
export function getAnonymousDisplayName(fingerprint: Fingerprint): string {
  return `user_${fingerprint}`;
}

/**
 * Sign a message with the private key
 * @param message - bytes to sign (should be canonical CBOR)
 * @param privateKeyHex - private key in hex
 * @returns signature in hex
 */
export function sign(message: Uint8Array, privateKeyHex: string): SignatureHex {
  const privateKey = hexToBytes(privateKeyHex);
  const signature = ed.sign(message, privateKey);
  return bytesToHex(signature);
}

/**
 * Verify a signature
 * @param message - original message bytes
 * @param signatureHex - signature in hex
 * @param publicKeyHex - public key in hex
 * @returns true if signature is valid
 */
export function verify(
  message: Uint8Array,
  signatureHex: SignatureHex,
  publicKeyHex: PublicKeyHex
): boolean {
  try {
    const signature = hexToBytes(signatureHex);
    const publicKey = hexToBytes(publicKeyHex);
    return ed.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/**
 * Validate that a hex string is a valid public key
 */
export function isValidPublicKey(publicKeyHex: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) {
    return false;
  }
  try {
    // Try to use it - will throw if invalid point
    const bytes = hexToBytes(publicKeyHex);
    // Simple length check for Ed25519 public key
    return bytes.length === 32;
  } catch {
    return false;
  }
}

/**
 * Validate that a hex string is a valid signature
 */
export function isValidSignature(signatureHex: string): boolean {
  return /^[0-9a-f]{128}$/i.test(signatureHex);
}

/**
 * Identity storage interface
 */
export interface IdentityStorage {
  save(identity: Identity): Promise<void>;
  load(): Promise<Identity | null>;
  exists(): Promise<boolean>;
}

/**
 * In-memory identity storage (for testing)
 */
export class MemoryIdentityStorage implements IdentityStorage {
  private identity: Identity | null = null;

  async save(identity: Identity): Promise<void> {
    this.identity = identity;
  }

  async load(): Promise<Identity | null> {
    return this.identity;
  }

  async exists(): Promise<boolean> {
    return this.identity !== null;
  }
}

/**
 * File-based identity storage
 */
export class FileIdentityStorage implements IdentityStorage {
  private filePath: string;

  constructor(dirPath: string) {
    this.filePath = join(dirPath, 'identity.json');
  }

  async save(identity: Identity): Promise<void> {
    await writeFile(this.filePath, JSON.stringify(identity));
  }

  async load(): Promise<Identity | null> {
    try {
      const data = await readFile(this.filePath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async exists(): Promise<boolean> {
    try {
      await access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Identity manager - handles creation, persistence, and operations
 */
export class IdentityManager {
  private identity: Identity | null = null;
  private storage: IdentityStorage;

  constructor(storageOrPath: IdentityStorage | string) {
    if (typeof storageOrPath === 'string') {
      this.storage = new FileIdentityStorage(storageOrPath);
    } else {
      this.storage = storageOrPath;
    }
  }

  /**
   * Initialize identity - loads existing or creates new
   */
  async initialize(): Promise<Identity> {
    const existing = await this.storage.load();
    if (existing) {
      this.identity = existing;
      return existing;
    }

    const newIdentity = generateIdentity();
    await this.storage.save(newIdentity);
    this.identity = newIdentity;
    return newIdentity;
  }

  /**
   * Get current identity (must be initialized first)
   */
  getIdentity(): Identity {
    if (!this.identity) {
      throw new Error('Identity not initialized. Call initialize() first.');
    }
    return this.identity;
  }

  /**
   * Get public key
   */
  getPublicKey(): PublicKeyHex {
    return this.getIdentity().publicKey;
  }

  /**
   * Get fingerprint
   */
  getFingerprint(): Fingerprint {
    return this.getIdentity().fingerprint;
  }

  /**
   * Sign data with identity private key
   */
  sign(data: Uint8Array): SignatureHex {
    return sign(data, this.getIdentity().privateKey);
  }

  /**
   * Verify a signature from another identity (instance method)
   */
  verify(data: Uint8Array, signature: SignatureHex, publicKey: PublicKeyHex): boolean {
    return verify(data, signature, publicKey);
  }

  /**
   * Verify a signature from another identity (static method)
   */
  static verify(data: Uint8Array, signature: SignatureHex, publicKey: PublicKeyHex): boolean {
    return verify(data, signature, publicKey);
  }

  /**
   * Export identity as a 24-word seed phrase
   */
  exportSeedPhrase(): string {
    const identity = this.getIdentity();
    // Use private key bytes to generate mnemonic
    const privateKeyBytes = hexToBytes(identity.privateKey);
    return bip39.entropyToMnemonic(privateKeyBytes, wordlist);
  }

  /**
   * Import identity from a 24-word seed phrase
   */
  async importFromSeedPhrase(seedPhrase: string): Promise<Identity> {
    // Convert mnemonic back to entropy (private key)
    const privateKeyBytes = bip39.mnemonicToEntropy(seedPhrase, wordlist);
    const privateKeyHex = bytesToHex(privateKeyBytes);
    const identity = restoreIdentity(privateKeyHex);

    await this.storage.save(identity);
    this.identity = identity;
    return identity;
  }
}

// Re-export types
export type { PublicKeyHex, SignatureHex, Fingerprint };
