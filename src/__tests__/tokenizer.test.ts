/**
 * Tests for Tokenizer Module
 */

import { describe, it, expect } from 'vitest';
import {
  tokenizeFilename,
  tokenizeQuery,
  normalizeToken,
  isStopword,
  getRarestToken,
  calculateTokenScore,
} from '../publish/tokenizer.js';

describe('Tokenizer', () => {
  describe('normalizeToken', () => {
    it('should convert to lowercase', () => {
      expect(normalizeToken('HELLO')).toBe('hello');
    });

    it('should handle unicode normalization', () => {
      expect(normalizeToken('café')).toBe('cafe');
    });

    it('should trim whitespace', () => {
      expect(normalizeToken('  hello  ')).toBe('hello');
    });
  });

  describe('isStopword', () => {
    it('should identify common stopwords', () => {
      expect(isStopword('the')).toBe(true);
      expect(isStopword('and')).toBe(true);
      expect(isStopword('a')).toBe(true);
    });

    it('should not flag non-stopwords', () => {
      expect(isStopword('album')).toBe(false);
      expect(isStopword('beatles')).toBe(false);
    });
  });

  describe('tokenizeFilename', () => {
    it('should tokenize filenames with common separators', () => {
      const tokens = tokenizeFilename('Artist - Album - Track.mp3');
      expect(tokens).toContain('artist');
      expect(tokens).toContain('album');
      expect(tokens).toContain('track');
    });

    it('should handle underscores and dots', () => {
      const tokens = tokenizeFilename('great_file.name.txt');
      expect(tokens).toContain('great'); // 'some' is a stopword
      expect(tokens).toContain('file');
      expect(tokens).toContain('name');
    });

    it('should handle parentheses and brackets', () => {
      const tokens = tokenizeFilename('Track (Remix) [2024ver].mp3');
      expect(tokens).toContain('track');
      expect(tokens).toContain('remix');
      expect(tokens).toContain('2024ver'); // Pure numbers like '2024' are filtered (must contain a letter)
    });

    it('should filter short tokens', () => {
      const tokens = tokenizeFilename('a b efg');
      expect(tokens).not.toContain('a'); // Too short (< 2)
      expect(tokens).not.toContain('b'); // Too short (< 2)
      expect(tokens).toContain('efg');
      // Note: 'cd' (2 chars) would pass MIN_TOKEN_LENGTH=2
    });

    it('should filter stopwords', () => {
      const tokens = tokenizeFilename('The Best of Music');
      expect(tokens).not.toContain('the');
      expect(tokens).not.toContain('of');
      expect(tokens).toContain('best');
      expect(tokens).toContain('music');
    });
  });

  describe('tokenizeQuery', () => {
    it('should tokenize search queries', () => {
      const tokens = tokenizeQuery('beatles abbey road');
      expect(tokens).toContain('beatles');
      expect(tokens).toContain('abbey');
      expect(tokens).toContain('road');
    });

    it('should handle quoted phrases', () => {
      const tokens = tokenizeQuery('"abbey road" beatles');
      expect(tokens).toContain('abbey');
      expect(tokens).toContain('road');
      expect(tokens).toContain('beatles');
    });
  });

  describe('getRarestToken', () => {
    it('should return longest token as heuristic for rarity', () => {
      const tokens = ['a', 'abc', 'abcdef'];
      expect(getRarestToken(tokens)).toBe('abcdef');
    });

    it('should handle empty array', () => {
      expect(getRarestToken([])).toBeNull();
    });
  });

  describe('calculateTokenScore', () => {
    it('should score exact matches higher', () => {
      const queryTokens = ['beatles', 'abbey'];
      const filenameTokens = ['beatles', 'abbey', 'road'];
      const pathTokens: string[] = [];

      const score = calculateTokenScore(queryTokens, filenameTokens, pathTokens);
      expect(score).toBeGreaterThan(0);
    });

    it('should score zero for no matches', () => {
      const queryTokens = ['foo', 'bar'];
      const filenameTokens = ['baz', 'qux'];

      const score = calculateTokenScore(queryTokens, filenameTokens, []);
      expect(score).toBe(0);
    });
  });
});
