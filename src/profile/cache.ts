/**
 * Profile Fetch and Caching
 * PRD Section 11.2 - Optional identity layer with profile caching
 */

import type { PublicKeyHex, AuthChallengeResponse } from '../types.js';
import type { IdentityManager } from '../identity/index.js';
import { hexToBytes } from '../utils/cbor.js';

/**
 * User profile data
 */
export interface UserProfile {
  pubKey: PublicKeyHex;
  handle?: string;
  displayName?: string;
  bio?: string;
  avatar?: string;
  createdAt: number;
  updatedAt: number;
  signature?: string;
}

/**
 * Cached profile entry
 */
interface CachedProfile {
  profile: UserProfile;
  fetchedAt: number;
  expiresAt: number;
}

/**
 * Profile cache configuration
 */
interface ProfileCacheConfig {
  maxEntries: number;
  defaultTTLMs: number;
  handleTTLMs: number;
  fetchTimeoutMs: number;
  accountServiceUrl?: string;
}

const DEFAULT_CONFIG: ProfileCacheConfig = {
  maxEntries: 1000,
  defaultTTLMs: 60 * 60 * 1000, // 1 hour
  handleTTLMs: 24 * 60 * 60 * 1000, // 24 hours
  fetchTimeoutMs: 5000,
  accountServiceUrl: undefined,
};

/**
 * Profile Cache
 * Caches user profiles to reduce network requests
 */
export class ProfileCache {
  private cache: Map<PublicKeyHex, CachedProfile> = new Map();
  private handleIndex: Map<string, PublicKeyHex> = new Map();
  private config: ProfileCacheConfig;
  private pendingFetches: Map<string, Promise<UserProfile | null>> = new Map();

