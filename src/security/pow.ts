/**
 * Proof of Work Circuit Breaker
 * PRD Section 9.3 - Optional PoW for abuse resistance
 */

import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

/**
 * PoW challenge
 */
export interface PowChallenge {
  id: string;
  prefix: string;
  difficulty: number;
  expiresAt: number;
}

/**
 * PoW solution
 */
export interface PowSolution {
  challengeId: string;
  nonce: string;
  hash: string;
}

/**
 * PoW configuration
 */
interface PowConfig {
  // Difficulty levels (number of leading zero bits)
  normalDifficulty: number;
  elevatedDifficulty: number;
  emergencyDifficulty: number;

  // Thresholds for triggering elevated difficulty
  requestsPerMinuteThreshold: number;
  cpuLoadThreshold: number;

  // Challenge expiry
  challengeTTLMs: number;

  // Circuit breaker thresholds
  circuitBreakerThreshold: number;
  circuitBreakerCooldownMs: number;
}

const DEFAULT_CONFIG: PowConfig = {
  normalDifficulty: 16, // ~65536 hashes on average
  elevatedDifficulty: 20, // ~1M hashes on average
  emergencyDifficulty: 24, // ~16M hashes on average
  requestsPerMinuteThreshold: 1000,
  cpuLoadThreshold: 0.8,
  challengeTTLMs: 60 * 1000, // 1 minute
  circuitBreakerThreshold: 5000,
  circuitBreakerCooldownMs: 5 * 60 * 1000, // 5 minutes
};

/**
 * Circuit breaker state
 */
type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * PoW Verifier (server-side)
 */
export class PowVerifier extends EventEmitter {
  private config: PowConfig;
  private pendingChallenges: Map<string, PowChallenge> = new Map();
  private requestCounts: Map<string, number[]> = new Map(); // IP -> timestamps
  private circuitState: CircuitState = 'closed';
  private circuitOpenedAt: number = 0;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<PowConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the verifier
   */
  start(): void {
    // Cleanup expired challenges every 30 seconds
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, 30 * 1000);
  }

  /**
   * Stop the verifier
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Check if PoW is required for a request
   */
  isPowRequired(clientIp: string): boolean {
    // Always require if circuit is open
    if (this.circuitState === 'open') {
      return true;
    }

    // Check request rate for this IP
    const timestamps = this.requestCounts.get(clientIp) || [];
    const recentRequests = this.countRecentRequests(timestamps);

    if (recentRequests > this.config.requestsPerMinuteThreshold / 10) {
      return true;
    }

    // Check global request rate
    let totalRecent = 0;
    for (const ts of this.requestCounts.values()) {
      totalRecent += this.countRecentRequests(ts);
    }

    return totalRecent > this.config.requestsPerMinuteThreshold;
  }

  /**
   * Generate a PoW challenge
   */
  generateChallenge(clientIp?: string): PowChallenge {
    const id = randomBytes(16).toString('hex');
    const prefix = randomBytes(16).toString('hex');
    const difficulty = this.getCurrentDifficulty();

    const challenge: PowChallenge = {
      id,
      prefix,
      difficulty,
      expiresAt: Date.now() + this.config.challengeTTLMs,
    };

    this.pendingChallenges.set(id, challenge);

    return challenge;
  }

  /**
   * Verify a PoW solution
   */
  verifySolution(solution: PowSolution): boolean {
    const challenge = this.pendingChallenges.get(solution.challengeId);

    if (!challenge) {
      return false;
    }

    if (Date.now() > challenge.expiresAt) {
      this.pendingChallenges.delete(solution.challengeId);
      return false;
    }

    // Verify the hash
    const data = challenge.prefix + solution.nonce;
    const hash = createHash('sha256').update(data).digest('hex');

    if (hash !== solution.hash) {
      return false;
    }

    // Check difficulty
    if (!this.meetsdifficulty(hash, challenge.difficulty)) {
      return false;
    }

    // Remove used challenge
    this.pendingChallenges.delete(solution.challengeId);

    return true;
  }

  /**
   * Record a request (for rate tracking)
   */
  recordRequest(clientIp: string): void {
    const timestamps = this.requestCounts.get(clientIp) || [];
    timestamps.push(Date.now());

    // Keep only last 2 minutes
    const cutoff = Date.now() - 2 * 60 * 1000;
    const filtered = timestamps.filter(t => t > cutoff);
    this.requestCounts.set(clientIp, filtered);

    // Check circuit breaker
    let totalRecent = 0;
    for (const ts of this.requestCounts.values()) {
      totalRecent += this.countRecentRequests(ts);
    }

    if (totalRecent > this.config.circuitBreakerThreshold) {
      this.tripCircuitBreaker();
    }
  }

  /**
   * Get current difficulty level
   */
  private getCurrentDifficulty(): number {
    if (this.circuitState === 'open') {
      return this.config.emergencyDifficulty;
    }

    // Count total recent requests
    let totalRecent = 0;
    for (const ts of this.requestCounts.values()) {
      totalRecent += this.countRecentRequests(ts);
    }

    if (totalRecent > this.config.circuitBreakerThreshold * 0.7) {
      return this.config.elevatedDifficulty;
    }

    return this.config.normalDifficulty;
  }

  /**
   * Check if hash meets difficulty
   */
  private meetsdifficulty(hash: string, difficulty: number): boolean {
    // Convert hash to binary and check leading zeros
    const binaryStr = BigInt('0x' + hash).toString(2).padStart(256, '0');
    let leadingZeros = 0;

    for (const bit of binaryStr) {
      if (bit === '0') {
        leadingZeros++;
      } else {
        break;
      }
    }

    return leadingZeros >= difficulty;
  }

  /**
   * Count requests in the last minute
   */
  private countRecentRequests(timestamps: number[]): number {
    const cutoff = Date.now() - 60 * 1000;
    return timestamps.filter(t => t > cutoff).length;
  }

  /**
   * Trip the circuit breaker
   */
  private tripCircuitBreaker(): void {
    if (this.circuitState !== 'open') {
      this.circuitState = 'open';
      this.circuitOpenedAt = Date.now();
      this.emit('circuit:open');
    }
  }

  /**
   * Cleanup expired challenges and check circuit breaker
   */
  private cleanupExpired(): void {
    const now = Date.now();

    // Cleanup challenges
    for (const [id, challenge] of this.pendingChallenges) {
      if (now > challenge.expiresAt) {
        this.pendingChallenges.delete(id);
      }
    }

    // Cleanup old request timestamps
    const cutoff = now - 2 * 60 * 1000;
    for (const [ip, timestamps] of this.requestCounts) {
      const filtered = timestamps.filter(t => t > cutoff);
      if (filtered.length === 0) {
        this.requestCounts.delete(ip);
      } else {
        this.requestCounts.set(ip, filtered);
      }
    }

    // Check circuit breaker cooldown
    if (this.circuitState === 'open') {
      if (now - this.circuitOpenedAt > this.config.circuitBreakerCooldownMs) {
        this.circuitState = 'half-open';
        this.emit('circuit:half-open');

        // If load is back to normal, close circuit
        let totalRecent = 0;
        for (const ts of this.requestCounts.values()) {
          totalRecent += this.countRecentRequests(ts);
        }

        if (totalRecent < this.config.requestsPerMinuteThreshold) {
          this.circuitState = 'closed';
          this.emit('circuit:closed');
        }
      }
    }
  }

  /**
   * Get verifier stats
   */
  getStats(): {
    pendingChallenges: number;
    circuitState: CircuitState;
    currentDifficulty: number;
    totalRecentRequests: number;
  } {
    let totalRecent = 0;
    for (const ts of this.requestCounts.values()) {
      totalRecent += this.countRecentRequests(ts);
    }

    return {
      pendingChallenges: this.pendingChallenges.size,
      circuitState: this.circuitState,
      currentDifficulty: this.getCurrentDifficulty(),
      totalRecentRequests: totalRecent,
    };
  }
}

