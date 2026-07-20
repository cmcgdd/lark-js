/**
 * Integration tests for optimistic local-first writes.
 *
 * These tests verify that:
 * 1. Events fire immediately (before server ack)
 * 2. No duplicate events fire when server confirms
 * 3. Both value and child events work correctly
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';
import { DataSnapshot } from '../DataSnapshot';

// Generate a unique database ID for this test run
const testRunId = `test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
const DATABASE_ID = `javascript-integration/${testRunId}`;

// Server enforces 3Hz write rate limit - need 350ms between writes
const WRITE_DELAY = 350;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Optimistic Writes Integration Tests', () => {
  let db: LarkDatabase;

  beforeAll(async () => {
    db = new LarkDatabase(DATABASE_ID, { anonymous: true });
    await db.connect();
    console.log('Connected as:', db.auth?.uid);
  });

  afterAll(async () => {
    if (db.connected) {
      await db.disconnect();
    }
  });

  describe('Immediate Event Firing (before server ack)', () => {
    it('value event fires synchronously on set()', async () => {
      const ref = db.ref('optimistic/value-sync');
      const callback = vi.fn();

      // Subscribe and wait for initial event
      const unsubscribe = ref.on('value', callback);
      await delay(100); // Wait for subscription to be established

      // Clear initial callback (null or whatever initial state)
      callback.mockClear();

      // Call set() but capture the promise - don't await yet
      const setPromise = ref.set({ name: 'Alice', score: 100 });

      // Event should have fired SYNCHRONOUSLY (before await)
      expect(callback).toHaveBeenCalledTimes(1);
      const snapshot = callback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.val()).toEqual({ name: 'Alice', score: 100 });

      // Now wait for server confirmation
      await setPromise;

      unsubscribe();
      await delay(WRITE_DELAY);
    });

    it('value event fires synchronously on update()', async () => {
      const ref = db.ref('optimistic/update-sync');

      // Set initial data
      await ref.set({ name: 'Bob', score: 50 });
      await delay(WRITE_DELAY);

      const callback = vi.fn();
      const unsubscribe = ref.on('value', callback);
      await delay(100);
      callback.mockClear();

      // Call update() but don't await yet
      const updatePromise = ref.update({ score: 200, level: 5 });

      // Event should have fired SYNCHRONOUSLY
      expect(callback).toHaveBeenCalledTimes(1);
      const snapshot = callback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.val()).toEqual({ name: 'Bob', score: 200, level: 5 });

      await updatePromise;
      unsubscribe();
      await delay(WRITE_DELAY);
    });

    it('child_added event fires synchronously', async () => {
      const ref = db.ref('optimistic/child-added-sync');

      // Set initial data with one child
      await ref.set({ alice: { name: 'Alice' } });
      await delay(WRITE_DELAY);

      const callback = vi.fn();
      const unsubscribe = ref.on('child_added', callback);
      await delay(100);
      callback.mockClear();

      // Add a new child - don't await yet
      const setPromise = ref.child('bob').set({ name: 'Bob' });

      // child_added should have fired SYNCHRONOUSLY
      expect(callback).toHaveBeenCalledTimes(1);
      const snapshot = callback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.key).toBe('bob');
      expect(snapshot.val()).toEqual({ name: 'Bob' });

      await setPromise;
      unsubscribe();
      await delay(WRITE_DELAY);
    });

    it('child_changed event fires synchronously', async () => {
      const ref = db.ref('optimistic/child-changed-sync');

      // Set initial data
      await ref.set({ alice: { name: 'Alice', score: 10 } });
      await delay(WRITE_DELAY);

      const callback = vi.fn();
      const unsubscribe = ref.on('child_changed', callback);
      await delay(100);
      callback.mockClear();

      // Update existing child - don't await yet
      const setPromise = ref.child('alice').set({ name: 'Alice', score: 100 });

      // child_changed should have fired SYNCHRONOUSLY
      expect(callback).toHaveBeenCalledTimes(1);
      const snapshot = callback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.key).toBe('alice');
      expect(snapshot.val()).toEqual({ name: 'Alice', score: 100 });

      await setPromise;
      unsubscribe();
      await delay(WRITE_DELAY);
    });

    it('child_removed event fires synchronously', async () => {
      const ref = db.ref('optimistic/child-removed-sync');

      // Set initial data with two children
      await ref.set({ alice: { name: 'Alice' }, bob: { name: 'Bob' } });
      await delay(WRITE_DELAY);

      const callback = vi.fn();
      const unsubscribe = ref.on('child_removed', callback);
      await delay(100);
      callback.mockClear();

      // Remove a child - don't await yet
      const removePromise = ref.child('bob').remove();

      // child_removed should have fired SYNCHRONOUSLY
      expect(callback).toHaveBeenCalledTimes(1);
      const snapshot = callback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.key).toBe('bob');

      await removePromise;
      unsubscribe();
      await delay(WRITE_DELAY);
    });
  });

  describe('No Duplicate Events on Server Confirmation', () => {
    it('value event fires exactly once for set()', async () => {
      const ref = db.ref('optimistic/no-dup-value');
      const callback = vi.fn();

      const unsubscribe = ref.on('value', callback);
      await delay(100);
      callback.mockClear();

      // Set and wait for full round-trip
      await ref.set({ data: 'test' });

      // Wait extra time for any potential duplicate server event
      await delay(200);

      // Should have fired exactly once (from optimistic update)
      // NOT twice (optimistic + server confirmation)
      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
      await delay(WRITE_DELAY);
    });

    it('value event fires exactly once for update()', async () => {
      const ref = db.ref('optimistic/no-dup-update');

      await ref.set({ name: 'Initial', count: 0 });
      await delay(WRITE_DELAY);

      const callback = vi.fn();
      const unsubscribe = ref.on('value', callback);
      await delay(100);
      callback.mockClear();

      // Update and wait for full round-trip
      await ref.update({ count: 1 });

      // Wait extra time for any potential duplicate
      await delay(200);

      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
      await delay(WRITE_DELAY);
    });

    it('child_added fires exactly once for new child', async () => {
      const ref = db.ref('optimistic/no-dup-child-added');

      await ref.set({ existing: { name: 'Existing' } });
      await delay(WRITE_DELAY);

      const callback = vi.fn();
      const unsubscribe = ref.on('child_added', callback);
      await delay(100);
      callback.mockClear();

      // Add new child and wait for round-trip
      await ref.child('newchild').set({ name: 'New' });

      // Wait extra time
      await delay(200);

      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
      await delay(WRITE_DELAY);
    });

    it('child_changed fires exactly once for update', async () => {
      const ref = db.ref('optimistic/no-dup-child-changed');

      await ref.set({ target: { score: 10 } });
      await delay(WRITE_DELAY);

      const callback = vi.fn();
      const unsubscribe = ref.on('child_changed', callback);
      await delay(100);
      callback.mockClear();

      // Update existing child
      await ref.child('target').set({ score: 100 });

      // Wait extra time
      await delay(200);

      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
      await delay(WRITE_DELAY);
    });

    it('child_removed fires exactly once for delete', async () => {
      const ref = db.ref('optimistic/no-dup-child-removed');

      await ref.set({ toDelete: { name: 'Delete Me' }, keep: { name: 'Keep' } });
      await delay(WRITE_DELAY);

      const callback = vi.fn();
      const unsubscribe = ref.on('child_removed', callback);
      await delay(100);
      callback.mockClear();

      // Remove child
      await ref.child('toDelete').remove();

      // Wait extra time
      await delay(200);

      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
      await delay(WRITE_DELAY);
    });
  });

  describe('Multiple Rapid Writes', () => {
    it('handles rapid sequential writes with correct final state', async () => {
      const ref = db.ref('optimistic/rapid-writes');
      const callback = vi.fn();

      const unsubscribe = ref.on('value', callback);
      await delay(100);
      callback.mockClear();

      // Fire off multiple sets rapidly (don't await each one)
      const promises = [
        ref.set({ value: 1 }),
        ref.set({ value: 2 }),
        ref.set({ value: 3 }),
      ];

      // Each set should trigger an event
      expect(callback.mock.calls.length).toBeGreaterThanOrEqual(1);

      // Wait for all to complete
      await Promise.all(promises);
      await delay(300);

      // Final state should be the last value
      const snapshot = await ref.once();
      expect(snapshot.val()).toEqual({ value: 3 });

      unsubscribe();
      await delay(WRITE_DELAY);
    });
  });

  describe('Nested Path Writes', () => {
    it('updates nested path and fires events on parent subscription', async () => {
      const parentRef = db.ref('optimistic/nested');
      const childRef = db.ref('optimistic/nested/deep/path');

      // Set initial structure
      await parentRef.set({ deep: { path: { value: 'initial' } } });
      await delay(WRITE_DELAY);

      const callback = vi.fn();
      const unsubscribe = parentRef.on('value', callback);
      await delay(100);
      callback.mockClear();

      // Write to nested path
      const setPromise = childRef.set({ value: 'updated' });

      // Parent should get event immediately
      expect(callback).toHaveBeenCalledTimes(1);
      const snapshot = callback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.child('deep/path').val()).toEqual({ value: 'updated' });

      await setPromise;
      unsubscribe();
      await delay(WRITE_DELAY);
    });

    it('fires child_changed for parent when nested child is updated', async () => {
      const ref = db.ref('optimistic/nested-child-changed');

      await ref.set({
        user1: { profile: { name: 'Alice', level: 1 } },
        user2: { profile: { name: 'Bob', level: 2 } },
      });
      await delay(WRITE_DELAY);

      const callback = vi.fn();
      const unsubscribe = ref.on('child_changed', callback);
      await delay(100);
      callback.mockClear();

      // Update nested property
      const setPromise = ref.child('user1/profile/level').set(10);

      // Should fire child_changed for user1
      expect(callback).toHaveBeenCalledTimes(1);
      const snapshot = callback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.key).toBe('user1');

      await setPromise;
      unsubscribe();
      await delay(WRITE_DELAY);
    });
  });
});
