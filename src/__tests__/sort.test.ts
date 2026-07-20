import { describe, it, expect } from 'vitest';
import {
  typeRank,
  compareValues,
  isInt32Key,
  compareKeys,
  getSortValue,
  compareEntries,
  sortEntries,
  createSortEntries,
  getSortedKeys,
  SortEntry,
} from '../utils/sort';

describe('Sort Utilities', () => {
  describe('typeRank', () => {
    it('ranks null as 0', () => {
      expect(typeRank(null)).toBe(0);
      expect(typeRank(undefined)).toBe(0);
    });

    it('ranks false as 1', () => {
      expect(typeRank(false)).toBe(1);
    });

    it('ranks true as 2', () => {
      expect(typeRank(true)).toBe(2);
    });

    it('ranks numbers as 3', () => {
      expect(typeRank(0)).toBe(3);
      expect(typeRank(-100)).toBe(3);
      expect(typeRank(3.14)).toBe(3);
      expect(typeRank(Infinity)).toBe(3);
    });

    it('ranks strings as 4', () => {
      expect(typeRank('')).toBe(4);
      expect(typeRank('hello')).toBe(4);
    });

    it('ranks objects as 5', () => {
      expect(typeRank({})).toBe(5);
      expect(typeRank({ a: 1 })).toBe(5);
      expect(typeRank([])).toBe(5);
    });
  });

  describe('compareValues', () => {
    it('compares different types by rank', () => {
      expect(compareValues(null, false)).toBe(-1);
      expect(compareValues(false, true)).toBe(-1);
      expect(compareValues(true, 0)).toBe(-1);
      expect(compareValues(0, 'a')).toBe(-1);
      expect(compareValues('a', {})).toBe(-1);
    });

    it('compares numbers', () => {
      expect(compareValues(1, 2)).toBe(-1);
      expect(compareValues(2, 1)).toBe(1);
      expect(compareValues(1, 1)).toBe(0);
      expect(compareValues(-10, 10)).toBe(-1);
      expect(compareValues(0, 0)).toBe(0);
    });

    it('compares strings lexicographically', () => {
      expect(compareValues('a', 'b')).toBe(-1);
      expect(compareValues('b', 'a')).toBe(1);
      expect(compareValues('apple', 'banana')).toBe(-1);
      expect(compareValues('10', '2')).toBe(-1); // String comparison, not numeric
      expect(compareValues('hello', 'hello')).toBe(0);
    });

    it('treats objects as equal', () => {
      expect(compareValues({}, {})).toBe(0);
      expect(compareValues({ a: 1 }, { b: 2 })).toBe(0);
      expect(compareValues([], [])).toBe(0);
    });

    it('treats nulls as equal', () => {
      expect(compareValues(null, null)).toBe(0);
      expect(compareValues(undefined, undefined)).toBe(0);
      expect(compareValues(null, undefined)).toBe(0);
    });
  });

  describe('isInt32Key', () => {
    it('accepts valid integer keys', () => {
      expect(isInt32Key('0')).toBe(true);
      expect(isInt32Key('1')).toBe(true);
      expect(isInt32Key('42')).toBe(true);
      expect(isInt32Key('-1')).toBe(true);
      expect(isInt32Key('-100')).toBe(true);
      expect(isInt32Key('2147483647')).toBe(true); // Max int32
      expect(isInt32Key('-2147483648')).toBe(true); // Min int32
    });

    it('rejects keys outside int32 range', () => {
      expect(isInt32Key('2147483648')).toBe(false); // Exceeds max
      expect(isInt32Key('-2147483649')).toBe(false); // Exceeds min
      expect(isInt32Key('9999999999')).toBe(false);
    });

    it('rejects keys with leading zeros', () => {
      expect(isInt32Key('007')).toBe(false);
      expect(isInt32Key('00')).toBe(false);
      expect(isInt32Key('01')).toBe(false);
    });

    it('rejects negative zero', () => {
      expect(isInt32Key('-0')).toBe(false);
    });

    it('rejects non-integer strings', () => {
      expect(isInt32Key('1.5')).toBe(false);
      expect(isInt32Key('1e10')).toBe(false);
      expect(isInt32Key('abc')).toBe(false);
      expect(isInt32Key('-Lxyz123')).toBe(false); // Push ID
      expect(isInt32Key('')).toBe(false);
      expect(isInt32Key('-')).toBe(false);
    });
  });

  describe('compareKeys', () => {
    it('sorts integer keys numerically', () => {
      expect(compareKeys('1', '2')).toBe(-1);
      expect(compareKeys('2', '1')).toBe(1);
      expect(compareKeys('10', '2')).toBe(1); // Numeric, not string comparison
      expect(compareKeys('-10', '-1')).toBe(-1);
      expect(compareKeys('-1', '1')).toBe(-1);
    });

    it('sorts integers before strings', () => {
      expect(compareKeys('1', 'abc')).toBe(-1);
      expect(compareKeys('abc', '1')).toBe(1);
      expect(compareKeys('-1', 'abc')).toBe(-1);
    });

    it('sorts string keys lexicographically', () => {
      expect(compareKeys('abc', 'def')).toBe(-1);
      expect(compareKeys('def', 'abc')).toBe(1);
      expect(compareKeys('abc', 'abc')).toBe(0);
      expect(compareKeys('007', 'abc')).toBe(-1); // Both strings (007 has leading zero)
    });

    it('matches Firebase test vector', () => {
      // From FIREBASE_SORTING.md
      const keys = ['10', '2', '1', '-1', '007', 'abc', '-10', '0', ''];
      const sorted = [...keys].sort(compareKeys);
      expect(sorted).toEqual(['-10', '-1', '0', '1', '2', '10', '', '007', 'abc']);
    });
  });

  describe('getSortValue', () => {
    it('returns null for orderByKey', () => {
      expect(getSortValue({ name: 'test' }, { orderBy: 'key' })).toBe(null);
    });

    it('returns priority when no queryParams (Firebase default)', () => {
      // Firebase default behavior: sort by priority when no query
      expect(getSortValue({ name: 'test', '.priority': 5 }, null)).toBe(5);
      expect(getSortValue({ name: 'test' }, null)).toBe(undefined); // No priority
    });

    it('returns value for orderByValue', () => {
      expect(getSortValue('hello', { orderBy: 'value' })).toBe('hello');
      expect(getSortValue(42, { orderBy: 'value' })).toBe(42);
    });

    it('returns nested value for orderByChild', () => {
      expect(getSortValue({ score: 100 }, { orderByChild: 'score' })).toBe(100);
      expect(getSortValue({ user: { name: 'Alice' } }, { orderByChild: 'user/name' })).toBe('Alice');
      expect(getSortValue({ name: 'test' }, { orderByChild: 'score' })).toBe(undefined);
    });

    it('returns .priority for orderByPriority', () => {
      expect(getSortValue({ '.priority': 5 }, { orderBy: 'priority' })).toBe(5);
      expect(getSortValue({ name: 'test' }, { orderBy: 'priority' })).toBe(undefined);
    });
  });

  describe('compareEntries', () => {
    it('compares by key when no query params', () => {
      const a: SortEntry = { key: '1', value: { z: 1 }, sortValue: null };
      const b: SortEntry = { key: '2', value: { a: 1 }, sortValue: null };
      expect(compareEntries(a, b, null)).toBe(-1);
    });

    it('compares by sort value when orderByChild', () => {
      const a: SortEntry = { key: 'z', value: { score: 100 }, sortValue: 100 };
      const b: SortEntry = { key: 'a', value: { score: 50 }, sortValue: 50 };
      expect(compareEntries(a, b, { orderByChild: 'score' })).toBe(1); // 100 > 50
    });

    it('tie-breaks by key when sort values are equal', () => {
      const a: SortEntry = { key: 'alice', value: { score: 100 }, sortValue: 100 };
      const b: SortEntry = { key: 'bob', value: { score: 100 }, sortValue: 100 };
      expect(compareEntries(a, b, { orderByChild: 'score' })).toBe(-1); // alice < bob
    });
  });

  describe('sortEntries', () => {
    it('sorts by key when no query params', () => {
      const entries: SortEntry[] = [
        { key: 'c', value: 1, sortValue: null },
        { key: 'a', value: 2, sortValue: null },
        { key: 'b', value: 3, sortValue: null },
      ];
      sortEntries(entries, null);
      expect(entries.map((e) => e.key)).toEqual(['a', 'b', 'c']);
    });

    it('sorts by value when orderByChild', () => {
      const entries: SortEntry[] = [
        { key: 'a', value: { score: 100 }, sortValue: 100 },
        { key: 'b', value: { score: 50 }, sortValue: 50 },
        { key: 'c', value: { score: 75 }, sortValue: 75 },
      ];
      sortEntries(entries, { orderByChild: 'score' });
      expect(entries.map((e) => e.key)).toEqual(['b', 'c', 'a']);
    });

    it('handles mixed types correctly', () => {
      const entries: SortEntry[] = [
        { key: 'a', value: {}, sortValue: null },
        { key: 'b', value: {}, sortValue: false },
        { key: 'c', value: {}, sortValue: true },
        { key: 'd', value: {}, sortValue: -10 },
        { key: 'e', value: {}, sortValue: 0 },
        { key: 'f', value: {}, sortValue: 10 },
        { key: 'g', value: {}, sortValue: 'apple' },
        { key: 'h', value: {}, sortValue: 'banana' },
        { key: 'i', value: {}, sortValue: {} },
      ];
      sortEntries(entries, { orderByChild: 'score' });
      expect(entries.map((e) => e.key)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
    });
  });

  describe('createSortEntries', () => {
    it('creates entries from object', () => {
      const data = { a: 1, b: 2, c: 3 };
      const entries = createSortEntries(data, null);
      expect(entries.map((e) => e.key)).toEqual(['a', 'b', 'c']);
    });

    it('excludes .priority from entries', () => {
      const data = { a: 1, '.priority': 5, b: 2 };
      const entries = createSortEntries(data, null);
      expect(entries.map((e) => e.key)).toEqual(['a', 'b']);
    });

    it('returns empty for non-objects', () => {
      expect(createSortEntries(null, null)).toEqual([]);
      expect(createSortEntries('string', null)).toEqual([]);
      expect(createSortEntries([1, 2, 3], null)).toEqual([]);
    });
  });

  describe('getSortedKeys', () => {
    it('returns keys in sorted order', () => {
      const data = { c: 1, a: 2, b: 3 };
      expect(getSortedKeys(data, null)).toEqual(['a', 'b', 'c']);
    });

    it('sorts by child value', () => {
      const data = {
        alice: { score: 100 },
        bob: { score: 50 },
        charlie: { score: 75 },
      };
      expect(getSortedKeys(data, { orderByChild: 'score' })).toEqual(['bob', 'charlie', 'alice']);
    });

    it('matches Firebase test vector for mixed types', () => {
      // From FIREBASE_SORTING.md
      const data = {
        a: { score: null },
        b: { score: false },
        c: { score: true },
        d: { score: -10 },
        e: { score: 0 },
        f: { score: 10 },
        g: { score: 'hello' },
        h: { score: 'world' },
        i: { score: {} },
        j: {}, // No score key = null
      };
      const sorted = getSortedKeys(data, { orderByChild: 'score' });
      expect(sorted).toEqual(['a', 'j', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
    });

    it('tie-breaks by key', () => {
      const data = {
        charlie: { score: 100 },
        alice: { score: 100 },
        bob: { score: 100 },
      };
      expect(getSortedKeys(data, { orderByChild: 'score' })).toEqual(['alice', 'bob', 'charlie']);
    });
  });
});