/**
 * PoW Solver (client-side)
 */
export class PowSolver extends EventEmitter {
  private aborted = false;

  /**
   * Solve a PoW challenge
   */
  async solve(challenge: PowChallenge): Promise<PowSolution | null> {
    this.aborted = false;

    const startTime = Date.now();
    let attempts = 0;

    while (!this.aborted) {
      // Generate random nonce
      const nonce = randomBytes(16).toString('hex');
      const data = challenge.prefix + nonce;
      const hash = createHash('sha256').update(data).digest('hex');

      attempts++;

      // Check difficulty
      if (this.meetsdifficulty(hash, challenge.difficulty)) {
        const elapsed = Date.now() - startTime;
        this.emit('solved', { attempts, elapsed });

        return {
          challengeId: challenge.id,
          nonce,
          hash,
        };
      }

      // Yield to event loop periodically and emit progress
      if (attempts % 100 === 0) {
        this.emit('progress', { attempts, elapsed: Date.now() - startTime });
        await new Promise(resolve => setImmediate(resolve));
      }

      // Check expiry
      if (Date.now() > challenge.expiresAt) {
        this.emit('expired');
        return null;
      }
    }

    return null;
  }

  /**
   * Abort solving
   */
  abort(): void {
    this.aborted = true;
  }

  /**
   * Check if hash meets difficulty
   */
  private meetsdifficulty(hash: string, difficulty: number): boolean {
    const binaryStr = BigInt('0x' + hash).toString(2).padStart(256, '0');
    let leadingZeros = 0;

    for (const bit of binaryStr) {
      if (bit === '0') {
        leadingZeros++;
      } else {
        break;
      }
    }

    return leadingZeros >= difficulty;
  }
}

/**
 * Estimate time to solve for a given difficulty
 */
export function estimateSolveTime(difficulty: number, hashesPerSecond: number = 100000): number {
  const expectedHashes = Math.pow(2, difficulty);
  return (expectedHashes / hashesPerSecond) * 1000; // ms
}
