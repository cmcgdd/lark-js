import { describe, it, expect } from 'vitest';
import { coerceArrays } from '../utils/coerce';

describe('coerceArrays', () => {
  it('renders a dense integer-keyed object as an array', () => {
    expect(coerceArrays({ '0': 'a', '1': 'b', '2': 'c' })).toEqual(['a', 'b', 'c']);
  });

  it('fills gaps with null', () => {
    // {0,2}: maxKey 2 < 2*2 -> array
    expect(coerceArrays({ '0': 'x', '2': 'z' })).toEqual(['x', null, 'z']);
    // {1}: maxKey 1 < 2*1 -> array, leading gap is null
    expect(coerceArrays({ '1': 'y' })).toEqual([null, 'y']);
  });

  describe('threshold maxKey < 2*numKeys', () => {
    it('n=2 max=3 -> array', () => {
      expect(coerceArrays({ '0': 'a', '3': 'd' })).toEqual(['a', null, null, 'd']);
    });
    it('n=2 max=4 -> object', () => {
      expect(coerceArrays({ '0': 'a', '4': 'e' })).toEqual({ '0': 'a', '4': 'e' });
    });
    it('n=3 max=5 -> array', () => {
      expect(coerceArrays({ '0': 'a', '1': 'b', '5': 'f' })).toEqual([
        'a',
        'b',
        null,
        null,
        null,
        'f',
      ]);
    });
    it('n=3 max=6 -> object', () => {
      expect(coerceArrays({ '0': 'a', '1': 'b', '6': 'g' })).toEqual({
        '0': 'a',
        '1': 'b',
        '6': 'g',
      });
    });
  });

  describe('non-canonical keys stay objects', () => {
    it('leading zeros', () => {
      expect(coerceArrays({ '01': 'a', '02': 'b' })).toEqual({ '01': 'a', '02': 'b' });
    });
    it('negative key', () => {
      expect(coerceArrays({ '-1': 'a', '0': 'b' })).toEqual({ '-1': 'a', '0': 'b' });
    });
    it('mixed integer and string keys', () => {
      expect(coerceArrays({ '0': 'a', x: 'b' })).toEqual({ '0': 'a', x: 'b' });
    });
  });

  it('recurses into nested integer-keyed objects', () => {
    expect(coerceArrays({ items: { '0': { '0': 'a', '1': 'b' }, '1': 'c' } })).toEqual({
      items: [['a', 'b'], 'c'],
    });
  });

  it('passes arrays through, coercing their elements', () => {
    expect(coerceArrays([{ '0': 'a', '1': 'b' }, 'c'])).toEqual([['a', 'b'], 'c']);
  });

  it('leaves primitives and empty objects unchanged', () => {
    expect(coerceArrays('hello')).toBe('hello');
    expect(coerceArrays(42)).toBe(42);
    expect(coerceArrays(null)).toBe(null);
    expect(coerceArrays({})).toEqual({});
  });
});
