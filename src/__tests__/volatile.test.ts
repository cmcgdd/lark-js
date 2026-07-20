import { describe, it, expect } from 'vitest';
import { isVolatilePath } from '../utils/volatile';

describe('isVolatilePath', () => {
  describe('basic matching', () => {
    it('returns false when patterns is null', () => {
      expect(isVolatilePath('/players/abc/position', null)).toBe(false);
    });

    it('returns false when patterns is undefined', () => {
      expect(isVolatilePath('/players/abc/position', undefined)).toBe(false);
    });

    it('returns false when patterns is empty array', () => {
      expect(isVolatilePath('/players/abc/position', [])).toBe(false);
    });

    it('matches exact path without wildcards', () => {
      expect(isVolatilePath('/game/state', ['game/state'])).toBe(true);
    });

    it('does not match different exact paths', () => {
      expect(isVolatilePath('/game/config', ['game/state'])).toBe(false);
    });
  });

  describe('wildcard matching', () => {
    it('matches single wildcard segment', () => {
      const patterns = ['players/*/position'];

      expect(isVolatilePath('/players/abc/position', patterns)).toBe(true);
      expect(isVolatilePath('/players/xyz/position', patterns)).toBe(true);
      expect(isVolatilePath('/players/123/position', patterns)).toBe(true);
    });

    it('does not match when wildcard segment is missing', () => {
      const patterns = ['players/*/position'];

      // Too few segments
      expect(isVolatilePath('/players/position', patterns)).toBe(false);
    });

    it('matches descendants (extra segments)', () => {
      const patterns = ['players/*/position'];

      // Descendants of a volatile path are also volatile
      expect(isVolatilePath('/players/abc/position/extra', patterns)).toBe(true);
      expect(isVolatilePath('/players/abc/position/x/y/z', patterns)).toBe(true);
    });

    it('matches multiple wildcards', () => {
      const patterns = ['game/*/players/*/score'];

      expect(isVolatilePath('/game/123/players/abc/score', patterns)).toBe(true);
      expect(isVolatilePath('/game/xyz/players/def/score', patterns)).toBe(true);
    });

    it('matches wildcard at start of pattern', () => {
      const patterns = ['*/players/count'];

      expect(isVolatilePath('/game1/players/count', patterns)).toBe(true);
      expect(isVolatilePath('/game2/players/count', patterns)).toBe(true);
    });

    it('matches wildcard at end of pattern', () => {
      const patterns = ['players/abc/*'];

      expect(isVolatilePath('/players/abc/position', patterns)).toBe(true);
      expect(isVolatilePath('/players/abc/rotation', patterns)).toBe(true);
      expect(isVolatilePath('/players/abc/health', patterns)).toBe(true);
    });
  });

  describe('multiple patterns', () => {
    it('matches if any pattern matches', () => {
      const patterns = ['players/*/position', 'players/*/rotation', 'game/state'];

      expect(isVolatilePath('/players/abc/position', patterns)).toBe(true);
      expect(isVolatilePath('/players/xyz/rotation', patterns)).toBe(true);
      expect(isVolatilePath('/game/state', patterns)).toBe(true);
    });

    it('returns false if no pattern matches', () => {
      const patterns = ['players/*/position', 'players/*/rotation'];

      expect(isVolatilePath('/players/abc/health', patterns)).toBe(false);
      expect(isVolatilePath('/game/state', patterns)).toBe(false);
    });
  });

  describe('path normalization', () => {
    it('handles paths with leading slash', () => {
      expect(isVolatilePath('/players/abc/position', ['players/*/position'])).toBe(true);
    });

    it('handles paths without leading slash', () => {
      expect(isVolatilePath('players/abc/position', ['players/*/position'])).toBe(true);
    });
  });

  describe('descendant matching', () => {
    it('matches exact path', () => {
      expect(isVolatilePath('/__volatile__', ['__volatile__'])).toBe(true);
    });

    it('matches descendants of pattern', () => {
      expect(isVolatilePath('/__volatile__/test', ['__volatile__'])).toBe(true);
      expect(isVolatilePath('/__volatile__/a/b/c', ['__volatile__'])).toBe(true);
    });

    it('does not match unrelated paths', () => {
      expect(isVolatilePath('/other/path', ['__volatile__'])).toBe(false);
      expect(isVolatilePath('/volatile', ['__volatile__'])).toBe(false);
    });

    it('does not match ancestors of pattern', () => {
      // /players is an ancestor of players/*/position, not a match
      expect(isVolatilePath('/players', ['players/*/position'])).toBe(false);
      expect(isVolatilePath('/players/abc', ['players/*/position'])).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('does not match root path against non-empty pattern', () => {
      expect(isVolatilePath('/', ['players/*/position'])).toBe(false);
    });

    it('matches single segment pattern', () => {
      expect(isVolatilePath('/volatile', ['volatile'])).toBe(true);
      expect(isVolatilePath('/other', ['volatile'])).toBe(false);
    });

    it('matches single wildcard pattern', () => {
      expect(isVolatilePath('/anything', ['*'])).toBe(true);
      expect(isVolatilePath('/foo', ['*'])).toBe(true);
    });

    it('matches multi-segment path against single wildcard (descendant)', () => {
      // * matches one segment, and descendants of that match are also volatile
      expect(isVolatilePath('/foo/bar', ['*'])).toBe(true);
      expect(isVolatilePath('/foo/bar/baz', ['*'])).toBe(true);
    });
  });
});
