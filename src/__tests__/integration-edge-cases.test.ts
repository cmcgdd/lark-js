/**
 * Integration tests for edge cases.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';
import { DataSnapshot } from '../DataSnapshot';
import { getSharedDb, disconnectSharedDb, wait, uniquePath } from './integration-utils';

describe('Integration: Edge Cases', () => {
  let db: LarkDatabase;

  beforeAll(async () => {
    db = await getSharedDb();
  });

  afterAll(async () => {
    await disconnectSharedDb();
  });

  describe('empty initial data', () => {
    it('subscribe to path with no children, child_added fires when first child added', async () => {
      const path = uniquePath('test/edge/empty-initial');
      const ref = db.ref(path);

      await ref.set(null); // Ensure empty

      const addedKeys: string[] = [];
      const unsubscribe = ref.on('child_added', (snapshot) => {
        addedKeys.push(snapshot.key!);
      });

      await wait(150);

      // Initially should have no children
      expect(addedKeys.length).toBe(0);

      // Add first child
      await ref.child('firstChild').set({ value: 1 });

      await wait(200);
      unsubscribe();

      expect(addedKeys).toContain('firstChild');
    });

    it('value event returns null for empty path', async () => {
      const path = uniquePath('test/edge/empty-value');
      const ref = db.ref(path);

      await ref.set(null);

      let receivedValue: unknown = 'not-set';
      const unsubscribe = ref.on('value', (snapshot) => {
        receivedValue = snapshot.val();
      });

      await wait(200);
      unsubscribe();

      expect(receivedValue).toBeNull();
    });
  });

  describe('delete all children', () => {
    it('child_removed fires for each child', async () => {
      const path = uniquePath('test/edge/delete-all');
      const ref = db.ref(path);

      await ref.set({
        a: 1,
        b: 2,
        c: 3,
      });

      const removedKeys: string[] = [];
      const unsubscribe = ref.on('child_removed', (snapshot) => {
        removedKeys.push(snapshot.key!);
      });

      await wait(150);

      // Delete all
      await ref.set(null);

      await wait(200);
      unsubscribe();

      expect(removedKeys).toContain('a');
      expect(removedKeys).toContain('b');
      expect(removedKeys).toContain('c');
    });

    it('value event shows null after all deleted', async () => {
      const path = uniquePath('test/edge/delete-all-value');
      const ref = db.ref(path);

      await ref.set({ data: 'exists' });

      const values: unknown[] = [];
      const unsubscribe = ref.on('value', (snapshot) => {
        values.push(snapshot.val());
      });

      await wait(150);

      await ref.set(null);

      await wait(200);
      unsubscribe();

      // Last value should be null
      expect(values[values.length - 1]).toBeNull();
    });
  });

  describe('sequential writes', () => {
    it('all child_added events received', async () => {
      const path = uniquePath('test/edge/sequential-writes');
      const ref = db.ref(path);

      await ref.set(null);

      const addedKeys: string[] = [];
      const unsubscribe = ref.on('child_added', (snapshot) => {
        addedKeys.push(snapshot.key!);
      });

      await wait(150);

      // Sequential writes respecting 3Hz server rate limit
      // Write 3 items with 350ms delays between them
      for (let i = 0; i < 3; i++) {
        await ref.child(`item${i}`).set({ index: i });
        if (i < 2) {
          await wait(350); // Respect 3Hz rate limit
        }
      }

      await wait(300);
      unsubscribe();

      // All items should be received
      for (let i = 0; i < 3; i++) {
        expect(addedKeys).toContain(`item${i}`);
      }
    });
  });

  describe('subscribe to non-existent path', () => {
    it('value event fires with null initially, then with data when created', async () => {
      const path = uniquePath('test/edge/non-existent');
      const ref = db.ref(path);

      // Make sure it doesn't exist
      await ref.set(null);
      await wait(100);

      const values: unknown[] = [];
      const unsubscribe = ref.on('value', (snapshot) => {
        values.push(snapshot.val());
      });

      await wait(150);

      // Should have received null
      expect(values).toContain(null);

      // Now create data
      await ref.set({ created: true });

      await wait(200);
      unsubscribe();

      // Should have received the new value
      expect(values).toContainEqual({ created: true });
    });

    it('child_added fires when data appears at previously empty path', async () => {
      const path = uniquePath('test/edge/appear');
      const ref = db.ref(path);

      await ref.set(null);

      const addedKeys: string[] = [];
      const unsubscribe = ref.on('child_added', (snapshot) => {
        addedKeys.push(snapshot.key!);
      });

      await wait(150);

      // Add data
      await ref.set({
        child1: { value: 1 },
        child2: { value: 2 },
      });

      await wait(200);
      unsubscribe();

      expect(addedKeys).toContain('child1');
      expect(addedKeys).toContain('child2');
    });
  });

  describe('nested subscription paths', () => {
    it('parent and child subscriptions both receive correct events', async () => {
      const parentPath = uniquePath('test/edge/nested-parent');
      const childPath = `${parentPath}/child`;

      await db.ref(parentPath).set({
        child: { value: 'initial' },
        sibling: { value: 'other' },
      });

      const parentValues: unknown[] = [];
      const childValues: unknown[] = [];

      const unsub1 = db.ref(parentPath).on('value', (snapshot) => {
        parentValues.push(snapshot.val());
      });
      const unsub2 = db.ref(childPath).on('value', (snapshot) => {
        childValues.push(snapshot.val());
      });

      await wait(200);

      // Update the child
      await db.ref(childPath).set({ value: 'updated' });

      await wait(200);

      unsub1();
      unsub2();

      // Parent should have received update
      const lastParent = parentValues[parentValues.length - 1] as Record<string, unknown>;
      expect((lastParent.child as Record<string, unknown>).value).toBe('updated');

      // Child should have received update
      const lastChild = childValues[childValues.length - 1] as Record<string, unknown>;
      expect(lastChild.value).toBe('updated');
    });
  });

  describe('overwrite entire object', () => {
    it('set() replacing all children fires child_removed for old + child_added for new', async () => {
      const path = uniquePath('test/edge/overwrite');
      const ref = db.ref(path);

      await ref.set({
        old1: { value: 1 },
        old2: { value: 2 },
      });

      const addedKeys: string[] = [];
      const removedKeys: string[] = [];

      const unsub1 = ref.on('child_added', (snapshot) => {
        addedKeys.push(snapshot.key!);
      });
      const unsub2 = ref.on('child_removed', (snapshot) => {
        removedKeys.push(snapshot.key!);
      });

      await wait(200);

      // Record counts after initial
      const initialAddedCount = addedKeys.length;

      // Overwrite with completely new children
      await ref.set({
        new1: { value: 10 },
        new2: { value: 20 },
        new3: { value: 30 },
      });

      await wait(300);

      unsub1();
      unsub2();

      // Old children should be removed
      expect(removedKeys).toContain('old1');
      expect(removedKeys).toContain('old2');

      // New children should be added
      const newAdds = addedKeys.slice(initialAddedCount);
      expect(newAdds).toContain('new1');
      expect(newAdds).toContain('new2');
      expect(newAdds).toContain('new3');
    });
  });

  describe('primitive values', () => {
    it('handles primitive value at subscribed path', async () => {
      const path = uniquePath('test/edge/primitive');
      const ref = db.ref(path);

      await ref.set('string value');

      let receivedValue: unknown = null;
      const unsubscribe = ref.on('value', (snapshot) => {
        receivedValue = snapshot.val();
      });

      await wait(200);
      unsubscribe();

      expect(receivedValue).toBe('string value');
    });

    it('handles number value', async () => {
      const path = uniquePath('test/edge/number');
      const ref = db.ref(path);

      await ref.set(42);

      let receivedValue: unknown = null;
      const unsubscribe = ref.on('value', (snapshot) => {
        receivedValue = snapshot.val();
      });

      await wait(200);
      unsubscribe();

      expect(receivedValue).toBe(42);
    });

    it('handles boolean value', async () => {
      const path = uniquePath('test/edge/boolean');
      const ref = db.ref(path);

      await ref.set(true);

      let receivedValue: unknown = null;
      const unsubscribe = ref.on('value', (snapshot) => {
        receivedValue = snapshot.val();
      });

      await wait(200);
      unsubscribe();

      expect(receivedValue).toBe(true);
    });
  });

  describe('special characters in keys', () => {
    it('handles keys with numbers', async () => {
      const path = uniquePath('test/edge/numeric-keys');
      const ref = db.ref(path);

      await ref.set({
        '123': { value: 'numeric' },
        'key456': { value: 'mixed' },
      });

      const addedKeys: string[] = [];
      const unsubscribe = ref.on('child_added', (snapshot) => {
        addedKeys.push(snapshot.key!);
      });

      await wait(200);
      unsubscribe();

      expect(addedKeys).toContain('123');
      expect(addedKeys).toContain('key456');
    });
  });

  describe('concurrent operations', () => {
    it('handles concurrent add and remove', async () => {
      const path = uniquePath('test/edge/concurrent');
      const ref = db.ref(path);

      await ref.set({
        existing: { value: 1 },
      });

      const addedKeys: string[] = [];
      const removedKeys: string[] = [];

      const unsub1 = ref.on('child_added', (snapshot) => {
        addedKeys.push(snapshot.key!);
      });
      const unsub2 = ref.on('child_removed', (snapshot) => {
        removedKeys.push(snapshot.key!);
      });

      await wait(150);

      // Do add and remove concurrently
      await Promise.all([
        ref.child('newChild').set({ value: 2 }),
        ref.child('existing').remove(),
      ]);

      await wait(300);

      unsub1();
      unsub2();

      expect(addedKeys).toContain('newChild');
      expect(removedKeys).toContain('existing');
    });
  });
});
