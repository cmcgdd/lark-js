import { describe, it, expect } from 'vitest';
import { generatePushId } from '../utils/pushid';

describe('generatePushId', () => {
  it('generates 20-character IDs', () => {
    const id = generatePushId();
    expect(id).toHaveLength(20);
  });

  it('generates unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generatePushId());
    }
    expect(ids.size).toBe(1000);
  });

  it('generates sortable IDs (later IDs sort after earlier ones)', () => {
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      ids.push(generatePushId());
    }

    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  it('only uses valid characters', () => {
    const validChars = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
    for (let i = 0; i < 100; i++) {
      const id = generatePushId();
      for (const char of id) {
        expect(validChars).toContain(char);
      }
    }
  });

  it('starts with timestamp prefix (IDs generated close together share prefix)', () => {
    const id1 = generatePushId();
    const id2 = generatePushId();

    // First 8 chars are timestamp - should be the same if generated in same ms
    // or very close if generated across ms boundary
    const prefix1 = id1.substring(0, 6);
    const prefix2 = id2.substring(0, 6);
    expect(prefix1).toBe(prefix2);
  });
});
