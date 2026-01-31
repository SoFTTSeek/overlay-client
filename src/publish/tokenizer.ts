/**
 * Tokenizer with normalization and stopwords
 * PRD Section 5.7 - Search correctness improvements
 */

import type { FileExtension } from '../types.js';

/**
 * Common English stopwords to filter out
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that',
  'the', 'to', 'was', 'were', 'will', 'with', 'the', 'this', 'but',
  'they', 'have', 'had', 'what', 'when', 'where', 'who', 'which',
  'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'can', 'should', 'now',
  // File-specific stopwords
  'mp3', 'flac', 'wav', 'mp4', 'mkv', 'avi', 'jpg', 'png', 'pdf',
  'www', 'http', 'https', 'com', 'org', 'net',
]);

/**
 * Minimum token length (shorter tokens are too common)
 */
const MIN_TOKEN_LENGTH = 2;

/**
 * Maximum token length (prevent abuse)
 */
const MAX_TOKEN_LENGTH = 64;

/**
 * Unicode normalization and diacritics removal map
 */
const DIACRITICS_MAP: Record<string, string> = {
  'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a', 'æ': 'ae',
  'ç': 'c', 'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e',
  'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i',
  'ñ': 'n', 'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o', 'ø': 'o',
  'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u',
  'ý': 'y', 'ÿ': 'y', 'ß': 'ss',
};

/**
 * Remove diacritics from a string
 */
function removeDiacritics(str: string): string {
  // First use Unicode normalization (NFD decomposes characters)
  let normalized = str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Then apply manual mapping for any remaining special chars
  normalized = normalized.toLowerCase().split('').map(char =>
    DIACRITICS_MAP[char] || char
  ).join('');

  return normalized;
}

/**
 * Check if a token is a stopword
 */
export function isStopword(token: string): boolean {
  return STOPWORDS.has(token.toLowerCase());
}

/**
 * Normalize a token for indexing/searching
 * - Lowercase
 * - Remove diacritics
 * - Trim whitespace
 */
export function normalizeToken(str: string): string {
  return removeDiacritics(str.toLowerCase()).trim();
}

/**
 * Normalize a string for tokenization
 * - Lowercase
 * - Remove diacritics
 * - Remove non-alphanumeric (keep numbers for things like "128kbps")
 */
function normalizeString(str: string): string {
  let result = removeDiacritics(str.toLowerCase());

  // Replace non-alphanumeric with spaces (preserves word boundaries)
  result = result.replace(/[^a-z0-9]/g, ' ');

  // Collapse multiple spaces
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}

/**
 * Check if a token is valid (not a stopword, proper length)
 */
function isValidToken(token: string): boolean {
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
    return false;
  }
  if (STOPWORDS.has(token)) {
    return false;
  }
  // Must contain at least one letter (pure numbers like "123" are too generic)
  if (!/[a-z]/.test(token)) {
    return false;
  }
  return true;
}

/**
 * Extract tokens from a filename
 */
export function tokenizeFilename(filename: string): string[] {
  // Remove extension
  const withoutExt = filename.replace(/\.[^.]+$/, '');

  // Normalize
  const normalized = normalizeString(withoutExt);

  // Split and filter
  const tokens = normalized
    .split(' ')
    .filter(isValidToken);

  // Deduplicate while preserving order
  return [...new Set(tokens)];
}

/**
 * Extract tokens from a directory path
 */
export function tokenizePath(path: string): string[] {
  // Split by path separators
  const segments = path.split(/[/\\]/);

  // Tokenize each segment
  const tokens: string[] = [];
  for (const segment of segments) {
    const segmentTokens = tokenizeFilename(segment);
    tokens.push(...segmentTokens);
  }

  // Deduplicate
  return [...new Set(tokens)];
}

/**
 * Result of tokenization
 */
export interface TokenizationResult {
  /** All unique tokens */
  tokens: string[];
  /** Tokens from filename only (higher weight) */
  filenameTokens: string[];
  /** Tokens from path only */
  pathTokens: string[];
  /** File extension */
  ext: FileExtension;
}

/**
 * Tokenize a file for indexing
 * Extracts tokens from filename, path, and extension
 */
