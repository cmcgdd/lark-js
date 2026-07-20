/**
 * Integration tests for reconnection behavior.
 *
 * IMPORTANT: This file is completely isolated - it does NOT import from
 * integration-utils.ts to avoid interfering with other integration tests.
 * Each test creates and cleans up its own database instance.
 */

import { describe, it, expect } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';
import { DataSnapshot } from '../DataSnapshot';

function generateDatabaseId(): string {
  const testRunId = `reconnect-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  return `javascript-integration/${testRunId}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniquePath(prefix: string): string {
  return `${prefix}/${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

describe('Integration: Reconnection', () => {
  describe('State properties', () => {
    it('connected is true after connect, false after disconnect', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      await db.connect();
      expect(db.connected).toBe(true);
      expect(db.state).toBe('authenticated');
      expect(db.reconnecting).toBe(false);

      await db.disconnect();
      expect(db.connected).toBe(false);
      expect(db.state).toBe('disconnected');
      expect(db.reconnecting).toBe(false);
    });
  });

  describe('Manual disconnect and reconnect', () => {
    it('can reconnect after disconnect', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      await db.connect();
      expect(db.connected).toBe(true);

      await db.disconnect();
      expect(db.connected).toBe(false);

      await db.connect();
      expect(db.connected).toBe(true);

      await db.disconnect();
    });

    it('writes work after reconnect', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });
      const path = uniquePath('reconnect/write');

      await db.connect();
      await db.ref(path).set({ value: 42 });

      await db.disconnect();

      await db.connect();
      const snapshot = await db.ref(path).once();
      expect(snapshot.val()).toEqual({ value: 42 });

      await db.disconnect();
    });

    it('subscriptions can be re-established after reconnect', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });
      const path = uniquePath('reconnect/sub');
      const received: unknown[] = [];

      await db.connect();

      // Write initial data
      await db.ref(path).set({ initial: true });
      await wait(100);

      await db.disconnect();
      await db.connect();

      // Subscribe after reconnect
      const unsub = db.ref(path).on('value', (snap: DataSnapshot) => {
        received.push(snap.val());
      });

      // Wait for initial value
      await wait(200);

      // Update data
      await db.ref(path).set({ updated: true });
      await wait(350);

      unsub();

      // Should have received initial and updated values
      expect(received.length).toBeGreaterThanOrEqual(2);
      expect(received[0]).toEqual({ initial: true });
      expect(received[received.length - 1]).toEqual({ updated: true });

      await db.disconnect();
    });
  });

  describe('Callbacks', () => {
    it('onConnect fires on initial connect', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });
      let connectCalled = false;

      db.onConnect(() => {
        connectCalled = true;
      });

      await db.connect();
      expect(connectCalled).toBe(true);

      await db.disconnect();
    });

    it('onDisconnect fires when disconnecting', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });
      let disconnectCalled = false;

      await db.connect();

      db.onDisconnect(() => {
        disconnectCalled = true;
      });

      await db.disconnect();
      expect(disconnectCalled).toBe(true);
    });

    it('onConnect fires again after manual reconnect', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });
      let connectCount = 0;

      db.onConnect(() => {
        connectCount++;
      });

      await db.connect();
      expect(connectCount).toBe(1);

      await db.disconnect();

      await db.connect();
      expect(connectCount).toBe(2);

      await db.disconnect();
    });
  });

  describe('Multiple databases', () => {
    it('separate database instances can connect independently', async () => {
      const dbId = generateDatabaseId();
      const db1 = new LarkDatabase(dbId, { anonymous: true });
      const db2 = new LarkDatabase(dbId, { anonymous: true });
      const path = uniquePath('reconnect/multi');

      await db1.connect();
      await db2.connect();

      expect(db1.connected).toBe(true);
      expect(db2.connected).toBe(true);

      // Write from db1, read from db2
      await db1.ref(path).set({ from: 'db1' });
      await wait(200);

      const snapshot = await db2.ref(path).once();
      expect(snapshot.val()).toEqual({ from: 'db1' });

      await db1.disconnect();
      await db2.disconnect();
    });

    it('disconnecting one database does not affect another', async () => {
      const dbId = generateDatabaseId();
      const db1 = new LarkDatabase(dbId, { anonymous: true });
      const db2 = new LarkDatabase(dbId, { anonymous: true });
      const path = uniquePath('reconnect/multi2');

      await db1.connect();
      await db2.connect();

      await db1.disconnect();

      expect(db1.connected).toBe(false);
      expect(db2.connected).toBe(true);

      // db2 should still work
      await db2.ref(path).set({ still: 'working' });
      const snapshot = await db2.ref(path).once();
      expect(snapshot.val()).toEqual({ still: 'working' });

      await db2.disconnect();
    });
  });

  describe('Connection state during operations', () => {
    it('lazy connects when writing without explicit connect()', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      // Should auto-connect
      await db.ref('/test').set({ value: 1 });
      expect(db.connected).toBe(true);

      await db.disconnect();
    });

    it('lazy connects when reading without explicit connect()', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      // Should auto-connect
      const snapshot = await db.ref('/test').once();
      expect(db.connected).toBe(true);

      await db.disconnect();
    });
  });

  describe('Auth preservation', () => {
    it('auth is available after connect, null after disconnect', async () => {
      const dbId = generateDatabaseId();
      const db = new LarkDatabase(dbId, { anonymous: true });

      await db.connect();
      expect(db.auth).not.toBeNull();
      expect(db.auth?.uid).toBeDefined();
      expect(db.auth?.provider).toBe('anonymous');

      await db.disconnect();
      expect(db.auth).toBeNull();
    });

    it('auth info is set for each anonymous connect', async () => {
      const dbId = generateDatabaseId();
      const db1 = new LarkDatabase(dbId, { anonymous: true });
      const db2 = new LarkDatabase(dbId, { anonymous: true });

      await db1.connect();
      await db2.connect();

      // Both connections have auth info
      expect(db1.auth).not.toBeNull();
      expect(db2.auth).not.toBeNull();
      expect(db1.auth?.provider).toBe('anonymous');
      expect(db2.auth?.provider).toBe('anonymous');

      await db1.disconnect();
      await db2.disconnect();
    });
  });
});
