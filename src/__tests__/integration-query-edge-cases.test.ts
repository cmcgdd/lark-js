/**
 * Integration tests for query edge cases.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';
import { getSharedDb, disconnectSharedDb, wait, uniquePath } from './integration-utils';

describe('Integration: Query Edge Cases', () => {
  let db: LarkDatabase;

  beforeAll(async () => {
    db = await getSharedDb();
  });

  afterAll(async () => {
    await disconnectSharedDb();
  });

  describe('limitToFirst', () => {
    it('only first N children fire child_added events', async () => {
      const path = uniquePath('test/query-edge/limit-first');
      const ref = db.ref(path);

      await ref.set({
        a: { order: 1 },
        b: { order: 2 },
        c: { order: 3 },
        d: { order: 4 },
        e: { order: 5 },
      });

      const addedKeys: string[] = [];
      const unsubscribe = ref
        .orderByChild('order')
        .limitToFirst(3)
        .on('child_added', (snapshot) => {
          addedKeys.push(snapshot.key!);
        });

      await wait(300);
      unsubscribe();

      // Should only have first 3 by order
      expect(addedKeys.length).toBe(3);
      expect(addedKeys).toContain('a');
      expect(addedKeys).toContain('b');
      expect(addedKeys).toContain('c');
      expect(addedKeys).not.toContain('d');
      expect(addedKeys).not.toContain('e');
    });

    it('value event only includes limited children', async () => {
      const path = uniquePath('test/query-edge/limit-first-value');
      const ref = db.ref(path);

      await ref.set({
        a: 1,
        b: 2,
        c: 3,
        d: 4,
        e: 5,
      });

      let receivedValue: unknown = null;
      const unsubscribe = ref
        .orderByKey()
        .limitToFirst(2)
        .on('value', (snapshot) => {
          receivedValue = snapshot.val();
        });

      await wait(300);
      unsubscribe();

      // Should only have first 2 by key
      expect(receivedValue).toEqual({ a: 1, b: 2 });
    });
  });

  describe('limitToLast', () => {
    it('only last N children fire child_added events', async () => {
      const path = uniquePath('test/query-edge/limit-last');
      const ref = db.ref(path);

      await ref.set({
        a: { order: 1 },
        b: { order: 2 },
        c: { order: 3 },
        d: { order: 4 },
        e: { order: 5 },
      });

      const addedKeys: string[] = [];
      const unsubscribe = ref
        .orderByChild('order')
        .limitToLast(3)
        .on('child_added', (snapshot) => {
          addedKeys.push(snapshot.key!);
        });

      await wait(300);
      unsubscribe();

      // Should only have last 3 by order
      expect(addedKeys.length).toBe(3);
      expect(addedKeys).toContain('c');
      expect(addedKeys).toContain('d');
      expect(addedKeys).toContain('e');
      expect(addedKeys).not.toContain('a');
      expect(addedKeys).not.toContain('b');
    });
  });

  describe('startAt/endAt filtering', () => {
    it('startAt filters to items >= value', async () => {
      const path = uniquePath('test/query-edge/start-at');
      const ref = db.ref(path);

      await ref.set({
        user1: { score: 10 },
        user2: { score: 50 },
        user3: { score: 75 },
        user4: { score: 100 },
      });

      const addedKeys: string[] = [];
      const unsubscribe = ref
        .orderByChild('score')
        .startAt(50)
        .on('child_added', (snapshot) => {
          addedKeys.push(snapshot.key!);
        });

      await wait(300);
      unsubscribe();

      // Should only have scores >= 50
      expect(addedKeys).toContain('user2');
      expect(addedKeys).toContain('user3');
      expect(addedKeys).toContain('user4');
      expect(addedKeys).not.toContain('user1');
    });

    it('endAt filters to items <= value', async () => {
      const path = uniquePath('test/query-edge/end-at');
      const ref = db.ref(path);

      await ref.set({
        user1: { score: 10 },
        user2: { score: 50 },
        user3: { score: 75 },
        user4: { score: 100 },
      });

      const addedKeys: string[] = [];
      const unsubscribe = ref
        .orderByChild('score')
        .endAt(75)
        .on('child_added', (snapshot) => {
          addedKeys.push(snapshot.key!);
        });

      await wait(300);
      unsubscribe();

      // Should only have scores <= 75
      expect(addedKeys).toContain('user1');
      expect(addedKeys).toContain('user2');
      expect(addedKeys).toContain('user3');
      expect(addedKeys).not.toContain('user4');
    });

    it('startAt + endAt creates a range', async () => {
      const path = uniquePath('test/query-edge/range');
      const ref = db.ref(path);

      await ref.set({
        a: { value: 1 },
        b: { value: 5 },
        c: { value: 10 },
        d: { value: 15 },
        e: { value: 20 },
      });

      const addedKeys: string[] = [];
      const unsubscribe = ref
        .orderByChild('value')
        .startAt(5)
        .endAt(15)
        .on('child_added', (snapshot) => {
          addedKeys.push(snapshot.key!);
        });

      await wait(300);
      unsubscribe();

      // Should only have values in [5, 15]
      expect(addedKeys).toContain('b');
      expect(addedKeys).toContain('c');
      expect(addedKeys).toContain('d');
      expect(addedKeys).not.toContain('a');
      expect(addedKeys).not.toContain('e');
    });
  });

  describe('equalTo filtering', () => {
    it('only matching children fire events', async () => {
      const path = uniquePath('test/query-edge/equal-to');
      const ref = db.ref(path);

      await ref.set({
        user1: { status: 'active' },
        user2: { status: 'inactive' },
        user3: { status: 'active' },
        user4: { status: 'pending' },
      });

      const addedKeys: string[] = [];
      const unsubscribe = ref
        .orderByChild('status')
        .equalTo('active')
        .on('child_added', (snapshot) => {
          addedKeys.push(snapshot.key!);
        });

      await wait(300);
      unsubscribe();

      expect(addedKeys).toContain('user1');
      expect(addedKeys).toContain('user3');
      expect(addedKeys).not.toContain('user2');
      expect(addedKeys).not.toContain('user4');
    });

    it('equalTo with number value', async () => {
      const path = uniquePath('test/query-edge/equal-to-number');
      const ref = db.ref(path);

      await ref.set({
        item1: { category: 1 },
        item2: { category: 2 },
        item3: { category: 1 },
        item4: { category: 3 },
      });

      const addedKeys: string[] = [];
      const unsubscribe = ref
        .orderByChild('category')
        .equalTo(1)
        .on('child_added', (snapshot) => {
          addedKeys.push(snapshot.key!);
        });

      await wait(300);
      unsubscribe();

      expect(addedKeys).toContain('item1');
      expect(addedKeys).toContain('item3');
      expect(addedKeys.length).toBe(2);
    });
  });

  describe('child exits query range', () => {
    it('fires child_removed when child no longer matches query', async () => {
      const path = uniquePath('test/query-edge/exit-range');
      const ref = db.ref(path);

      await ref.set({
        user1: { score: 50 },
        user2: { score: 60 },
        user3: { score: 70 },
      });

      const removedKeys: string[] = [];
      const unsubscribe = ref
        .orderByChild('score')
        .startAt(50)
        .on('child_removed', (snapshot) => {
          removedKeys.push(snapshot.key!);
        });

      await wait(200);

      // Change user1's score to be below range
      await ref.child('user1/score').set(30);

      await wait(300);
      unsubscribe();

      // user1 should appear as removed (exited the query)
      expect(removedKeys).toContain('user1');
    });
  });

  describe('child enters query range', () => {
    it('fires child_added when child enters query range', async () => {
      const path = uniquePath('test/query-edge/enter-range');
      const ref = db.ref(path);

      await ref.set({
        user1: { score: 30 },
        user2: { score: 60 },
        user3: { score: 70 },
      });

      let initialLoad = true;
      const addedAfterInitial: string[] = [];
      const unsubscribe = ref
        .orderByChild('score')
        .startAt(50)
        .on('child_added', (snapshot) => {
          if (!initialLoad) {
            addedAfterInitial.push(snapshot.key!);
          }
        });

      await wait(200);
      initialLoad = false;

      // Change user1's score to be in range
      await ref.child('user1/score').set(80);

      await wait(300);
      unsubscribe();

      // user1 should appear as added (entered the query)
      expect(addedAfterInitial).toContain('user1');
    });
  });

  describe('orderByKey with string ranges', () => {
    it('startAt with key string', async () => {
      const path = uniquePath('test/query-edge/key-range');
      const ref = db.ref(path);

      await ref.set({
        alpha: { value: 1 },
        beta: { value: 2 },
        gamma: { value: 3 },
        delta: { value: 4 },
      });

      const addedKeys: string[] = [];
      const unsubscribe = ref
        .orderByKey()
        .startAt('delta')
        .on('child_added', (snapshot) => {
          addedKeys.push(snapshot.key!);
        });

      await wait(300);
      unsubscribe();

      // Keys >= 'delta' alphabetically
      expect(addedKeys).toContain('delta');
      expect(addedKeys).toContain('gamma');
      expect(addedKeys).not.toContain('alpha');
      expect(addedKeys).not.toContain('beta');
    });
  });

  describe('combined query modifiers', () => {
    it('orderByChild + startAt + limitToFirst', async () => {
      const path = uniquePath('test/query-edge/combined');
      const ref = db.ref(path);

      await ref.set({
        a: { priority: 1 },
        b: { priority: 5 },
        c: { priority: 10 },
        d: { priority: 15 },
        e: { priority: 20 },
      });

      const addedKeys: string[] = [];
      const unsubscribe = ref
        .orderByChild('priority')
        .startAt(5)
        .limitToFirst(2)
        .on('child_added', (snapshot) => {
          addedKeys.push(snapshot.key!);
        });

      await wait(300);
      unsubscribe();

      // First 2 with priority >= 5: b (5), c (10)
      expect(addedKeys.length).toBe(2);
      expect(addedKeys).toContain('b');
      expect(addedKeys).toContain('c');
    });
  });

  describe('empty query results', () => {
    it('value event returns null when no matches', async () => {
      const path = uniquePath('test/query-edge/empty-result');
      const ref = db.ref(path);

      await ref.set({
        user1: { score: 10 },
        user2: { score: 20 },
      });

      let receivedValue: unknown = 'not-set';
      const unsubscribe = ref
        .orderByChild('score')
        .startAt(100)
        .on('value', (snapshot) => {
          receivedValue = snapshot.val();
        });

      await wait(300);
      unsubscribe();

      // No children match, should be null
      expect(receivedValue).toBeNull();
    });

    it('value transitions from null to object when child enters range', async () => {
      const path = uniquePath('test/query-edge/null-to-object');
      const ref = db.ref(path);

      // All scores below threshold
      await ref.set({
        user1: { score: 10 },
        user2: { score: 20 },
      });

      const values: unknown[] = [];
      const unsubscribe = ref
        .orderByChild('score')
        .startAt(100) // No matches initially
        .on('value', (snapshot) => {
          values.push(snapshot.val());
        });

      await wait(200);

      // Initial should be null
      expect(values[0]).toBeNull();

      // Now update score to enter range
      await ref.child('user1/score').set(150);

      await wait(300);
      unsubscribe();

      // Should have transitioned to object
      const lastValue = values[values.length - 1] as Record<string, unknown>;
      expect(lastValue).not.toBeNull();
      expect(lastValue).toHaveProperty('user1');
    });
  });

  describe('queryParams update mid-subscription', () => {
    it('re-sorts data when second subscription has different orderByChild', async () => {
      const path = uniquePath('test/query-edge/params-update');
      const ref = db.ref(path);

      await ref.set({
        alice: { name: 'Alice', score: 30 },
        bob: { name: 'Bob', score: 10 },
        charlie: { name: 'Charlie', score: 20 },
      });

      // First subscription: orderByChild('score')
      const scoreOrderKeys: string[] = [];
      const unsub1 = ref.orderByChild('score').on('child_added', (snapshot) => {
        scoreOrderKeys.push(snapshot.key!);
      });

      await wait(300);

      // Should be ordered by score: bob (10), charlie (20), alice (30)
      expect(scoreOrderKeys).toEqual(['bob', 'charlie', 'alice']);

      // Second subscription: orderByChild('name') - should update queryParams
      const nameOrderKeys: string[] = [];
      const unsub2 = ref.orderByChild('name').on('child_added', (snapshot) => {
        nameOrderKeys.push(snapshot.key!);
      });

      await wait(300);

      // Should now be ordered by name: alice, bob, charlie
      expect(nameOrderKeys).toEqual(['alice', 'bob', 'charlie']);

      unsub1();
      unsub2();
    });

    it('clears queryParams when second subscription has no query', async () => {
      const path = uniquePath('test/query-edge/params-clear');
      const ref = db.ref(path);

      await ref.set({
        z: { value: 1 },
        a: { value: 2 },
        m: { value: 3 },
      });

      // First subscription: orderByChild('value')
      const orderedKeys: string[] = [];
      const unsub1 = ref.orderByChild('value').on('child_added', (snapshot) => {
        orderedKeys.push(snapshot.key!);
      });

      await wait(300);

      // Should be ordered by value: z (1), a (2), m (3)
      expect(orderedKeys).toEqual(['z', 'a', 'm']);

      // Second subscription: no query (should revert to key order)
      const keyOrderKeys: string[] = [];
      const unsub2 = ref.on('child_added', (snapshot) => {
        keyOrderKeys.push(snapshot.key!);
      });

      await wait(300);

      // Should now be ordered by key: a, m, z
      expect(keyOrderKeys).toEqual(['a', 'm', 'z']);

      unsub1();
      unsub2();
    });
  });

  describe('nested orderByChild paths', () => {
    it('sorts by deeply nested field', async () => {
      const path = uniquePath('test/query-edge/nested-order');
      const ref = db.ref(path);

      await ref.set({
        user1: { profile: { stats: { score: 50 } } },
        user2: { profile: { stats: { score: 10 } } },
        user3: { profile: { stats: { score: 30 } } },
      });

      const orderedKeys: string[] = [];
      const unsubscribe = ref
        .orderByChild('profile/stats/score')
        .on('child_added', (snapshot) => {
          orderedKeys.push(snapshot.key!);
        });

      await wait(300);
      unsubscribe();

      // Should be ordered by nested score: user2 (10), user3 (30), user1 (50)
      expect(orderedKeys).toEqual(['user2', 'user3', 'user1']);
    });

    it('fires child_moved when nested sort field changes', async () => {
      const path = uniquePath('test/query-edge/nested-moved');
      const ref = db.ref(path);

      await ref.set({
        user1: { profile: { score: 10 } },
        user2: { profile: { score: 20 } },
        user3: { profile: { score: 30 } },
      });

      const movedEvents: { key: string; prevKey: string | null }[] = [];
      const unsubscribe = ref
        .orderByChild('profile/score')
        .on('child_moved', (snapshot, prevKey) => {
          movedEvents.push({ key: snapshot.key!, prevKey: prevKey ?? null });
        });

      await wait(300);
      movedEvents.length = 0; // Clear initial events

      // Update nested score to cause reorder
      await ref.child('user1/profile/score').set(100);

      await wait(400);
      unsubscribe();

      // user1 should have moved to the end
      expect(movedEvents.some(e => e.key === 'user1' && e.prevKey === 'user3')).toBe(true);
    });
  });

  describe('integer vs string key sorting', () => {
    it('integer keys sort numerically before string keys', async () => {
      const path = uniquePath('test/query-edge/int-keys');
      const ref = db.ref(path);

      // Mix of integer-like and string keys
      await ref.set({
        '10': { value: 'ten' },
        '2': { value: 'two' },
        'abc': { value: 'abc' },
        '1': { value: 'one' },
        'xyz': { value: 'xyz' },
      });

      const orderedKeys: string[] = [];
      const unsubscribe = ref.orderByKey().on('child_added', (snapshot) => {
        orderedKeys.push(snapshot.key!);
      });

      await wait(300);
      unsubscribe();

      // Integer keys sort numerically first (1, 2, 10), then string keys alphabetically (abc, xyz)
      expect(orderedKeys).toEqual(['1', '2', '10', 'abc', 'xyz']);
    });

    it('large integer keys sort correctly', async () => {
      const path = uniquePath('test/query-edge/large-int-keys');
      const ref = db.ref(path);

      await ref.set({
        '1000000': { value: 'million' },
        '100': { value: 'hundred' },
        '10000': { value: 'ten-thousand' },
      });

      const orderedKeys: string[] = [];
      const unsubscribe = ref.orderByKey().on('child_added', (snapshot) => {
        orderedKeys.push(snapshot.key!);
      });

      await wait(300);
      unsubscribe();

      // Should sort numerically: 100, 10000, 1000000
      expect(orderedKeys).toEqual(['100', '10000', '1000000']);
    });
  });
});
