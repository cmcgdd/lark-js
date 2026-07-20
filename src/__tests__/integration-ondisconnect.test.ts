/**
 * Integration tests for onDisconnect behavior.
 *
 * Tests that server-side onDisconnect handlers fire correctly,
 * including when the client sends a remove() immediately before disconnect()
 * (race condition observed in real-world Vue apps).
 *
 * Each test creates its own database instance to avoid interference.
 */

import { describe, it, expect } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';

function generateDatabaseId(): string {
  const testRunId = `ondisconnect-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  return `javascript-integration/${testRunId}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniquePath(prefix: string): string {
  return `${prefix}/${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

describe('Integration: onDisconnect', { timeout: 15000 }, () => {
  it('onDisconnect().remove() fires after clean disconnect', async () => {
    const dbId = generateDatabaseId();
    const path = uniquePath('presence');

    // Connection 1: set up onDisconnect and write data
    const db1 = new LarkDatabase(dbId, { anonymous: true });
    await db1.connect();

    const ref1 = db1.ref(path);
    await ref1.onDisconnect().remove();
    await ref1.set({ username: 'alice', online: true });

    // Verify the data is there
    const snap1 = await ref1.once();
    expect(snap1.exists()).toBe(true);
    expect(snap1.val()).toEqual({ username: 'alice', online: true });

    // Disconnect - server should fire onDisconnect().remove()
    await db1.disconnect();

    // Wait for server to process the onDisconnect handler
    await wait(2000);

    // Connection 2: verify the data was removed
    const db2 = new LarkDatabase(dbId, { anonymous: true });
    await db2.connect();

    const snap2 = await db2.ref(path).once();
    expect(snap2.exists()).toBe(false);

    await db2.disconnect();
  });

  it('onDisconnect().remove() fires when remove() races with disconnect()', async () => {
    const dbId = generateDatabaseId();
    const path = uniquePath('presence');

    // Connection 1: set up onDisconnect and write data
    const db1 = new LarkDatabase(dbId, { anonymous: true });
    await db1.connect();

    const ref1 = db1.ref(path);
    await ref1.onDisconnect().remove();
    await ref1.set({ username: 'bob', online: true });

    // Verify the data is there
    const snap1 = await ref1.once();
    expect(snap1.exists()).toBe(true);

    // Simulate the buggy pattern: fire-and-forget remove() then immediately disconnect()
    // This is what happens in a Vue onUnmounted handler
    ref1.remove(); // NOT awaited
    await db1.disconnect();

    // Wait for server to process everything
    await wait(2000);

    // Connection 2: verify the data was removed by one mechanism or the other
    const db2 = new LarkDatabase(dbId, { anonymous: true });
    await db2.connect();

    const snap2 = await db2.ref(path).once();
    expect(snap2.exists()).toBe(false);

    await db2.disconnect();
  });

  it('onDisconnect().set() fires after disconnect', async () => {
    const dbId = generateDatabaseId();
    const path = uniquePath('status');

    // Connection 1: set up onDisconnect().set() and write initial data
    const db1 = new LarkDatabase(dbId, { anonymous: true });
    await db1.connect();

    const ref1 = db1.ref(path);
    await ref1.onDisconnect().set({ online: false, leftAt: 'disconnected' });
    await ref1.set({ online: true });

    // Disconnect
    await db1.disconnect();

    await wait(2000);

    // Connection 2: verify onDisconnect set the value
    const db2 = new LarkDatabase(dbId, { anonymous: true });
    await db2.connect();

    const snap2 = await db2.ref(path).once();
    expect(snap2.exists()).toBe(true);
    expect(snap2.val()).toEqual({ online: false, leftAt: 'disconnected' });

    await db2.disconnect();
  });

  it('onDisconnect().remove() on multiple paths fires after disconnect', async () => {
    const dbId = generateDatabaseId();
    const presencePath = uniquePath('presence');
    const typingPath = uniquePath('typing');

    // Connection 1: set up onDisconnect on two paths (like a chat app)
    const db1 = new LarkDatabase(dbId, { anonymous: true });
    await db1.connect();

    const presenceRef = db1.ref(presencePath);
    const typingRef = db1.ref(typingPath);

    await presenceRef.onDisconnect().remove();
    await typingRef.onDisconnect().remove();

    await presenceRef.set({ username: 'charlie', online: true });
    await typingRef.set({ username: 'charlie', typing: true });

    // Verify both exist
    const snapP = await presenceRef.once();
    const snapT = await typingRef.once();
    expect(snapP.exists()).toBe(true);
    expect(snapT.exists()).toBe(true);

    // Disconnect
    await db1.disconnect();

    await wait(2000);

    // Connection 2: verify both paths were removed
    const db2 = new LarkDatabase(dbId, { anonymous: true });
    await db2.connect();

    const snapP2 = await db2.ref(presencePath).once();
    const snapT2 = await db2.ref(typingPath).once();
    expect(snapP2.exists()).toBe(false);
    expect(snapT2.exists()).toBe(false);

    await db2.disconnect();
  });

  it('onDisconnect().remove() fires when unsubscribe + remove() + disconnect() race', async () => {
    const dbId = generateDatabaseId();
    const presencePath = uniquePath('presence');
    const typingPath = uniquePath('typing');

    // Connection 1: full chat app pattern - subscribe, set onDisconnect, write data
    const db1 = new LarkDatabase(dbId, { anonymous: true });
    await db1.connect();

    const presenceRef = db1.ref(presencePath);
    const typingRef = db1.ref(typingPath);

    await presenceRef.onDisconnect().remove();
    await typingRef.onDisconnect().remove();

    await presenceRef.set({ username: 'dave', online: true });
    await typingRef.set({ username: 'dave', typing: true });

    // Subscribe to both (like a real app would)
    const cleanups: Array<() => void> = [];
    cleanups.push(db1.ref(presencePath).on('value', () => {}));
    cleanups.push(db1.ref(typingPath).on('value', () => {}));

    // Wait for subscriptions to establish
    await wait(500);

    // Simulate Vue onUnmounted: unsubscribe, fire-and-forget removes, disconnect
    cleanups.forEach((fn) => fn());
    presenceRef.remove(); // NOT awaited
    typingRef.remove(); // NOT awaited
    await db1.disconnect();

    await wait(2000);

    // Connection 2: verify both paths were removed
    const db2 = new LarkDatabase(dbId, { anonymous: true });
    await db2.connect();

    const snapP2 = await db2.ref(presencePath).once();
    const snapT2 = await db2.ref(typingPath).once();
    expect(snapP2.exists()).toBe(false);
    expect(snapT2.exists()).toBe(false);

    await db2.disconnect();
  });

  it('onDisconnect().remove() fires without explicit remove() calls', async () => {
    const dbId = generateDatabaseId();
    const presencePath = uniquePath('presence');
    const typingPath = uniquePath('typing');

    // Connection 1: subscribe, set onDisconnect, write data
    const db1 = new LarkDatabase(dbId, { anonymous: true });
    await db1.connect();

    const presenceRef = db1.ref(presencePath);
    const typingRef = db1.ref(typingPath);

    await presenceRef.onDisconnect().remove();
    await typingRef.onDisconnect().remove();

    await presenceRef.set({ username: 'eve', online: true });
    await typingRef.set({ username: 'eve', typing: true });

    // Subscribe (like a real app)
    const cleanups: Array<() => void> = [];
    cleanups.push(db1.ref(presencePath).on('value', () => {}));
    cleanups.push(db1.ref(typingPath).on('value', () => {}));

    await wait(500);

    // Clean disconnect WITHOUT explicit remove() calls - just unsubscribe + disconnect
    cleanups.forEach((fn) => fn());
    await db1.disconnect();

    await wait(2000);

    // Connection 2: verify both paths were removed by onDisconnect handlers
    const db2 = new LarkDatabase(dbId, { anonymous: true });
    await db2.connect();

    const snapP2 = await db2.ref(presencePath).once();
    const snapT2 = await db2.ref(typingPath).once();
    expect(snapP2.exists()).toBe(false);
    expect(snapT2.exists()).toBe(false);

    await db2.disconnect();
  });
});
