/**
 * Integration tests for basic child events (no query modifiers).
 * Tests client-side generation of child_added, child_changed, child_removed events.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';
import { DataSnapshot } from '../DataSnapshot';
import { getSharedDb, disconnectSharedDb, wait, uniquePath } from './integration-utils';

describe('Integration: Child Events (No Query)', () => {
  let db: LarkDatabase;

  beforeAll(async () => {
    db = await getSharedDb();
  });

  afterAll(async () => {
    await disconnectSharedDb();
  });

  describe('child_added', () => {
    it('fires for each existing child on initial subscribe', async () => {
      const path = uniquePath('test/child-events/added-initial');
      const ref = db.ref(path);

      // Set up initial data
      await ref.set({
        child1: { name: 'First' },
        child2: { name: 'Second' },
        child3: { name: 'Third' },
      });

      const addedKeys: string[] = [];
      const unsubscribe = ref.on('child_added', (snapshot) => {
        addedKeys.push(snapshot.key!);
      });

      await wait(300);
      unsubscribe();

      expect(addedKeys).toContain('child1');
      expect(addedKeys).toContain('child2');
      expect(addedKeys).toContain('child3');
      expect(addedKeys.length).toBe(3);
    });

    it('fires when new child is created after subscribe', async () => {
      const path = uniquePath('test/child-events/added-new');
      const ref = db.ref(path);

      await ref.set(null); // Start empty

      const addedKeys: string[] = [];
      const unsubscribe = ref.on('child_added', (snapshot) => {
        addedKeys.push(snapshot.key!);
      });

      await wait(150);

      // Add children after subscribing
      await ref.child('newChild1').set({ value: 1 });
      await ref.child('newChild2').set({ value: 2 });

      await wait(200);
      unsubscribe();

      expect(addedKeys).toContain('newChild1');
      expect(addedKeys).toContain('newChild2');
    });

    it('includes correct snapshot data', async () => {
      const path = uniquePath('test/child-events/added-data');
      const ref = db.ref(path);

      await ref.set(null);

      const snapshots: DataSnapshot[] = [];
      const unsubscribe = ref.on('child_added', (snapshot) => {
        snapshots.push(snapshot);
      });

      await wait(150);

      await ref.child('user').set({ name: 'Alice', score: 100 });

      await wait(200);
      unsubscribe();

      const userSnap = snapshots.find((s) => s.key === 'user');
      expect(userSnap).toBeDefined();
      expect(userSnap?.val()).toEqual({ name: 'Alice', score: 100 });
    });
  });

  describe('child_changed', () => {
    it('fires when existing child value changes', async () => {
      const path = uniquePath('test/child-events/changed');
      const ref = db.ref(path);

      await ref.set({
        user: { name: 'Alice', score: 100 },
      });

      const changedSnapshots: DataSnapshot[] = [];
      const unsubscribe = ref.on('child_changed', (snapshot) => {
        changedSnapshots.push(snapshot);
      });

      await wait(150);

      // Change the value
      await ref.child('user').set({ name: 'Alice', score: 200 });

      await wait(200);
      unsubscribe();

      expect(changedSnapshots.length).toBe(1);
      expect(changedSnapshots[0].key).toBe('user');
      expect(changedSnapshots[0].val()).toEqual({ name: 'Alice', score: 200 });
    });

    it('fires when nested property changes', async () => {
      const path = uniquePath('test/child-events/changed-nested');
      const ref = db.ref(path);

      await ref.set({
        user: { profile: { name: 'Bob', bio: 'Hello' } },
      });

      const changedKeys: string[] = [];
      const unsubscribe = ref.on('child_changed', (snapshot) => {
        changedKeys.push(snapshot.key!);
      });

      await wait(150);

      // Update a deeply nested property
      await ref.child('user/profile/bio').set('Updated bio');

      await wait(200);
      unsubscribe();

      expect(changedKeys).toContain('user');
    });

    it('does NOT fire for new children (only child_added should)', async () => {
      const path = uniquePath('test/child-events/changed-not-new');
      const ref = db.ref(path);

      await ref.set(null);

      const changedKeys: string[] = [];
      const unsubscribe = ref.on('child_changed', (snapshot) => {
        changedKeys.push(snapshot.key!);
      });

      await wait(150);

      // Add a new child
      await ref.child('newChild').set({ value: 1 });

      await wait(200);
      unsubscribe();

      // child_changed should NOT fire for new children
      expect(changedKeys.length).toBe(0);
    });
  });

  describe('child_removed', () => {
    it('fires when child is deleted via remove()', async () => {
      const path = uniquePath('test/child-events/removed-delete');
      const ref = db.ref(path);

      await ref.set({
        child1: { value: 1 },
        child2: { value: 2 },
      });

      const removedKeys: string[] = [];
      const unsubscribe = ref.on('child_removed', (snapshot) => {
        removedKeys.push(snapshot.key!);
      });

      await wait(150);

      await ref.child('child1').remove();

      await wait(200);
      unsubscribe();

      expect(removedKeys).toContain('child1');
      expect(removedKeys.length).toBe(1);
    });

    it('fires when child is set to null', async () => {
      const path = uniquePath('test/child-events/removed-null');
      const ref = db.ref(path);

      await ref.set({
        toRemove: { data: 'test' },
        toKeep: { data: 'keep' },
      });

      const removedKeys: string[] = [];
      const unsubscribe = ref.on('child_removed', (snapshot) => {
        removedKeys.push(snapshot.key!);
      });

      await wait(150);

      await ref.child('toRemove').set(null);

      await wait(200);
      unsubscribe();

      expect(removedKeys).toContain('toRemove');
    });

    it('fires for each child when parent is cleared', async () => {
      const path = uniquePath('test/child-events/removed-all');
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

      // Clear all children
      await ref.set(null);

      await wait(200);
      unsubscribe();

      expect(removedKeys).toContain('a');
      expect(removedKeys).toContain('b');
      expect(removedKeys).toContain('c');
    });
  });

  describe('value event', () => {
    it('fires with full snapshot on initial subscribe', async () => {
      const path = uniquePath('test/child-events/value-initial');
      const ref = db.ref(path);

      await ref.set({ foo: 'bar', count: 42 });

      let receivedValue: unknown = null;
      const unsubscribe = ref.on('value', (snapshot) => {
        receivedValue = snapshot.val();
      });

      await wait(200);
      unsubscribe();

      expect(receivedValue).toEqual({ foo: 'bar', count: 42 });
    });

    it('fires on child add', async () => {
      const path = uniquePath('test/child-events/value-add');
      const ref = db.ref(path);

      await ref.set({ existing: true });

      const values: unknown[] = [];
      const unsubscribe = ref.on('value', (snapshot) => {
        values.push(snapshot.val());
      });

      await wait(150);

      await ref.child('newChild').set({ added: true });

      await wait(200);
      unsubscribe();

      // Should have initial value and updated value
      expect(values.length).toBeGreaterThanOrEqual(2);
      const lastValue = values[values.length - 1] as Record<string, unknown>;
      expect(lastValue.newChild).toEqual({ added: true });
    });

    it('fires on child update', async () => {
      const path = uniquePath('test/child-events/value-update');
      const ref = db.ref(path);

      await ref.set({ counter: 1 });

      const values: unknown[] = [];
      const unsubscribe = ref.on('value', (snapshot) => {
        values.push(snapshot.val());
      });

      await wait(150);

      await ref.child('counter').set(2);

      await wait(200);
      unsubscribe();

      expect(values).toContainEqual({ counter: 2 });
    });

    it('fires on child delete', async () => {
      const path = uniquePath('test/child-events/value-delete');
      const ref = db.ref(path);

      await ref.set({ keep: 1, remove: 2 });

      const values: unknown[] = [];
      const unsubscribe = ref.on('value', (snapshot) => {
        values.push(snapshot.val());
      });

      await wait(150);

      await ref.child('remove').remove();

      await wait(200);
      unsubscribe();

      expect(values).toContainEqual({ keep: 1 });
    });
  });

  describe('no child_moved without ordering', () => {
    it('does NOT fire child_moved when no orderBy is specified', async () => {
      const path = uniquePath('test/child-events/no-moved');
      const ref = db.ref(path);

      await ref.set({
        a: { score: 10 },
        b: { score: 20 },
        c: { score: 30 },
      });

      const movedKeys: string[] = [];
      const unsubscribe = ref.on('child_moved', (snapshot) => {
        movedKeys.push(snapshot.key!);
      });

      await wait(150);

      // Change a value that would cause reordering if ordered
      await ref.child('a/score').set(100);

      await wait(200);
      unsubscribe();

      // Without orderBy, child_moved should not fire
      expect(movedKeys.length).toBe(0);
    });
  });

  describe('combined events', () => {
    it('value and child_added both fire correctly', async () => {
      const path = uniquePath('test/child-events/combined');
      const ref = db.ref(path);

      await ref.set(null);
      await wait(350); // Respect 3Hz rate limit after initial write

      const valueSnapshots: unknown[] = [];
      const addedKeys: string[] = [];

      const unsub1 = ref.on('value', (snapshot) => {
        valueSnapshots.push(snapshot.val());
      });
      const unsub2 = ref.on('child_added', (snapshot) => {
        addedKeys.push(snapshot.key!);
      });

      await wait(150);

      await ref.child('item1').set({ data: 1 });
      await wait(400); // Respect 3Hz rate limit
      await ref.child('item2').set({ data: 2 });

      await wait(400);

      unsub1();
      unsub2();

      // Both should have received events
      expect(addedKeys).toContain('item1');
      expect(addedKeys).toContain('item2');

      const lastValue = valueSnapshots[valueSnapshots.length - 1] as Record<string, unknown>;
      expect(lastValue).toHaveProperty('item1');
      expect(lastValue).toHaveProperty('item2');
    });
  });
});
