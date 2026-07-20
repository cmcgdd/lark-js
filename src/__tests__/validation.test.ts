import { describe, it, expect } from 'vitest';
import { validateKey, validatePath, validateWriteData, validateValue } from '../utils/validation';
import { LarkError } from '../LarkError';

describe('validateKey', () => {
  describe('valid keys', () => {
    it('accepts alphanumeric keys', () => {
      expect(() => validateKey('abc123')).not.toThrow();
      expect(() => validateKey('user_name')).not.toThrow();
      expect(() => validateKey('test-key')).not.toThrow();
    });

    it('accepts Unicode keys', () => {
      expect(() => validateKey('日本語')).not.toThrow();
      expect(() => validateKey('émoji')).not.toThrow();
      expect(() => validateKey('مرحبا')).not.toThrow();
    });

    it('accepts keys up to 768 bytes', () => {
      const longKey = 'a'.repeat(768);
      expect(() => validateKey(longKey)).not.toThrow();
    });
  });

  describe('invalid keys', () => {
    it('rejects keys with .', () => {
      expect(() => validateKey('foo.bar')).toThrow(LarkError);
      expect(() => validateKey('.foo')).toThrow(LarkError);
    });

    it('rejects keys with $', () => {
      expect(() => validateKey('$foo')).toThrow(LarkError);
      expect(() => validateKey('foo$bar')).toThrow(LarkError);
    });

    it('rejects keys with #', () => {
      expect(() => validateKey('#foo')).toThrow(LarkError);
    });

    it('rejects keys with []', () => {
      expect(() => validateKey('[foo]')).toThrow(LarkError);
      expect(() => validateKey('foo[0]')).toThrow(LarkError);
    });

    it('rejects keys with /', () => {
      expect(() => validateKey('foo/bar')).toThrow(LarkError);
    });

    it('rejects keys with control characters', () => {
      expect(() => validateKey('foo\x00bar')).toThrow(LarkError);
      expect(() => validateKey('foo\nbar')).toThrow(LarkError);
      expect(() => validateKey('foo\tbar')).toThrow(LarkError);
      expect(() => validateKey('foo\x7fbar')).toThrow(LarkError);
    });

    it('rejects keys over 768 bytes', () => {
      const tooLongKey = 'a'.repeat(769);
      expect(() => validateKey(tooLongKey)).toThrow(LarkError);
    });

    it('rejects empty keys', () => {
      expect(() => validateKey('')).toThrow(LarkError);
    });
  });
});

describe('validatePath', () => {
  describe('valid paths', () => {
    it('accepts empty path', () => {
      expect(() => validatePath('')).not.toThrow();
    });

    it('accepts root path', () => {
      expect(() => validatePath('/')).not.toThrow();
    });

    it('accepts simple paths', () => {
      expect(() => validatePath('users')).not.toThrow();
      expect(() => validatePath('/users')).not.toThrow();
      expect(() => validatePath('users/alice')).not.toThrow();
      expect(() => validatePath('/users/alice/profile')).not.toThrow();
    });

    it('allows .priority and .value in paths (internal use)', () => {
      expect(() => validatePath('.priority')).not.toThrow();
      expect(() => validatePath('users/.priority')).not.toThrow();
      expect(() => validatePath('.value')).not.toThrow();
    });
  });

  describe('invalid paths', () => {
    it('rejects paths with invalid segments', () => {
      expect(() => validatePath('users/foo.bar')).toThrow(LarkError);
      expect(() => validatePath('users/$invalid')).toThrow(LarkError);
    });
  });
});

describe('validateValue', () => {
  describe('string values allow control characters', () => {
    it('accepts strings with null character', () => {
      expect(() => validateValue('hello\x00world')).not.toThrow();
    });

    it('accepts strings with newline', () => {
      expect(() => validateValue('hello\nworld')).not.toThrow();
    });

    it('accepts strings with tab', () => {
      expect(() => validateValue('hello\tworld')).not.toThrow();
    });

    it('accepts strings with DEL character', () => {
      expect(() => validateValue('hello\x7fworld')).not.toThrow();
    });

    it('accepts normal strings', () => {
      expect(() => validateValue('hello world')).not.toThrow();
      expect(() => validateValue('special chars: @!%^&*()')).not.toThrow();
    });
  });

  describe('nested values', () => {
    it('validates strings in nested objects', () => {
      expect(() => validateValue({
        user: {
          name: 'valid',
        },
      })).not.toThrow();

      // Control characters are allowed in string values
      expect(() => validateValue({
        user: {
          name: 'has\x00null',
        },
      })).not.toThrow();
    });

    it('validates strings in arrays', () => {
      expect(() => validateValue(['valid', 'strings'])).not.toThrow();
      // Control characters are allowed in string values
      expect(() => validateValue(['valid', 'has\x00null'])).not.toThrow();
    });
  });

  describe('object keys', () => {
    it('validates keys in objects', () => {
      expect(() => validateValue({ 'valid-key': 'value' })).not.toThrow();
      expect(() => validateValue({ 'invalid.key': 'value' })).toThrow(LarkError);
      expect(() => validateValue({ '$invalid': 'value' })).toThrow(LarkError);
    });

    it('rejects keys with control characters', () => {
      expect(() => validateValue({ 'key\x00null': 'value' })).toThrow(LarkError);
      expect(() => validateValue({ 'key\nline': 'value' })).toThrow(LarkError);
    });
  });
});