export function tokenizeFile(
  filePath: string,
  filename: string,
  ext: FileExtension
): TokenizationResult {
  const filenameTokens = tokenizeFilename(filename);
  const pathTokens = tokenizePath(filePath);

  // Combine all tokens
  const allTokens = new Set<string>([...filenameTokens, ...pathTokens]);

  return {
    tokens: [...allTokens],
    filenameTokens,
    pathTokens,
    ext,
  };
}

/**
 * Tokenize a search query
 * Similar to file tokenization but preserves order for phrase matching
 */
export function tokenizeQuery(query: string): string[] {
  const normalized = normalizeString(query);
  return normalized
    .split(' ')
    .filter(token => token.length >= MIN_TOKEN_LENGTH && token.length <= MAX_TOKEN_LENGTH);
}

/**
 * Check if tokens form a phrase match
 * Used for phrase boost in ranking
 */
export function isPhraseMatch(queryTokens: string[], fileTokens: string[]): boolean {
  if (queryTokens.length < 2) return false;

  const fileTokenStr = ' ' + fileTokens.join(' ') + ' ';
  const queryTokenStr = ' ' + queryTokens.join(' ') + ' ';

  return fileTokenStr.includes(queryTokenStr);
}

/**
 * Calculate token match score
 * Higher score for exact matches and phrase matches
 */
export function calculateTokenScore(
  queryTokens: string[],
  filenameTokens: string[],
  pathTokens: string[]
): number {
  let score = 0;

  // Filename matches are worth more
  const filenameSet = new Set(filenameTokens);
  const pathSet = new Set(pathTokens);

  for (const token of queryTokens) {
    if (filenameSet.has(token)) {
      score += 10; // High weight for filename match
    } else if (pathSet.has(token)) {
      score += 3; // Lower weight for path match
    }
  }

  // Phrase bonus
  if (isPhraseMatch(queryTokens, filenameTokens)) {
    score += 20;
  }

  // Normalize by query length
  return score / queryTokens.length;
}

/**
 * Get the rarest token from a list (for rare-first query strategy)
 * This is a heuristic based on token length (longer = rarer)
 */
export function getRarestToken(tokens: string[]): string | null {
  if (tokens.length === 0) return null;

  // Simple heuristic: longer tokens and tokens with numbers are usually rarer
  return tokens.reduce((rarest, token) => {
    const rarestScore = rarest.length + ((/\d/.test(rarest)) ? 5 : 0);
    const tokenScore = token.length + ((/\d/.test(token)) ? 5 : 0);
    return tokenScore > rarestScore ? token : rarest;
  });
}

/**
 * Parse file extension from filename
 */
export function parseExtension(filename: string): FileExtension {
  const match = filename.match(/\.([^.]+)$/);
  if (!match) return 'other';

  const ext = match[1].toLowerCase();

  // Map to known extensions
  const knownExts: Record<string, FileExtension> = {
    'mp3': 'mp3', 'flac': 'flac', 'wav': 'wav', 'aac': 'aac',
    'ogg': 'ogg', 'opus': 'opus', 'wma': 'wma', 'm4a': 'm4a', 'aiff': 'aiff',
    'mp4': 'mp4', 'mkv': 'mkv', 'avi': 'avi', 'mov': 'mov',
    'wmv': 'wmv', 'webm': 'webm',
    'jpg': 'jpg', 'jpeg': 'jpeg', 'png': 'png', 'gif': 'gif',
    'webp': 'webp', 'bmp': 'bmp', 'tiff': 'tiff',
    'pdf': 'pdf', 'epub': 'epub', 'mobi': 'mobi', 'txt': 'txt',
    'doc': 'doc', 'docx': 'docx',
    'zip': 'zip', 'rar': 'rar', '7z': '7z', 'tar': 'tar', 'gz': 'gz',
  };

  return knownExts[ext] || 'other';
}

/**
 * Truncate filename to fit in posting (max 96 bytes)
 */
export function truncateFilename(filename: string, maxBytes: number = 96): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(filename);

  if (bytes.length <= maxBytes) {
    return filename;
  }

  // Binary search for the right length
  let low = 0;
  let high = filename.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const truncated = filename.slice(0, mid);
    if (encoder.encode(truncated).length <= maxBytes - 3) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return filename.slice(0, low) + '...';
}
