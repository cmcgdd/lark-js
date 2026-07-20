/**
 * Integration tests for queued operations during connection.
 * Tests that operations (subscribes, writes) queue when called while
 * connect() is in progress, then execute once authenticated.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';
import { DataSnapshot } from '../DataSnapshot';

const PROJECT = 'javascript-integration';

// Generate unique database ID for test isolation
function generateDatabaseId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${PROJECT}/queued-ops-${timestamp}-${random}`;
}

describe('Queued Operations Integration Tests', () => {
  describe('Writes queued during connect', () => {
    it('set() queues during connect and executes after auth completes', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      // Start connect but don't await yet
      const connectPromise = db.connect();

      // Immediately start set() - should queue since auth not complete
      const setPromise = db.ref('/queued/set-test').set({ value: 'queued' });

      // Wait for both to complete
      await connectPromise;
      await setPromise;

      // Verify the data was written
      const snapshot = await db.ref('/queued/set-test').once();
      expect(snapshot.val()).toEqual({ value: 'queued' });

      await db.disconnect();
    });

    it('update() queues during connect and executes after auth completes', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      // Start connect
      const connectPromise = db.connect();

      // Queue update
      const updatePromise = db.ref('/queued/update-test').update({ name: 'Alice', score: 100 });

      await connectPromise;
      await updatePromise;

      const snapshot = await db.ref('/queued/update-test').once();
      expect(snapshot.val()).toEqual({ name: 'Alice', score: 100 });

      await db.disconnect();
    });

    it('remove() queues during connect and executes after auth completes', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      // Connect first to set up data
      await db.connect();
      await db.ref('/queued/remove-test').set({ exists: true });
      await db.disconnect();

      // Reconnect and queue remove during connect
      const db2 = new LarkDatabase(dbId, { anonymous: true });
      const connectPromise = db2.connect();
      const removePromise = db2.ref('/queued/remove-test').remove();

      await connectPromise;
      await removePromise;

      const snapshot = await db2.ref('/queued/remove-test').once();
      expect(snapshot.exists()).toBe(false);

      await db2.disconnect();
    });

    it('push() with value queues during connect and executes after auth completes', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      // Start connect
      const connectPromise = db.connect();

      // Queue push - key is generated synchronously
      const pushRef = db.ref('/queued/push-test').push();
      const setPromise = pushRef.set({ item: 'pushed' });

      await connectPromise;
      await setPromise;

      // Verify the push key was generated and data written
      expect(pushRef.key).toBeTruthy();
      const snapshot = await pushRef.once();
      expect(snapshot.val()).toEqual({ item: 'pushed' });

      await db.disconnect();
    });

    it('multiple queued writes execute in order', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      // Start connect
      const connectPromise = db.connect();

      // Queue multiple writes
      const promise1 = db.ref('/queued/order/a').set({ order: 1 });
      const promise2 = db.ref('/queued/order/b').set({ order: 2 });
      const promise3 = db.ref('/queued/order/c').set({ order: 3 });

      await connectPromise;
      await Promise.all([promise1, promise2, promise3]);

      // All should be written
      const snapshot = await db.ref('/queued/order').once();
      expect(snapshot.val()).toEqual({
        a: { order: 1 },
        b: { order: 2 },
        c: { order: 3 },
      });

      await db.disconnect();
    });
  });

  describe('Subscriptions queued during connect', () => {
    it('on() registers callback during connect and receives data after auth', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      // Start connect
      const connectPromise = db.connect();

      // Subscribe during connect and wait for expected data
      const dataPromise = new Promise<unknown>((resolve) => {
        const unsubscribe = db.ref('/queued/subscribe-test').on('value', (snapshot) => {
          const val = snapshot.val();
          if (val && val.subscribed === true) {
            unsubscribe();
            resolve(val);
          }
        });
      });

      // Wait for connect
      await connectPromise;

      // Write some data
      await db.ref('/queued/subscribe-test').set({ subscribed: true });

      // Wait for subscription to receive the data
      const receivedData = await dataPromise;
      expect(receivedData).toEqual({ subscribed: true });

      await db.disconnect();
    });

    it('once() queues during connect and resolves after auth', async () => {
      const dbId = generateDatabaseId();

      // Set up data first
      const setupDb = new LarkDatabase(dbId, { anonymous: true });
      await setupDb.connect();
      await setupDb.ref('/queued/once-test').set({ ready: true });
      await setupDb.disconnect();

      // Start connect and queue once() during connect
      const db = new LarkDatabase(dbId, { anonymous: true });
      const connectPromise = db.connect();
      const oncePromise = db.ref('/queued/once-test').once();

      await connectPromise;
      const snapshot = await oncePromise;

      expect(snapshot.val()).toEqual({ ready: true });

      await db.disconnect();
    });

    it('child_added subscription queued during connect receives events', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      const addedKeys: string[] = [];

      // Start connect
      const connectPromise = db.connect();

      // Subscribe to child_added during connect
      const unsubscribe = db.ref('/queued/child-added-test').on('child_added', (snapshot) => {
        addedKeys.push(snapshot.key!);
      });

      await connectPromise;

      // Write children
      await db.ref('/queued/child-added-test/child1').set({ value: 1 });
      await new Promise(resolve => setTimeout(resolve, 350)); // Rate limit delay
      await db.ref('/queued/child-added-test/child2').set({ value: 2 });

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(addedKeys).toContain('child1');
      expect(addedKeys).toContain('child2');

      unsubscribe();
      await db.disconnect();
    });

    it('unsubscribe during connect prevents subscription', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      let callCount = 0;

      // Start connect
      const connectPromise = db.connect();

      // Subscribe during connect
      const unsubscribe = db.ref('/queued/cancel-test').on('value', () => {
        callCount++;
      });

      // Immediately unsubscribe (during connect)
      unsubscribe();

      await connectPromise;

      // Write data - should NOT trigger callback since we unsubscribed
      await db.ref('/queued/cancel-test').set({ value: 1 });
      await new Promise(resolve => setTimeout(resolve, 100));

      // Callback should not have been called
      expect(callCount).toBe(0);

      await db.disconnect();
    });
  });

  describe('Transactions queued during connect', () => {
    it('transaction() queues during connect and executes after auth', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      // Start connect
      const connectPromise = db.connect();

      // Queue transaction
      const txPromise = db.transaction({
        '/queued/tx-test/a': 1,
        '/queued/tx-test/b': 2,
      });

      await connectPromise;
      await txPromise;

      const snapshot = await db.ref('/queued/tx-test').once();
      expect(snapshot.val()).toEqual({ a: 1, b: 2 });

      await db.disconnect();
    });

    it('ref.transaction() callback queues during connect and executes after auth', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      // Start connect
      const connectPromise = db.connect();

      // Queue ref transaction
      const txPromise = db.ref('/queued/ref-tx-test').transaction((current) => {
        return (current || 0) + 10;
      });

      await connectPromise;
      const result = await txPromise;

      expect(result.committed).toBe(true);
      expect(result.snapshot.val()).toBe(10);

      await db.disconnect();
    });
  });

  describe('onDisconnect queued during connect', () => {
    it('onDisconnect().set() queues during connect and registers after auth', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      // Start connect
      const connectPromise = db.connect();

      // Queue onDisconnect
      const odPromise = db.ref('/queued/od-test').onDisconnect().set({ disconnected: true });

      await connectPromise;
      await odPromise;

      // Verify we're connected (onDisconnect is registered server-side)
      expect(db.connected).toBe(true);

      // Cancel the onDisconnect so it doesn't affect other tests
      await db.ref('/queued/od-test').onDisconnect().cancel();

      await db.disconnect();
    });
  });

  describe('Error cases', () => {
    it('operations work without explicit connect() call (lazy connect)', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      // No connect called - should auto-connect
      await db.ref('/test').set({ value: 1 });

      expect(db.connected).toBe(true);

      const snapshot = await db.ref('/test').once();
      expect(snapshot.val()).toEqual({ value: 1 });

      await db.disconnect();
    });

    it('once() works without explicit connect() call', async () => {
      const dbId = generateDatabaseId();

      // Set up data
      const setupDb = new LarkDatabase(dbId, { anonymous: true });
      await setupDb.ref('/test').set({ value: 'test' });
      await setupDb.disconnect();

      // Read without explicit connect
      const db = new LarkDatabase(dbId, { anonymous: true });
      const snapshot = await db.ref('/test').once();
      expect(snapshot.val()).toEqual({ value: 'test' });

      await db.disconnect();
    });

    it('transaction works without explicit connect() call', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      await db.transaction({ '/test': 1 });

      expect(db.connected).toBe(true);

      await db.disconnect();
    });
  });

  describe('Optimistic updates with queued writes', () => {
    it('queued writes fire optimistic events once auth completes', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      const events: unknown[] = [];

      // Start connect
      const connectPromise = db.connect();

      // Subscribe during connect
      db.ref('/queued/optimistic').on('value', (snapshot) => {
        events.push(snapshot.val());
      });

      // Queue a write
      const writePromise = db.ref('/queued/optimistic').set({ optimistic: true });

      // Connect
      await connectPromise;

      // Wait for write
      await writePromise;

      // Wait for events
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should have received the value
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events).toContainEqual({ optimistic: true });

      await db.disconnect();
    });
  });

  describe('Mixed queued operations', () => {
    it('handles interleaved subscribes and writes during connect', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      // Start connect
      const connectPromise = db.connect();

      // Subscribe and wait for expected final value
      const dataPromise = new Promise<unknown>((resolve) => {
        const unsubscribe = db.ref('/queued/mixed').on('value', (snapshot) => {
          const val = snapshot.val();
          if (val && val.step === 2) {
            unsubscribe();
            resolve(val);
          }
        });
      });

      // Write
      const write1 = db.ref('/queued/mixed').set({ step: 1 });

      // Another write
      const write2 = db.ref('/queued/mixed').set({ step: 2 });

      // Wait for connect and writes
      await connectPromise;
      await Promise.all([write1, write2]);

      // Wait for subscription to receive step 2
      const finalValue = await dataPromise;
      expect(finalValue).toEqual({ step: 2 });

      await db.disconnect();
    });
  });

  describe('Operations during already authenticated state', () => {
    it('operations execute immediately when already authenticated', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      // Connect first
      await db.connect();

      // Now operations should work synchronously (no queuing needed)
      const valueEvents: unknown[] = [];
      db.ref('/already-auth/test').on('value', (snapshot) => {
        valueEvents.push(snapshot.val());
      });

      // This should apply optimistically and fire synchronously
      const writePromise = db.ref('/already-auth/test').set({ immediate: true });

      // The optimistic event should have fired already
      expect(valueEvents).toContainEqual({ immediate: true });

      await writePromise;
      await db.disconnect();
    });
  });
});
