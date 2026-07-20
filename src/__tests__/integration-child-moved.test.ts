/**
 * Integration tests for child_moved events with ordered queries.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';
import { getSharedDb, disconnectSharedDb, wait, uniquePath } from './integration-utils';

describe('Integration: child_moved Events', () => {
  let db: LarkDatabase;

  beforeAll(async () => {
    db = await getSharedDb();
  });

  afterAll(async () => {
    await disconnectSharedDb();
  });

  describe('with orderByChild()', () => {
    it('fires child_moved when value changes causing reorder', async () => {
      const path = uniquePath('test/moved/order-by-child');
      const ref = db.ref(path);

      await ref.set({
        user1: { name: 'Alice', score: 10 },
        user2: { name: 'Bob', score: 20 },
        user3: { name: 'Charlie', score: 30 },
      });

      const movedEvents: { key: string; prevKey: string | null | undefined }[] = [];
      const unsubscribe = ref.orderByChild('score').on('child_moved', (snapshot, prevKey) => {
        movedEvents.push({ key: snapshot.key!, prevKey });
      });

      await wait(200);

      // Change user1's score to be highest
      await ref.child('user1/score').set(100);

      await wait(300);
      unsubscribe();

      // user1 should have moved
      const user1Move = movedEvents.find((m) => m.key === 'user1');
      expect(user1Move).toBeDefined();
      // user1 should now be after user3 (previously after nobody)
      expect(user1Move?.prevKey).toBe('user3');
    });

    it('includes correct new previousChildKey', async () => {
      const path = uniquePath('test/moved/prev-key');
      const ref = db.ref(path);

      await ref.set({
        a: { priority: 1 },
        b: { priority: 2 },
        c: { priority: 3 },
        d: { priority: 4 },
      });

      const movedEvents: { key: string; prevKey: string | null | undefined }[] = [];
      const unsubscribe = ref.orderByChild('priority').on('child_moved', (snapshot, prevKey) => {
        movedEvents.push({ key: snapshot.key!, prevKey });
      });

      await wait(200);

      // Move 'a' to after 'c' (priority 3.5)
      await ref.child('a/priority').set(3.5);

      await wait(300);
      unsubscribe();

      const aMove = movedEvents.find((m) => m.key === 'a');
      expect(aMove).toBeDefined();
      expect(aMove?.prevKey).toBe('c'); // Now after c, before d
    });

    it('does NOT fire child_moved when value changes but order stays same', async () => {
      const path = uniquePath('test/moved/no-reorder');
      const ref = db.ref(path);

      await ref.set({
        low: { score: 10 },
        mid: { score: 50 },
        high: { score: 100 },
      });

      const movedEvents: string[] = [];
      const changedEvents: string[] = [];

      const unsub1 = ref.orderByChild('score').on('child_moved', (snapshot) => {
        movedEvents.push(snapshot.key!);
      });
      const unsub2 = ref.orderByChild('score').on('child_changed', (snapshot) => {
        changedEvents.push(snapshot.key!);
      });

      await wait(200);

      // Change mid's score but keep it in the middle (between 10 and 100)
      await ref.child('mid/score').set(60);

      await wait(300);
      unsub1();
      unsub2();

      // child_changed should fire, but not child_moved
      expect(changedEvents).toContain('mid');
      expect(movedEvents).not.toContain('mid');
    });
  });

  describe('with orderByKey()', () => {
    it('child_moved does not fire (keys dont change)', async () => {
      const path = uniquePath('test/moved/order-by-key');
      const ref = db.ref(path);

      await ref.set({
        alpha: { value: 1 },
        beta: { value: 2 },
        gamma: { value: 3 },
      });

      const movedEvents: string[] = [];
      const unsubscribe = ref.orderByKey().on('child_moved', (snapshot) => {
        movedEvents.push(snapshot.key!);
      });

      await wait(150);

      // Change values - keys stay same so order stays same
      await ref.child('alpha/value').set(100);
      await ref.child('gamma/value').set(0);

      await wait(200);
      unsubscribe();

      // No moves should happen with orderByKey
      expect(movedEvents.length).toBe(0);
    });
  });

  describe('with orderByValue()', () => {
    it('fires child_moved when primitive values change order', async () => {
      const path = uniquePath('test/moved/order-by-value');
      const ref = db.ref(path);

      await ref.set({
        a: 10,
        b: 20,
        c: 30,
      });

      const movedEvents: { key: string; prevKey: string | null | undefined }[] = [];
      const unsubscribe = ref.orderByValue().on('child_moved', (snapshot, prevKey) => {
        movedEvents.push({ key: snapshot.key!, prevKey });
      });

      await wait(200);

      // Change 'a' to be largest
      await ref.child('a').set(100);

      await wait(300);
      unsubscribe();

      const aMove = movedEvents.find((m) => m.key === 'a');
      expect(aMove).toBeDefined();
      expect(aMove?.prevKey).toBe('c'); // Now last (after c)
    });
  });

  describe('with limits', () => {
    it('child_moved fires correctly with limitToFirst', async () => {
      const path = uniquePath('test/moved/limit-first');
      const ref = db.ref(path);

      await ref.set({
        user1: { score: 10 },
        user2: { score: 20 },
        user3: { score: 30 },
        user4: { score: 40 },
        user5: { score: 50 },
      });

      const movedEvents: string[] = [];
      const unsubscribe = ref
        .orderByChild('score')
        .limitToFirst(3)
        .on('child_moved', (snapshot) => {
          movedEvents.push(snapshot.key!);
        });

      await wait(200);

      // Make user1 have score 25 (between user2 and user3)
      await ref.child('user1/score').set(25);

      await wait(300);
      unsubscribe();

      // user1 should have moved within the top 3
      expect(movedEvents).toContain('user1');
    });
  });

  describe('multiple moves', () => {
    it('handles multiple children moving in sequence', async () => {
      const path = uniquePath('test/moved/multiple');
      const ref = db.ref(path);

      await ref.set({
        a: { order: 1 },
        b: { order: 2 },
        c: { order: 3 },
      });

      const movedKeys: string[] = [];
      const unsubscribe = ref.orderByChild('order').on('child_moved', (snapshot) => {
        movedKeys.push(snapshot.key!);
      });

      await wait(200);

      // Move a to end
      await ref.child('a/order').set(4);
      await wait(150);

      // Move b to end
      await ref.child('b/order').set(5);

      await wait(300);
      unsubscribe();

      expect(movedKeys).toContain('a');
      expect(movedKeys).toContain('b');
    });
  });

  describe('move to first position', () => {
    it('child_moved with null previousChildKey when moving to first', async () => {
      const path = uniquePath('test/moved/to-first');
      const ref = db.ref(path);

      await ref.set({
        a: { priority: 10 },
        b: { priority: 20 },
        c: { priority: 30 },
      });

      const movedEvents: { key: string; prevKey: string | null | undefined }[] = [];
      const unsubscribe = ref.orderByChild('priority').on('child_moved', (snapshot, prevKey) => {
        movedEvents.push({ key: snapshot.key!, prevKey });
      });

      await wait(200);

      // Move c to first position
      await ref.child('c/priority').set(1);

      await wait(300);
      unsubscribe();

      const cMove = movedEvents.find((m) => m.key === 'c');
      expect(cMove).toBeDefined();
      expect(cMove?.prevKey).toBeNull(); // First position = null prevKey
    });
  });
});
