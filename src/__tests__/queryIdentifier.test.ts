/**
 * Tests for queryIdentifier functionality.
 *
 * queryIdentifier generates a unique string for each query configuration,
 * enabling multiple queries on the same path to have separate Views.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseReference } from '../DatabaseReference';
import { LarkDatabase } from '../LarkDatabase';

// Mock LarkDatabase for testing DatabaseReference
function createMockDb(): LarkDatabase {
  return {
    _sendSet: vi.fn().mockResolvedValue(undefined),
    _sendUpdate: vi.fn().mockResolvedValue(undefined),
    _sendDelete: vi.fn().mockResolvedValue(undefined),
    _sendOnce: vi.fn().mockResolvedValue({ val: () => null }),
    _sendTransaction: vi.fn().mockResolvedValue(undefined),
    _subscribe: vi.fn().mockReturnValue(() => {}),
    _unsubscribeEventType: vi.fn(),
    _unsubscribeAll: vi.fn(),
    _getBaseUrl: vi.fn().mockReturnValue('https://db.lark.sh/test/db'),
    isVolatilePath: vi.fn().mockReturnValue(false),
  } as unknown as LarkDatabase;
}

describe('queryIdentifier', () => {
  let db: LarkDatabase;

  beforeEach(() => {
    db = createMockDb();
  });

  describe('default query', () => {
    it('returns "default" for a reference with no query constraints', () => {
      const ref = new DatabaseReference(db, '/users');
      expect(ref.queryIdentifier).toBe('default');
    });

    it('returns "default" for root reference', () => {
      const ref = new DatabaseReference(db, '/');
      expect(ref.queryIdentifier).toBe('default');
    });
  });

  describe('orderBy queries', () => {
    it('generates unique identifier for orderByKey', () => {
      const ref = new DatabaseReference(db, '/users').orderByKey();
      expect(ref.queryIdentifier).toContain('"i":".key"');
    });

    it('generates unique identifier for orderByValue', () => {
      const ref = new DatabaseReference(db, '/users').orderByValue();
      expect(ref.queryIdentifier).toContain('"i":".value"');
    });

    it('generates unique identifier for orderByPriority', () => {
      const ref = new DatabaseReference(db, '/users').orderByPriority();
      expect(ref.queryIdentifier).toContain('"i":".priority"');
    });

    it('generates unique identifier for orderByChild', () => {
      const ref = new DatabaseReference(db, '/users').orderByChild('score');
      expect(ref.queryIdentifier).toContain('"i":"score"');
    });

    it('generates unique identifier for orderByChild with nested path', () => {
      const ref = new DatabaseReference(db, '/users').orderByChild('profile/age');
      expect(ref.queryIdentifier).toContain('"i":"profile/age"');
    });
  });

  describe('limit queries', () => {
    it('generates unique identifier for limitToFirst', () => {
      const ref = new DatabaseReference(db, '/users').limitToFirst(10);
      const id = ref.queryIdentifier;
      expect(id).toContain('"l":10');
      expect(id).toContain('"vf":"l"'); // view from left
    });

    it('generates unique identifier for limitToLast', () => {
      const ref = new DatabaseReference(db, '/users').limitToLast(5);
      const id = ref.queryIdentifier;
      expect(id).toContain('"l":5');
      expect(id).toContain('"vf":"r"'); // view from right
    });
  });

  describe('range queries', () => {
    it('generates unique identifier for startAt', () => {
      const ref = new DatabaseReference(db, '/users').startAt('alice');
      const id = ref.queryIdentifier;
      expect(id).toContain('"sp":"alice"'); // start point
      expect(id).toContain('"sin":true'); // start inclusive
    });

    it('generates unique identifier for startAt with key', () => {
      const ref = new DatabaseReference(db, '/users').orderByChild('score').startAt(100, 'user1');
      const id = ref.queryIdentifier;
      expect(id).toContain('"sp":100');
      expect(id).toContain('"sn":"user1"'); // start name (key)
    });

    it('generates unique identifier for startAfter', () => {
      const ref = new DatabaseReference(db, '/users').startAfter('alice');
      const id = ref.queryIdentifier;
      expect(id).toContain('"sp":"alice"');
      expect(id).toContain('"sin":false'); // start NOT inclusive
      // Firebase uses [MAX_NAME] sentinel when no key is provided
      expect(id).toContain('"sn":"[MAX_NAME]"');
    });

    it('generates unique identifier for startAfter with key', () => {
      const ref = new DatabaseReference(db, '/users').startAfter('alice', 'user1');
      const id = ref.queryIdentifier;
      expect(id).toContain('"sp":"alice"');
      expect(id).toContain('"sn":"user1"'); // Uses provided key, not sentinel
      expect(id).toContain('"sin":false');
    });

    it('generates unique identifier for endAt', () => {
      const ref = new DatabaseReference(db, '/users').endAt('zoe');
      const id = ref.queryIdentifier;
      expect(id).toContain('"ep":"zoe"'); // end point
      expect(id).toContain('"ein":true'); // end inclusive
    });

    it('generates unique identifier for endAt with key', () => {
      const ref = new DatabaseReference(db, '/users').orderByChild('score').endAt(200, 'user2');
      const id = ref.queryIdentifier;
      expect(id).toContain('"ep":200');
      expect(id).toContain('"en":"user2"'); // end name (key)
    });

    it('generates unique identifier for endBefore', () => {
      const ref = new DatabaseReference(db, '/users').endBefore('zoe');
      const id = ref.queryIdentifier;
      expect(id).toContain('"ep":"zoe"');
      expect(id).toContain('"ein":false'); // end NOT inclusive
      // Firebase uses [MIN_NAME] sentinel when no key is provided
      expect(id).toContain('"en":"[MIN_NAME]"');
    });

    it('generates unique identifier for endBefore with key', () => {
      const ref = new DatabaseReference(db, '/users').endBefore('zoe', 'user99');
      const id = ref.queryIdentifier;
      expect(id).toContain('"ep":"zoe"');
      expect(id).toContain('"en":"user99"'); // Uses provided key, not sentinel
      expect(id).toContain('"ein":false');
    });

    it('generates unique identifier for equalTo', () => {
      const ref = new DatabaseReference(db, '/users').equalTo('admin');
      const id = ref.queryIdentifier;
      // equalTo sets both start and end to same value
      expect(id).toContain('"sp":"admin"');
      expect(id).toContain('"ep":"admin"');
      expect(id).toContain('"sin":true');
      expect(id).toContain('"ein":true');
    });

    it('generates unique identifier for equalTo with key', () => {
      const ref = new DatabaseReference(db, '/users').orderByChild('role').equalTo('admin', 'user1');
      const id = ref.queryIdentifier;
      expect(id).toContain('"sp":"admin"');
      expect(id).toContain('"ep":"admin"');
      expect(id).toContain('"sn":"user1"');
      expect(id).toContain('"en":"user1"');
    });
  });

  describe('combined queries', () => {
    it('generates unique identifier for startAt + endAt range', () => {
      const ref = new DatabaseReference(db, '/users').startAt('a').endAt('m');
      const id = ref.queryIdentifier;
      expect(id).toContain('"sp":"a"');
      expect(id).toContain('"ep":"m"');
    });

    it('generates unique identifier for orderBy + limit', () => {
      const ref = new DatabaseReference(db, '/users').orderByChild('score').limitToFirst(10);
      const id = ref.queryIdentifier;
      expect(id).toContain('"i":"score"');
      expect(id).toContain('"l":10');
    });

    it('generates unique identifier for full query', () => {
      const ref = new DatabaseReference(db, '/users')
        .orderByChild('score')
        .startAt(50)
        .endAt(100)
        .limitToFirst(10);
      const id = ref.queryIdentifier;
      expect(id).toContain('"i":"score"');
      expect(id).toContain('"sp":50');
      expect(id).toContain('"ep":100');
      expect(id).toContain('"l":10');
    });
  });

  describe('uniqueness', () => {
    it('different startAt values produce different identifiers', () => {
      const ref1 = new DatabaseReference(db, '/users').startAt('a');
      const ref2 = new DatabaseReference(db, '/users').startAt('b');
      expect(ref1.queryIdentifier).not.toBe(ref2.queryIdentifier);
    });

    it('different endAt values produce different identifiers', () => {
      const ref1 = new DatabaseReference(db, '/users').endAt('x');
      const ref2 = new DatabaseReference(db, '/users').endAt('y');
      expect(ref1.queryIdentifier).not.toBe(ref2.queryIdentifier);
    });

    it('startAt vs startAfter produce different identifiers', () => {
      const ref1 = new DatabaseReference(db, '/users').startAt('a');
      const ref2 = new DatabaseReference(db, '/users').startAfter('a');
      expect(ref1.queryIdentifier).not.toBe(ref2.queryIdentifier);
    });

    it('endAt vs endBefore produce different identifiers', () => {
      const ref1 = new DatabaseReference(db, '/users').endAt('z');
      const ref2 = new DatabaseReference(db, '/users').endBefore('z');
      expect(ref1.queryIdentifier).not.toBe(ref2.queryIdentifier);
    });

    it('different limits produce different identifiers', () => {
      const ref1 = new DatabaseReference(db, '/users').limitToFirst(5);
      const ref2 = new DatabaseReference(db, '/users').limitToFirst(10);
      expect(ref1.queryIdentifier).not.toBe(ref2.queryIdentifier);
    });

    it('limitToFirst vs limitToLast produce different identifiers', () => {
      const ref1 = new DatabaseReference(db, '/users').limitToFirst(10);
      const ref2 = new DatabaseReference(db, '/users').limitToLast(10);
      expect(ref1.queryIdentifier).not.toBe(ref2.queryIdentifier);
    });

    it('different orderBy produce different identifiers', () => {
      const ref1 = new DatabaseReference(db, '/users').orderByKey();
      const ref2 = new DatabaseReference(db, '/users').orderByValue();
      expect(ref1.queryIdentifier).not.toBe(ref2.queryIdentifier);
    });

    it('same query constraints produce same identifier', () => {
      const ref1 = new DatabaseReference(db, '/users').startAt('a').endAt('z');
      const ref2 = new DatabaseReference(db, '/users').startAt('a').endAt('z');
      expect(ref1.queryIdentifier).toBe(ref2.queryIdentifier);
    });

    it('order of chaining does not affect identifier', () => {
      // This tests that startAt then endAt produces same as endAt then startAt would
      // (if that were valid - in practice one would need to verify the final state)
      const ref1 = new DatabaseReference(db, '/users').orderByChild('score').limitToFirst(10);
      const ref2 = new DatabaseReference(db, '/users').limitToFirst(10).orderByChild('score');
      // Both should have the same query params, so same identifier
      expect(ref1.queryIdentifier).toBe(ref2.queryIdentifier);
    });
  });

  describe('on() passes queryIdentifier to _subscribe', () => {
    it('passes "default" for non-query reference', () => {
      const ref = new DatabaseReference(db, '/users');
      ref.on('value', () => {});
      expect(db._subscribe).toHaveBeenCalledWith('/users', 'value', expect.any(Function), undefined, 'default');
    });

    it('passes query identifier for query reference', () => {
      const ref = new DatabaseReference(db, '/users').startAt('a').endAt('z');
      const expectedId = ref.queryIdentifier;
      ref.on('value', () => {});
      expect(db._subscribe).toHaveBeenCalledWith('/users', 'value', expect.any(Function), expect.any(Object), expectedId);
    });

    it('different queries on same path pass different identifiers', () => {
      const ref1 = new DatabaseReference(db, '/users').startAt('a').endAt('m');
      const ref2 = new DatabaseReference(db, '/users').startAt('n').endAt('z');

      ref1.on('value', () => {});
      ref2.on('value', () => {});

      const calls = (db._subscribe as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][4]).not.toBe(calls[1][4]); // queryIdentifiers should differ
    });
  });

  describe('Firebase wire format compatibility', () => {
    // These tests verify exact format compatibility with Firebase's queryIdentifier

    it('startAt with key matches Firebase format', () => {
      const ref = new DatabaseReference(db, '/users').startAt('pri', 'name');
      expect(ref.queryIdentifier).toBe('{"sin":true,"sn":"name","sp":"pri"}');
    });

    it('startAfter with key matches Firebase format', () => {
      const ref = new DatabaseReference(db, '/users').startAfter('pri', 'name');
      expect(ref.queryIdentifier).toBe('{"sin":false,"sn":"name","sp":"pri"}');
    });

    it('endAt with key matches Firebase format', () => {
      const ref = new DatabaseReference(db, '/users').endAt('pri', 'name');
      expect(ref.queryIdentifier).toBe('{"ein":true,"en":"name","ep":"pri"}');
    });

    it('endBefore with key matches Firebase format', () => {
      const ref = new DatabaseReference(db, '/users').endBefore('pri', 'name');
      expect(ref.queryIdentifier).toBe('{"ein":false,"en":"name","ep":"pri"}');
    });

    it('startAt + endAt without keys matches Firebase format', () => {
      const ref = new DatabaseReference(db, '/users').startAt('spri').endAt('epri');
      expect(ref.queryIdentifier).toBe('{"ein":true,"ep":"epri","sin":true,"sp":"spri"}');
    });

    it('startAt + endBefore without keys uses [MIN_NAME] sentinel', () => {
      const ref = new DatabaseReference(db, '/users').startAt('spri').endBefore('epri');
      expect(ref.queryIdentifier).toBe('{"ein":false,"en":"[MIN_NAME]","ep":"epri","sin":true,"sp":"spri"}');
    });

    it('startAfter + endAt without keys uses [MAX_NAME] sentinel', () => {
      const ref = new DatabaseReference(db, '/users').startAfter('spri').endAt('epri');
      expect(ref.queryIdentifier).toBe('{"ein":true,"ep":"epri","sin":false,"sn":"[MAX_NAME]","sp":"spri"}');
    });

    it('startAfter + endBefore without keys uses both sentinels', () => {
      const ref = new DatabaseReference(db, '/users').startAfter('spri').endBefore('epri');
      expect(ref.queryIdentifier).toBe('{"ein":false,"en":"[MIN_NAME]","ep":"epri","sin":false,"sn":"[MAX_NAME]","sp":"spri"}');
    });

    it('startAt with key + endAt with key matches Firebase format', () => {
      const ref = new DatabaseReference(db, '/users').startAt('spri', 'sname').endAt('epri', 'ename');
      expect(ref.queryIdentifier).toBe('{"ein":true,"en":"ename","ep":"epri","sin":true,"sn":"sname","sp":"spri"}');
    });

    it('startAt + limitToFirst matches Firebase format', () => {
      const ref = new DatabaseReference(db, '/users').startAt('pri').limitToFirst(100);
      expect(ref.queryIdentifier).toBe('{"l":100,"sin":true,"sp":"pri","vf":"l"}');
    });

    it('startAfter + limitToFirst uses [MAX_NAME] sentinel', () => {
      const ref = new DatabaseReference(db, '/users').startAfter('pri').limitToFirst(100);
      expect(ref.queryIdentifier).toBe('{"l":100,"sin":false,"sn":"[MAX_NAME]","sp":"pri","vf":"l"}');
    });

    it('endAt + limitToLast matches Firebase format', () => {
      const ref = new DatabaseReference(db, '/users').endAt('pri').limitToLast(100);
      expect(ref.queryIdentifier).toBe('{"ein":true,"ep":"pri","l":100,"vf":"r"}');
    });

    it('endBefore + limitToLast uses [MIN_NAME] sentinel', () => {
      const ref = new DatabaseReference(db, '/users').endBefore('pri').limitToLast(100);
      expect(ref.queryIdentifier).toBe('{"ein":false,"en":"[MIN_NAME]","ep":"pri","l":100,"vf":"r"}');
    });

    it('startAt + orderByChild matches Firebase format', () => {
      const ref = new DatabaseReference(db, '/users').startAt('bar').orderByChild('foo');
      expect(ref.queryIdentifier).toBe('{"i":"foo","sin":true,"sp":"bar"}');
    });

    it('startAfter + orderByChild uses [MAX_NAME] sentinel', () => {
      const ref = new DatabaseReference(db, '/users').startAfter('bar').orderByChild('foo');
      expect(ref.queryIdentifier).toBe('{"i":"foo","sin":false,"sn":"[MAX_NAME]","sp":"bar"}');
    });

    it('endAt + orderByChild matches Firebase format', () => {
      const ref = new DatabaseReference(db, '/users').endAt('bar').orderByChild('foo');
      expect(ref.queryIdentifier).toBe('{"ein":true,"ep":"bar","i":"foo"}');
    });

    it('endBefore + orderByChild uses [MIN_NAME] sentinel', () => {
      const ref = new DatabaseReference(db, '/users').endBefore('bar').orderByChild('foo');
      expect(ref.queryIdentifier).toBe('{"ein":false,"en":"[MIN_NAME]","ep":"bar","i":"foo"}');
    });
  });
});
