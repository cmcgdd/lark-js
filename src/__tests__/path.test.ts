import { describe, it, expect } from 'vitest';
import {
  normalizePath,
  joinPath,
  getParentPath,
  getKey,
  isValidPath,
  getValueAtPath,
  setValueAtPath,
} from '../utils/path';

describe('normalizePath', () => {
  it('returns "/" for root paths', () => {
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('/')).toBe('/');
  });

  it('adds leading slash and removes trailing slashes', () => {
    expect(normalizePath('/foo')).toBe('/foo');
    expect(normalizePath('foo/')).toBe('/foo');
    expect(normalizePath('/foo/')).toBe('/foo');
    expect(normalizePath('foo')).toBe('/foo');
    expect(normalizePath('/foo/bar/')).toBe('/foo/bar');
  });

  it('collapses multiple slashes', () => {
    expect(normalizePath('foo//bar')).toBe('/foo/bar');
    expect(normalizePath('//foo//bar//')).toBe('/foo/bar');
  });

  it('handles complex paths', () => {
    expect(normalizePath('/players/abc/score')).toBe('/players/abc/score');
    expect(normalizePath('players/abc/score')).toBe('/players/abc/score');
  });
});

describe('joinPath', () => {
  it('joins segments with slashes', () => {
    expect(joinPath('foo', 'bar')).toBe('/foo/bar');
    expect(joinPath('foo', 'bar', 'baz')).toBe('/foo/bar/baz');
  });

  it('handles empty segments', () => {
    expect(joinPath('', 'foo')).toBe('/foo');
    expect(joinPath('foo', '')).toBe('/foo');
    expect(joinPath('', '')).toBe('/');
  });

  it('handles root segments', () => {
    expect(joinPath('/', 'foo')).toBe('/foo');
    expect(joinPath('foo', '/')).toBe('/foo');
  });

  it('normalizes segments', () => {
    expect(joinPath('/foo/', '/bar/')).toBe('/foo/bar');
    expect(joinPath('players', '/abc/score')).toBe('/players/abc/score');
  });
});

describe('getParentPath', () => {
  it('returns "/" for root', () => {
    expect(getParentPath('')).toBe('/');
    expect(getParentPath('/')).toBe('/');
  });

  it('returns "/" for single segment', () => {
    expect(getParentPath('foo')).toBe('/');
    expect(getParentPath('/foo')).toBe('/');
  });

  it('returns parent for multi-segment paths', () => {
    expect(getParentPath('foo/bar')).toBe('/foo');
    expect(getParentPath('/foo/bar')).toBe('/foo');
    expect(getParentPath('foo/bar/baz')).toBe('/foo/bar');
  });
});

describe('getKey', () => {
  it('returns null for root', () => {
    expect(getKey('')).toBe(null);
    expect(getKey('/')).toBe(null);
  });

  it('returns the segment for single-segment paths', () => {
    expect(getKey('foo')).toBe('foo');
    expect(getKey('/foo')).toBe('foo');
  });

  it('returns last segment for multi-segment paths', () => {
    expect(getKey('foo/bar')).toBe('bar');
    expect(getKey('/foo/bar/baz')).toBe('baz');
  });
});

describe('isValidPath', () => {
  it('accepts valid paths', () => {
    expect(isValidPath('')).toBe(true);
    expect(isValidPath('/')).toBe(true);
    expect(isValidPath('foo')).toBe(true);
    expect(isValidPath('foo/bar')).toBe(true);
    expect(isValidPath('players/abc123/score')).toBe(true);
  });

  it('rejects paths with invalid characters', () => {
    expect(isValidPath('foo.bar')).toBe(false);
    expect(isValidPath('foo$bar')).toBe(false);
    expect(isValidPath('foo#bar')).toBe(false);
    expect(isValidPath('foo[bar')).toBe(false);
    expect(isValidPath('foo]bar')).toBe(false);
  });
});

describe('getValueAtPath', () => {
  const data = {
    players: {
      abc: { name: 'Riley', score: 10 },
      def: { name: 'Alex', score: 5 },
    },
    settings: {
      volume: 80,
    },
  };

  it('returns root for empty path', () => {
    expect(getValueAtPath(data, '')).toBe(data);
    expect(getValueAtPath(data, '/')).toBe(data);
  });

  it('returns nested values', () => {
    expect(getValueAtPath(data, 'players')).toEqual(data.players);
    expect(getValueAtPath(data, '/players')).toEqual(data.players);
    expect(getValueAtPath(data, 'players/abc')).toEqual(data.players.abc);
    expect(getValueAtPath(data, '/players/abc/name')).toBe('Riley');
    expect(getValueAtPath(data, 'settings/volume')).toBe(80);
  });

  it('returns undefined for non-existent paths', () => {
    expect(getValueAtPath(data, 'nonexistent')).toBe(undefined);
    expect(getValueAtPath(data, 'players/xyz')).toBe(undefined);
    expect(getValueAtPath(data, 'players/abc/missing')).toBe(undefined);
  });

  it('handles null and undefined', () => {
    expect(getValueAtPath(null, 'foo')).toBe(undefined);
    expect(getValueAtPath(undefined, 'foo')).toBe(undefined);
  });
});

describe('setValueAtPath', () => {
  it('sets top-level values', () => {
    const obj: Record<string, unknown> = {};
    setValueAtPath(obj, 'foo', 'bar');
    expect(obj.foo).toBe('bar');
  });

  it('sets nested values', () => {
    const obj: Record<string, unknown> = {};
    setValueAtPath(obj, 'foo/bar/baz', 123);
    expect((obj.foo as Record<string, unknown>).bar).toEqual({ baz: 123 });
  });

  it('creates intermediate objects', () => {
    const obj: Record<string, unknown> = {};
    setValueAtPath(obj, 'a/b/c/d', 'value');
    expect(obj).toEqual({ a: { b: { c: { d: 'value' } } } });
  });

  it('overwrites existing values', () => {
    const obj: Record<string, unknown> = { foo: 'old' };
    setValueAtPath(obj, 'foo', 'new');
    expect(obj.foo).toBe('new');
  });
});
