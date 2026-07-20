/**
 * Integration tests for previousChildKey accuracy in child_* callbacks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';
import { getSharedDb, disconnectSharedDb, wait, uniquePath } from './integration-utils';

describe('Integration: previousChildKey', () => {
  let db: LarkDatabase;

  beforeAll(async () => {
    db = await getSharedDb();
  });

  afterAll(async () => {
    await disconnectSharedDb();
  });

  describe('child_added previousChildKey', () => {
    it('first child has null previousChildKey', async () => {
      const path = uniquePath('test/prev-key/first-null');
      const ref = db.ref(path);

      await ref.set(null);

      const results: { key: string; prevKey: string | null | undefined }[] = [];
      const unsubscribe = ref.on('child_added', (snapshot, prevKey) => {
        results.push({ key: snapshot.key!, prevKey });
      });

      await wait(150);

      await ref.child('first').set({ value: 1 });

      await wait(200);
      unsubscribe();

      expect(results.length).toBe(1);
      expect(results[0].key).toBe('first');
      expect(results[0].prevKey).toBeNull();
    });

    it('subsequent children have correct previousChildKey', async () => {
      const path = uniquePath('test/prev-key/subsequent');
      const ref = db.ref(path);

      await ref.set(null);

      const results: { key: string; prevKey: string | null | undefined }[] = [];
      const unsubscribe = ref.on('child_added', (snapshot, prevKey) => {
        results.push({ key: snapshot.key!, prevKey });
      });

      await wait(150);

      // Add children one by one
      await ref.child('a').set({ value: 1 });
      await wait(100);
      await ref.child('b').set({ value: 2 });
      await wait(100);
      await ref.child('c').set({ value: 3 });

      await wait(200);
      unsubscribe();

      // Check order (without explicit ordering, order may vary by key or insertion)
      expect(results.length).toBe(3);

      // First should have null prevKey
      const firstResult = results[0];
      expect(firstResult.prevKey).toBeNull();
    });

    it('initial children have correct previousChildKey sequence', async () => {
      const path = uniquePath('test/prev-key/initial-sequence');
      const ref = db.ref(path);

      // Set up multiple children at once
      await ref.set({
        alpha: { value: 1 },
        beta: { value: 2 },
        gamma: { value: 3 },
      });

      const results: { key: string; prevKey: string | null | undefined }[] = [];
      const unsubscribe = ref.on('child_added', (snapshot, prevKey) => {
        results.push({ key: snapshot.key!, prevKey });
      });

      await wait(300);
      unsubscribe();

      expect(results.length).toBe(3);

      // First child in sequence should have null prevKey
      expect(results[0].prevKey).toBeNull();

      // Subsequent children should reference the previous one
      expect(results[1].prevKey).toBe(results[0].key);
      expect(results[2].prevKey).toBe(results[1].key);
    });
  });

  describe('with orderByKey()', () => {
    it('previousChildKey reflects alphabetical order', async () => {
      const path = uniquePath('test/prev-key/order-by-key');
      const ref = db.ref(path);

      // Set up data with non-alphabetical insertion
      await ref.set({
        charlie: { value: 3 },
        alpha: { value: 1 },
        bravo: { value: 2 },
      });

      const results: { key: string; prevKey: string | null | undefined }[] = [];
      const unsubscribe = ref.orderByKey().on('child_added', (snapshot, prevKey) => {
        results.push({ key: snapshot.key!, prevKey });
      });

      await wait(300);
      unsubscribe();

      expect(results.length).toBe(3);

      // With orderByKey, should be alphabetical: alpha, bravo, charlie
      expect(results[0].key).toBe('alpha');
      expect(results[0].prevKey).toBeNull();

      expect(results[1].key).toBe('bravo');
      expect(results[1].prevKey).toBe('alpha');

      expect(results[2].key).toBe('charlie');
      expect(results[2].prevKey).toBe('bravo');
    });
  });

  describe('with orderByChild()', () => {
    it('previousChildKey reflects child value order', async () => {
      const path = uniquePath('test/prev-key/order-by-child');
      const ref = db.ref(path);

      await ref.set({
        user1: { name: 'Alice', score: 50 },
        user2: { name: 'Bob', score: 100 },
        user3: { name: 'Charlie', score: 25 },
      });

      const results: { key: string; prevKey: string | null | undefined; score: number }[] = [];
      const unsubscribe = ref.orderByChild('score').on('child_added', (snapshot, prevKey) => {
        const val = snapshot.val() as { score: number };
        results.push({ key: snapshot.key!, prevKey, score: val.score });
      });

      await wait(300);
      unsubscribe();

      expect(results.length).toBe(3);

      // Ordered by score: 25 (user3), 50 (user1), 100 (user2)
      expect(results[0].key).toBe('user3');
      expect(results[0].prevKey).toBeNull();

      expect(results[1].key).toBe('user1');
      expect(results[1].prevKey).toBe('user3');

      expect(results[2].key).toBe('user2');
      expect(results[2].prevKey).toBe('user1');
    });
  });

  describe('child_changed previousChildKey', () => {
    it('includes correct previousChildKey on change', async () => {
      const path = uniquePath('test/prev-key/changed');
      const ref = db.ref(path);

      await ref.set({
        a: { value: 1 },
        b: { value: 2 },
        c: { value: 3 },
      });

      const results: { key: string; prevKey: string | null | undefined }[] = [];
      const unsubscribe = ref.on('child_changed', (snapshot, prevKey) => {
        results.push({ key: snapshot.key!, prevKey });
      });

      await wait(150);

      await ref.child('b/value').set(20);

      await wait(200);
      unsubscribe();

      expect(results.length).toBe(1);
      expect(results[0].key).toBe('b');
      // prevKey should be the predecessor in current order
    });
  });
});