  constructor(config: Partial<ProfileCacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get profile by public key (from cache or fetch)
   */
  async getProfile(pubKey: PublicKeyHex): Promise<UserProfile | null> {
    // Check cache first
    const cached = this.cache.get(pubKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.profile;
    }

    // Check for pending fetch
    const pending = this.pendingFetches.get(pubKey);
    if (pending) {
      return pending;
    }

    // Fetch from account service
    const fetchPromise = this.fetchProfile(pubKey);
    this.pendingFetches.set(pubKey, fetchPromise);

    try {
      const profile = await fetchPromise;
      return profile;
    } finally {
      this.pendingFetches.delete(pubKey);
    }
  }

  /**
   * Get profile by handle
   */
  async getProfileByHandle(handle: string): Promise<UserProfile | null> {
    // Check handle index
    const normalizedHandle = handle.toLowerCase();
    const pubKey = this.handleIndex.get(normalizedHandle);

    if (pubKey) {
      return this.getProfile(pubKey);
    }

    // Check for pending fetch
    const pending = this.pendingFetches.get(`handle:${normalizedHandle}`);
    if (pending) {
      return pending;
    }

    // Fetch from account service
    const fetchPromise = this.fetchProfileByHandle(normalizedHandle);
    this.pendingFetches.set(`handle:${normalizedHandle}`, fetchPromise);

    try {
      const profile = await fetchPromise;
      return profile;
    } finally {
      this.pendingFetches.delete(`handle:${normalizedHandle}`);
    }
  }

  /**
   * Get cached profile (without fetch)
   */
  getCached(pubKey: PublicKeyHex): UserProfile | null {
    const cached = this.cache.get(pubKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.profile;
    }
    return null;
  }

  /**
   * Set profile in cache
   */
  setProfile(profile: UserProfile, ttlMs?: number): void {
    const now = Date.now();
    const ttl = ttlMs || (profile.handle ? this.config.handleTTLMs : this.config.defaultTTLMs);

    this.cache.set(profile.pubKey, {
      profile,
      fetchedAt: now,
      expiresAt: now + ttl,
    });

    // Update handle index
    if (profile.handle) {
      this.handleIndex.set(profile.handle.toLowerCase(), profile.pubKey);
    }

    // Evict if over capacity
    this.evictIfNeeded();
  }

  /**
   * Invalidate a profile
   */
  invalidate(pubKey: PublicKeyHex): void {
    const cached = this.cache.get(pubKey);
    if (cached?.profile.handle) {
      this.handleIndex.delete(cached.profile.handle.toLowerCase());
    }
    this.cache.delete(pubKey);
  }

  /**
   * Fetch profile from account service
   */
  private async fetchProfile(pubKey: PublicKeyHex): Promise<UserProfile | null> {
    if (!this.config.accountServiceUrl) {
      return null;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.fetchTimeoutMs);

      const response = await fetch(
        `${this.config.accountServiceUrl}/v1/profiles/${pubKey}`,
        { signal: controller.signal }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`Profile fetch failed: ${response.status}`);
      }

      const profile = await response.json() as UserProfile;
      this.setProfile(profile);
      return profile;
    } catch (err) {
      console.error('Failed to fetch profile:', err);
      return null;
    }
  }

  /**
   * Fetch profile by handle from account service
   */
  private async fetchProfileByHandle(handle: string): Promise<UserProfile | null> {
    if (!this.config.accountServiceUrl) {
      return null;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.fetchTimeoutMs);

      const response = await fetch(
        `${this.config.accountServiceUrl}/v1/profiles/handle/${encodeURIComponent(handle)}`,
        { signal: controller.signal }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`Profile fetch failed: ${response.status}`);
      }

      const profile = await response.json() as UserProfile;
      this.setProfile(profile);
      return profile;
    } catch (err) {
      console.error('Failed to fetch profile by handle:', err);
      return null;
    }
  }

  /**
   * Evict oldest entries if over capacity
   */
  private evictIfNeeded(): void {
    if (this.cache.size <= this.config.maxEntries) {
      return;
    }

    // Sort by fetchedAt (oldest first)
    const entries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);

    // Remove oldest entries until under capacity
    const toRemove = this.cache.size - this.config.maxEntries;
    for (let i = 0; i < toRemove; i++) {
      const [pubKey, cached] = entries[i];
      if (cached.profile.handle) {
        this.handleIndex.delete(cached.profile.handle.toLowerCase());
      }
      this.cache.delete(pubKey);
    }
  }

  /**
   * Clear expired entries
   */
  clearExpired(): void {
    const now = Date.now();
    const toDelete: PublicKeyHex[] = [];

    for (const [pubKey, cached] of this.cache) {
      if (now >= cached.expiresAt) {
        toDelete.push(pubKey);
        if (cached.profile.handle) {
          this.handleIndex.delete(cached.profile.handle.toLowerCase());
        }
      }
    }

    for (const pubKey of toDelete) {
      this.cache.delete(pubKey);
    }
  }

  /**
   * Prefetch profiles for a list of public keys
   */
  async prefetch(pubKeys: PublicKeyHex[]): Promise<void> {
    const uncached = pubKeys.filter(pk => !this.getCached(pk));

    // Batch fetch (limit concurrency)
    const batchSize = 10;
    for (let i = 0; i < uncached.length; i += batchSize) {
      const batch = uncached.slice(i, i + batchSize);
      await Promise.all(batch.map(pk => this.getProfile(pk)));
    }
  }

  /**
   * Get display name for a public key
   */
  getDisplayName(pubKey: PublicKeyHex): string {
    const profile = this.getCached(pubKey);
    return profile?.displayName || profile?.handle || pubKey.slice(0, 8) + '...';
  }

  /**
   * Get cache stats
   */
  getStats(): {
    totalEntries: number;
    handlesIndexed: number;
    pendingFetches: number;
  } {
    return {
      totalEntries: this.cache.size,
      handlesIndexed: this.handleIndex.size,
      pendingFetches: this.pendingFetches.size,
    };
  }

  /**
   * Set account service URL
   */
  setAccountServiceUrl(url: string): void {
    this.config.accountServiceUrl = url;
  }

  /**
   * Clear all cached profiles
   */
  clear(): void {
    this.cache.clear();
    this.handleIndex.clear();
  }

  private authToken: string | null = null;

  /**
   * Authenticate with the account service using Ed25519 challenge-response
   * Returns a session token for authenticated requests
   */
  async authenticate(identity: IdentityManager): Promise<string> {
    if (!this.config.accountServiceUrl) {
      throw new Error('Account service URL not configured');
    }

    // Step 1: Request challenge
    const pubKey = identity.getPublicKey();
    const challengeRes = await fetch(`${this.config.accountServiceUrl}/v1/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubKey }),
    });

    if (!challengeRes.ok) {
      throw new Error(`Challenge request failed: ${challengeRes.status}`);
    }

    const { challenge } = await challengeRes.json() as AuthChallengeResponse;

    // Step 2: Sign challenge with identity
    const challengeBytes = hexToBytes(challenge);
    const signature = identity.sign(challengeBytes);

    // Step 3: Verify with server
    const verifyRes = await fetch(`${this.config.accountServiceUrl}/v1/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubKey, challenge, signature }),
    });

    if (!verifyRes.ok) {
      throw new Error(`Verification failed: ${verifyRes.status}`);
    }

    const { token } = await verifyRes.json() as { success: boolean; token: string };
    this.authToken = token;
    return token;
  }

  /**
   * Update agent capabilities on the account service
   */
  async updateCapabilities(pubKey: PublicKeyHex, capabilities: string[], identity: IdentityManager): Promise<void> {
    if (!this.config.accountServiceUrl) {
      throw new Error('Account service URL not configured');
    }

    const { encode } = await import('cbor-x');
    const signable = encode({ pubKey, capabilities });
    const signature = identity.sign(signable);

    const res = await fetch(`${this.config.accountServiceUrl}/v1/profiles/${pubKey}/capabilities`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilities, signature }),
    });

    if (!res.ok) {
      throw new Error(`Update capabilities failed: ${res.status}`);
    }
  }

  /**
   * Find profiles by agent capability
   */
  async findByCapability(capability: string): Promise<UserProfile[]> {
    if (!this.config.accountServiceUrl) {
      return [];
    }

    try {
      const res = await fetch(
        `${this.config.accountServiceUrl}/v1/profiles/capabilities/${encodeURIComponent(capability)}`
      );

      if (!res.ok) return [];

      const data = await res.json() as { profiles: UserProfile[] };
      return data.profiles || [];
    } catch {
      return [];
    }
  }
}
