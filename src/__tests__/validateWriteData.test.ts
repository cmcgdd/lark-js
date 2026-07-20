import { describe, it, expect } from 'vitest';
import { validateWriteData } from '../utils/validation';
import { LarkError } from '../LarkError';

describe('validateWriteData', () => {
  describe('valid data', () => {
    it('accepts primitives', () => {
      expect(() => validateWriteData('hello')).not.toThrow();
      expect(() => validateWriteData(123)).not.toThrow();
      expect(() => validateWriteData(true)).not.toThrow();
      expect(() => validateWriteData(null)).not.toThrow();
    });

    it('accepts arrays', () => {
      expect(() => validateWriteData([1, 2, 3])).not.toThrow();
      expect(() => validateWriteData(['a', 'b'])).not.toThrow();
    });

    it('accepts regular objects', () => {
      expect(() => validateWriteData({ name: 'Riley', score: 10 })).not.toThrow();
      expect(() => validateWriteData({ nested: { value: 1 } })).not.toThrow();
    });

    it('accepts objects with .priority', () => {
      expect(() => validateWriteData({ name: 'Riley', '.priority': 5 })).not.toThrow();
    });

    it('accepts wrapped primitives ({.value, .priority})', () => {
      expect(() => validateWriteData({ '.value': 'hello', '.priority': 5 })).not.toThrow();
      expect(() => validateWriteData({ '.value': 42, '.priority': 10 })).not.toThrow();
      expect(() => validateWriteData({ '.value': true, '.priority': 'high' })).not.toThrow();
      expect(() => validateWriteData({ '.value': [1, 2, 3], '.priority': 5 })).not.toThrow();
    });

    it('accepts nested objects with valid .value patterns', () => {
      expect(() => validateWriteData({
        a: { '.value': 'hello', '.priority': 1 },
        b: { '.value': 42, '.priority': 2 },
      })).not.toThrow();
    });

    it('accepts deeply nested data', () => {
      expect(() => validateWriteData({
        level1: {
          level2: {
            level3: {
              value: 'deep',
            },
          },
        },
      })).not.toThrow();
    });
  });

  describe('invalid data', () => {
    it('rejects .value with other children', () => {
      expect(() => validateWriteData({
        '.value': 'hello',
        '.priority': 5,
        foo: 'bar',
      })).toThrow(LarkError);
    });

    it('rejects .value with multiple other children', () => {
      expect(() => validateWriteData({
        '.value': 'hello',
        '.priority': 5,
        foo: 'bar',
        baz: 'qux',
      })).toThrow(LarkError);
    });

    it('rejects .value without .priority but with other children', () => {
      expect(() => validateWriteData({
        '.value': 'hello',
        foo: 'bar',
      })).toThrow(LarkError);
    });

    it('includes path in error message', () => {
      try {
        validateWriteData({
          '.value': 'hello',
          '.priority': 5,
          foo: 'bar',
        });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LarkError);
        expect((err as LarkError).code).toBe('invalid_data');
        expect((err as LarkError).message).toContain('/');
        expect((err as LarkError).message).toContain('.value');
        expect((err as LarkError).message).toContain('foo');
      }
    });

    it('detects invalid nested .value patterns', () => {
      expect(() => validateWriteData({
        users: {
          alice: {
            '.value': 'hello',
            '.priority': 1,
            extra: 'not allowed',
          },
        },
      })).toThrow(LarkError);
    });

    it('includes nested path in error message', () => {
      try {
        validateWriteData({
          users: {
            alice: {
              '.value': 'hello',
              '.priority': 1,
              extra: 'not allowed',
            },
          },
        });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LarkError);
        expect((err as LarkError).message).toContain('users/alice');
      }
    });
  });

  describe('edge cases', () => {
    it('accepts object with only .priority (no .value)', () => {
      expect(() => validateWriteData({ '.priority': 5 })).not.toThrow();
    });

    it('accepts object with only .value (no .priority)', () => {
      // This is technically valid - no other children conflict
      expect(() => validateWriteData({ '.value': 'hello' })).not.toThrow();
    });

    it('accepts empty object', () => {
      expect(() => validateWriteData({})).not.toThrow();
    });

    it('handles undefined', () => {
      expect(() => validateWriteData(undefined)).not.toThrow();
    });
  });
});
