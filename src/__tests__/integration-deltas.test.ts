/**
 * Integration tests for delta verification.
 * Ensures server sends deltas (not full snapshots) for update operations.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';
import { DataSnapshot } from '../DataSnapshot';
import { getSharedDb, disconnectSharedDb, wait, uniquePath } from './integration-utils';

describe('Integration: Delta Verification', () => {
  let db: LarkDatabase;

  beforeAll(async () => {
    db = await getSharedDb();
  });

  afterAll(async () => {
    await disconnectSharedDb();
  });

  describe('update() sends deltas', () => {
    it('update() on nested field triggers child_changed for immediate child only', async () => {
      const path = uniquePath('test/deltas/update-nested');
      const ref = db.ref(path);

      await ref.set({
        user: {
          profile: { name: 'Alice', bio: 'Hello' },
          settings: { theme: 'dark' },
        },
        metadata: { version: 1 },
      });

      const changedKeys: string[] = [];
      const unsubscribe = ref.on('child_changed', (snapshot) => {
        changedKeys.push(snapshot.key!);
      });

      await wait(150);

      // Update a deeply nested field
      await ref.child('user/profile/bio').set('Updated bio');

      await wait(200);
      unsubscribe();

      // Should only fire child_changed for 'user', not for everything
      expect(changedKeys).toContain('user');
      expect(changedKeys).not.toContain('metadata');
      expect(changedKeys.length).toBe(1);
    });

    it('update() with multiple fields in same child fires once', async () => {
      const path = uniquePath('test/deltas/update-multi-field');
      const ref = db.ref(path);

      await ref.set({
        user: { name: 'Bob', score: 0, level: 1 },
      });

      const changedSnapshots: DataSnapshot[] = [];
      const unsubscribe = ref.on('child_changed', (snapshot) => {
        changedSnapshots.push(snapshot);
      });

      await wait(150);

      // Update multiple fields at once
      await ref.child('user').update({ score: 100, level: 5 });

      await wait(200);
      unsubscribe();

      // Should fire child_changed once with both updates applied
      expect(changedSnapshots.length).toBe(1);
      const val = changedSnapshots[0].val() as Record<string, unknown>;
      expect(val.score).toBe(100);
      expect(val.level).toBe(5);
    });

    it('set() on child sends delta for that child only', async () => {
      const path = uniquePath('test/deltas/set-child');
      const ref = db.ref(path);

      await ref.set({
        child1: { value: 1 },
        child2: { value: 2 },
        child3: { value: 3 },
      });

      const changedKeys: string[] = [];
      const unsubscribe = ref.on('child_changed', (snapshot) => {
        changedKeys.push(snapshot.key!);
      });

      await wait(150);

      // Set one child
      await ref.child('child2').set({ value: 200 });

      await wait(200);
      unsubscribe();

      // Only child2 should fire child_changed
      expect(changedKeys).toEqual(['child2']);
    });
  });

  describe('transaction() sends deltas', () => {
    it('transaction with multiple paths sends updates for each affected child', async () => {
      const path = uniquePath('test/deltas/transaction-multi');
      const ref = db.ref(path);

      await ref.set({
        alice: { score: 100 },
        bob: { score: 200 },
        charlie: { score: 300 },
      });

      const changedKeys: string[] = [];
      const unsubscribe = ref.on('child_changed', (snapshot) => {
        changedKeys.push(snapshot.key!);
      });

      await wait(150);

      // Transaction updating alice and bob, not charlie
      await db.transaction({
        [`/${path}/alice/score`]: 150,
        [`/${path}/bob/score`]: 250,
      });

      await wait(300);
      unsubscribe();

      // Should have child_changed for alice and bob, not charlie
      expect(changedKeys).toContain('alice');
      expect(changedKeys).toContain('bob');
      expect(changedKeys).not.toContain('charlie');
    });

    it('transaction with disparate paths does not send full tree', async () => {
      const path = uniquePath('test/deltas/transaction-disparate');
      const ref = db.ref(path);

      await ref.set({
        users: {
          alice: { name: 'Alice' },
          bob: { name: 'Bob' },
        },
        scores: {
          alice: 100,
          bob: 200,
        },
        metadata: { lastUpdated: 0 },
      });

      const changedKeys: string[] = [];
      const unsubscribe = ref.on('child_changed', (snapshot) => {
        changedKeys.push(snapshot.key!);
      });

      await wait(150);

      // Update disparate parts of the tree
      await db.transaction({
        [`/${path}/scores/alice`]: 150,
        [`/${path}/metadata/lastUpdated`]: Date.now(),
      });

      await wait(300);
      unsubscribe();

      // Should have changes for 'scores' and 'metadata', not 'users'
      expect(changedKeys).toContain('scores');
      expect(changedKeys).toContain('metadata');
      expect(changedKeys).not.toContain('users');
    });
  });

  describe('deeply nested updates', () => {
    it('update at level 4 nesting sends correct delta', async () => {
      const path = uniquePath('test/deltas/deep-update');
      const ref = db.ref(path);

      await ref.set({
        level1: {
          level2: {
            level3: {
              level4: {
                value: 'original',
              },
              other: 'untouched',
            },
          },
        },
        sibling: { data: 'unchanged' },
      });

      const changedKeys: string[] = [];
      const changedSnapshots: DataSnapshot[] = [];
      const unsubscribe = ref.on('child_changed', (snapshot) => {
        changedKeys.push(snapshot.key!);
        changedSnapshots.push(snapshot);
      });

      await wait(150);

      // Update deeply nested value
      await ref.child('level1/level2/level3/level4/value').set('updated');

      await wait(200);
      unsubscribe();

      // Only 'level1' should fire child_changed at the ref level
      expect(changedKeys).toEqual(['level1']);
      expect(changedKeys).not.toContain('sibling');

      // The snapshot should contain the updated value
      const level1Val = changedSnapshots[0].val() as Record<string, unknown>;
      const deepValue = (level1Val as any).level2.level3.level4.value;
      expect(deepValue).toBe('updated');
    });
  });

  describe('value event receives full snapshot but via deltas', () => {
    it('value event after update contains merged data', async () => {
      const path = uniquePath('test/deltas/value-merged');
      const ref = db.ref(path);

      await ref.set({
        field1: 'original1',
        field2: 'original2',
        field3: 'original3',
      });

      const snapshots: unknown[] = [];
      const unsubscribe = ref.on('value', (snapshot) => {
        snapshots.push(snapshot.val());
      });

      await wait(150);

      // Update one field
      await ref.update({ field2: 'updated2' });

      await wait(200);
      unsubscribe();

      // Last snapshot should have all fields with field2 updated
      const lastSnapshot = snapshots[snapshots.length - 1] as Record<string, unknown>;
      expect(lastSnapshot).toEqual({
        field1: 'original1',
        field2: 'updated2',
        field3: 'original3',
      });
    });
  });

  describe('add and remove are deltas', () => {
    it('adding a new child does not resend existing children', async () => {
      const path = uniquePath('test/deltas/add-child');
      const ref = db.ref(path);

      await ref.set({
        existing1: { value: 1 },
        existing2: { value: 2 },
      });

      const addedKeys: string[] = [];
      const unsubscribe = ref.on('child_added', (snapshot) => {
        addedKeys.push(snapshot.key!);
      });

      await wait(200);

      // Clear initial adds
      const initialAddedCount = addedKeys.length;

      await ref.child('newChild').set({ value: 3 });

      await wait(200);
      unsubscribe();

      // After initial snapshot, only newChild should be added
      const newAdds = addedKeys.slice(initialAddedCount);
      expect(newAdds).toEqual(['newChild']);
    });

    it('removing a child does not resend remaining children', async () => {
      const path = uniquePath('test/deltas/remove-child');
      const ref = db.ref(path);

      await ref.set({
        keep1: { value: 1 },
        remove: { value: 2 },
        keep2: { value: 3 },
      });

      let initialLoad = true;
      const addedAfterInitial: string[] = [];
      const removedKeys: string[] = [];

      const unsub1 = ref.on('child_added', (snapshot) => {
        if (!initialLoad) {
          addedAfterInitial.push(snapshot.key!);
        }
      });
      const unsub2 = ref.on('child_removed', (snapshot) => {
        removedKeys.push(snapshot.key!);
      });

      await wait(200);
      initialLoad = false;

      await ref.child('remove').remove();

      await wait(200);
      unsub1();
      unsub2();

      // Only 'remove' should be in removed, nothing new added
      expect(removedKeys).toEqual(['remove']);
      expect(addedAfterInitial.length).toBe(0);
    });
  });
});
