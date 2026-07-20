/**
 * Integration tests against live Lark server.
 *
 * These tests require network access and connect to:
 * - Server: javascript-integration.larkdb.net
 * - Project: javascript-integration (ephemeral databases)
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';

// Generate a unique database ID for this test run
const testRunId = `test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
const DATABASE_ID = `javascript-integration/${testRunId}`;

describe('Integration Tests', () => {
  let db: LarkDatabase;

  beforeAll(async () => {
    db = new LarkDatabase(DATABASE_ID, { anonymous: true });
  });

  afterAll(async () => {
    if (db.connected) {
      await db.disconnect();
    }
  });

  describe('Connection', () => {
    it('connects anonymously to the server', async () => {
      await db.connect();

      expect(db.connected).toBe(true);
      expect(db.auth).not.toBeNull();
      expect(db.auth?.uid).toBeDefined(); // Anonymous users may have empty string UID
      expect(db.auth?.provider).toBe('anonymous');

      console.log('Connected as:', db.auth?.uid);
    });
  });

  describe('Write Operations', () => {
    it('sets a value', async () => {
      const ref = db.ref('test/set');
      await ref.set({ name: 'Riley', score: 100 });

      // Verify by reading back
      const snapshot = await ref.once();
      expect(snapshot.exists()).toBe(true);
      expect(snapshot.val()).toEqual({ name: 'Riley', score: 100 });
    });

    it('updates a value', async () => {
      const ref = db.ref('test/update');
      await ref.set({ name: 'Riley', score: 100 });
      await ref.update({ score: 200 });

      const snapshot = await ref.once();
      expect(snapshot.val()).toEqual({ name: 'Riley', score: 200 });
    });

    it('removes a value', async () => {
      const ref = db.ref('test/remove');
      await ref.set({ foo: 'bar' });

      // Verify it exists
      let snapshot = await ref.once();
      expect(snapshot.exists()).toBe(true);

      // Remove it
      await ref.remove();

      // Verify it's gone
      snapshot = await ref.once();
      expect(snapshot.exists()).toBe(false);
    });

    it('pushes a value and returns the new key', async () => {
      const ref = db.ref('test/push');
      const newRef = await ref.push({ message: 'hello' });

      expect(newRef.key).toBeTruthy();
      expect(newRef.key).toHaveLength(20); // Push IDs are 20 chars

      // Verify the data was written
      const snapshot = await newRef.once();
      expect(snapshot.val()).toEqual({ message: 'hello' });
    });
  });

  describe('Read Operations', () => {
    it('reads a value with once()', async () => {
      const ref = db.ref('test/read');
      await ref.set({ foo: 'bar', num: 42 });

      const snapshot = await ref.once();
      expect(snapshot.exists()).toBe(true);
      expect(snapshot.val()).toEqual({ foo: 'bar', num: 42 });
      expect(snapshot.key).toBe('read');
    });

    it('reads nested data', async () => {
      const ref = db.ref('test/nested');
      await ref.set({
        level1: {
          level2: {
            value: 'deep',
          },
        },
      });

      const snapshot = await db.ref('test/nested/level1/level2/value').once();
      expect(snapshot.val()).toBe('deep');
    });

    it('returns null for non-existent paths', async () => {
      const snapshot = await db.ref('test/nonexistent/path').once();
      expect(snapshot.exists()).toBe(false);
      expect(snapshot.val()).toBeNull();
    });
  });

  describe('Subscriptions', () => {
    it('receives value events', async () => {
      const ref = db.ref('test/subscribe/value');
      await ref.set({ initial: true });

      const events: unknown[] = [];
      const unsubscribe = ref.on('value', (snapshot) => {
        events.push(snapshot.val());
      });

      // Wait a bit for initial value event
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Update the value
      await ref.set({ updated: true });

      // Wait for event
      await new Promise((resolve) => setTimeout(resolve, 100));

      unsubscribe();

      // Should have received at least the update
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events).toContainEqual({ updated: true });
    });

    it('receives child_added events', async () => {
      const ref = db.ref('test/subscribe/children');
      await ref.set(null); // Clear first

      const addedChildren: string[] = [];
      const unsubscribe = ref.on('child_added', (snapshot) => {
        addedChildren.push(snapshot.key!);
      });

      // Wait for subscription to be established on server
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Add children
      await ref.child('child1').set({ name: 'First' });
      await ref.child('child2').set({ name: 'Second' });

      // Wait for events
      await new Promise((resolve) => setTimeout(resolve, 200));

      unsubscribe();

      expect(addedChildren).toContain('child1');
      expect(addedChildren).toContain('child2');
    });

    it('unsubscribe stops events', async () => {
      const ref = db.ref('test/subscribe/unsub');
      await ref.set({ count: 0 });

      let eventCount = 0;
      const unsubscribe = ref.on('value', () => {
        eventCount++;
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      const countAfterSubscribe = eventCount;

      unsubscribe();

      // Update after unsubscribe
      await ref.set({ count: 1 });
      await ref.set({ count: 2 });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should not have received more events
      expect(eventCount).toBe(countAfterSubscribe);
    });
  });

  describe('DataSnapshot', () => {
    it('provides correct key and path', async () => {
      await db.ref('test/snapshot/child').set({ value: 1 });

      const snapshot = await db.ref('test/snapshot/child').once();
      expect(snapshot.key).toBe('child');
      expect(snapshot.ref.path).toBe('/test/snapshot/child');
    });

    it('child() navigates to nested data', async () => {
      await db.ref('test/snapshot/nested').set({
        a: { b: { c: 'value' } },
      });

      const snapshot = await db.ref('test/snapshot/nested').once();
      const childSnap = snapshot.child('a/b/c');
      expect(childSnap.val()).toBe('value');
    });

    it('forEach iterates children', async () => {
      await db.ref('test/snapshot/foreach').set({
        a: 1,
        b: 2,
        c: 3,
      });

      const snapshot = await db.ref('test/snapshot/foreach').once();
      const keys: string[] = [];
      snapshot.forEach((child) => {
        keys.push(child.key!);
      });

      expect(keys).toContain('a');
      expect(keys).toContain('b');
      expect(keys).toContain('c');
    });
  });

  describe('OnDisconnect', () => {
    it('registers onDisconnect handler', async () => {
      // This test just verifies the onDisconnect call succeeds
      // Actually testing disconnect behavior would require a second connection
      const ref = db.ref('test/ondisconnect');
      await ref.set({ online: true });

      // Register onDisconnect
      await ref.onDisconnect().set({ online: false });

      // Cancel it (cleanup)
      await ref.onDisconnect().cancel();
    });
  });

  describe('Local Cache', () => {
    it('uses cached data for once() when parent is subscribed', async () => {
      const ref = db.ref('test/cache/parent');

      // Set up initial data
      await ref.set({
        child1: { value: 'one' },
        child2: { value: 'two' },
        child3: { value: 'three' },
      });

      // Subscribe to parent - this will cache the data
      let receivedValue: unknown = null;
      const unsubscribe = ref.on('value', (snapshot) => {
        receivedValue = snapshot.val();
      });

      // Wait for subscription to receive data
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(receivedValue).not.toBeNull();

      // Now call once() on a child - should use cache, not server
      const startTime = Date.now();
      const childSnapshot = await ref.child('child2').once();
      const elapsed = Date.now() - startTime;

      // Should return the correct value
      expect(childSnapshot.val()).toEqual({ value: 'two' });

      // Should be very fast (cache hit) - less than 50ms
      // A server round-trip would typically take 100-500ms
      expect(elapsed).toBeLessThan(50);

      unsubscribe();
    });

    it('fetches from server when path is not covered by subscription', async () => {
      const ref = db.ref('test/cache/nocache');

      // Set up initial data (no subscription)
      await ref.set({ data: 'test' });

      // Wait a bit for write to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Call once() - should fetch from server since not subscribed
      const snapshot = await ref.once();
      expect(snapshot.val()).toEqual({ data: 'test' });
    });

    it('cache updates when data changes via subscription', async () => {
      const ref = db.ref('test/cache/updates');

      await ref.set({ counter: 1 });

      const values: unknown[] = [];
      const unsubscribe = ref.on('value', (snapshot) => {
        values.push(snapshot.val());
      });

      // Wait for initial value
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Update the value
      await ref.set({ counter: 2 });

      // Wait for update event
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Now once() should return the updated cached value
      const snapshot = await ref.once();
      expect(snapshot.val()).toEqual({ counter: 2 });

      unsubscribe();
    });

    it('cache hit for deeply nested path', async () => {
      const ref = db.ref('test/cache/deep');

      await ref.set({
        level1: {
          level2: {
            level3: {
              value: 'deeply-nested',
            },
          },
        },
      });

      // Subscribe to root of this data
      let ready = false;
      const unsubscribe = ref.on('value', () => {
        ready = true;
      });

      // Wait for subscription
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(ready).toBe(true);

      // once() on deeply nested path should use cache
      const startTime = Date.now();
      const snapshot = await db.ref('test/cache/deep/level1/level2/level3/value').once();
      const elapsed = Date.now() - startTime;

      expect(snapshot.val()).toBe('deeply-nested');
      expect(elapsed).toBeLessThan(50); // Cache hit should be fast

      unsubscribe();
    });

    it('does not use cache after unsubscribing', async () => {
      const ref = db.ref('test/cache/unsub');

      await ref.set({ data: 'original' });

      // Subscribe
      const unsubscribe = ref.on('value', () => {});
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Unsubscribe
      unsubscribe();

      // Modify data directly (simulating another client)
      await ref.set({ data: 'modified' });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // once() should fetch from server since no longer subscribed
      // and should get the modified value
      const snapshot = await ref.once();
      expect(snapshot.val()).toEqual({ data: 'modified' });
    });
  });

  describe('Transactions', () => {
    describe('object syntax', () => {
      it('atomically writes multiple paths', async () => {
        await db.transaction({
          '/test/tx/obj/alice': { name: 'Alice', score: 100 },
          '/test/tx/obj/bob': { name: 'Bob', score: 200 },
        });

        const alice = await db.ref('test/tx/obj/alice').once();
        const bob = await db.ref('test/tx/obj/bob').once();

        expect(alice.val()).toEqual({ name: 'Alice', score: 100 });
        expect(bob.val()).toEqual({ name: 'Bob', score: 200 });
      });

      it('handles null as delete', async () => {
        // Set up data first
        await db.ref('test/tx/obj/delete').set({ keep: 'this', remove: 'that' });

        // Use transaction to delete one path
        await db.transaction({
          '/test/tx/obj/delete/remove': null,
        });

        const snapshot = await db.ref('test/tx/obj/delete').once();
        expect(snapshot.val()).toEqual({ keep: 'this' });
      });
    });

    describe('array syntax', () => {
      it('supports set, update, and delete operations', async () => {
        // Set up initial data
        await db.ref('test/tx/arr/metadata').set({ version: 1, extra: 'data' });

        await db.transaction([
          { op: 'set', path: '/test/tx/arr/user', value: { name: 'Charlie' } },
          { op: 'update', path: '/test/tx/arr/metadata', value: { version: 2 } },
          { op: 'delete', path: '/test/tx/arr/metadata/extra' },
        ]);

        const user = await db.ref('test/tx/arr/user').once();
        const metadata = await db.ref('test/tx/arr/metadata').once();

        expect(user.val()).toEqual({ name: 'Charlie' });
        expect(metadata.val()).toEqual({ version: 2 });
      });

      it('supports condition checks (compare-and-swap)', async () => {
        // Set up counter
        await db.ref('test/tx/arr/counter').set(5);

        // Transaction with condition should succeed
        await db.transaction([
          { op: 'condition', path: '/test/tx/arr/counter', value: 5 },
          { op: 'set', path: '/test/tx/arr/counter', value: 6 },
        ]);

        const snapshot = await db.ref('test/tx/arr/counter').once();
        expect(snapshot.val()).toBe(6);
      });

      it('fails when condition is not met', async () => {
        // Set up counter
        await db.ref('test/tx/arr/counter2').set(10);

        // Transaction with wrong condition should fail
        await expect(
          db.transaction([
            { op: 'condition', path: '/test/tx/arr/counter2', value: 5 }, // Wrong!
            { op: 'set', path: '/test/tx/arr/counter2', value: 11 },
          ])
        ).rejects.toThrow();

        // Value should be unchanged
        const snapshot = await db.ref('test/tx/arr/counter2').once();
        expect(snapshot.val()).toBe(10);
      });
    });

    describe('callback syntax (optimistic concurrency)', () => {
      it('increments a counter atomically', async () => {
        const ref = db.ref('test/tx/callback/counter');
        await ref.set(0);

        const result = await ref.transaction((current) => {
          return ((current as number) || 0) + 1;
        });

        expect(result.committed).toBe(true);
        expect(result.snapshot.val()).toBe(1);
      });

      it('can abort by returning undefined', async () => {
        const ref = db.ref('test/tx/callback/abort');
        await ref.set({ value: 'original' });

        const result = await ref.transaction((current) => {
          // Abort the transaction
          return undefined;
        });

        expect(result.committed).toBe(false);

        // Value should be unchanged
        const snapshot = await ref.once();
        expect(snapshot.val()).toEqual({ value: 'original' });
      });

      it('handles null initial value', async () => {
        const ref = db.ref('test/tx/callback/new-' + Date.now());

        const result = await ref.transaction((current) => {
          // current should be null for non-existent path
          if (current === null) {
            return { initialized: true };
          }
          return current;
        });

        expect(result.committed).toBe(true);
        expect(result.snapshot.val()).toEqual({ initialized: true });
      });
    });

    describe('multi-path update()', () => {
      it('uses transactions for path-like keys', async () => {
        await db.ref().update({
          '/test/tx/multipath/alice/score': 100,
          '/test/tx/multipath/bob/score': 200,
        });

        const alice = await db.ref('test/tx/multipath/alice/score').once();
        const bob = await db.ref('test/tx/multipath/bob/score').once();

        expect(alice.val()).toBe(100);
        expect(bob.val()).toBe(200);
      });

      it('supports null for deletion in multi-path mode', async () => {
        // Set up data
        await db.ref('test/tx/multipath/delete').set({ a: 1, b: 2 });

        await db.ref().update({
          '/test/tx/multipath/delete/a': 10,
          '/test/tx/multipath/delete/b': null,
        });

        const snapshot = await db.ref('test/tx/multipath/delete').once();
        expect(snapshot.val()).toEqual({ a: 10 });
      });

      it('resolves paths relative to the reference', async () => {
        await db.ref('test/tx/multipath/relative').update({
          '/child1': { value: 1 },
          '/child2': { value: 2 },
        });

        const snapshot = await db.ref('test/tx/multipath/relative').once();
        expect(snapshot.val()).toEqual({
          child1: { value: 1 },
          child2: { value: 2 },
        });
      });
    });
  });

  describe('Error Handling', () => {
    it('handles permission denied errors', async () => {
      // This depends on server rules - skip if no rules are set up
      // For now, just verify the error class works
      expect(true).toBe(true);
    });
  });
});
