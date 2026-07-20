/**
 * Integration tests for multiple subscribers.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';
import { getSharedDb, disconnectSharedDb, wait, uniquePath } from './integration-utils';

describe('Integration: Multiple Subscribers', () => {
  let db: LarkDatabase;

  beforeAll(async () => {
    db = await getSharedDb();
  });

  afterAll(async () => {
    await disconnectSharedDb();
  });

  it('multiple child_added listeners all receive same events', async () => {
    const path = uniquePath('test/subscribers/multi-listeners');
    const ref = db.ref(path);

    await ref.set(null);

    const listener1Keys: string[] = [];
    const listener2Keys: string[] = [];
    const listener3Keys: string[] = [];

    const unsub1 = ref.on('child_added', (snapshot) => {
      listener1Keys.push(snapshot.key!);
    });
    const unsub2 = ref.on('child_added', (snapshot) => {
      listener2Keys.push(snapshot.key!);
    });
    const unsub3 = ref.on('child_added', (snapshot) => {
      listener3Keys.push(snapshot.key!);
    });

    await wait(150);

    await ref.child('item1').set({ value: 1 });
    await ref.child('item2').set({ value: 2 });

    await wait(300);

    unsub1();
    unsub2();
    unsub3();

    // All listeners should have received the same events
    expect(listener1Keys).toEqual(listener2Keys);
    expect(listener2Keys).toEqual(listener3Keys);
    expect(listener1Keys).toContain('item1');
    expect(listener1Keys).toContain('item2');
  });

  it('unsubscribing one listener does not affect others', async () => {
    const path = uniquePath('test/subscribers/unsub-one');
    const ref = db.ref(path);

    await ref.set(null);

    const listener1Keys: string[] = [];
    const listener2Keys: string[] = [];

    const unsub1 = ref.on('child_added', (snapshot) => {
      listener1Keys.push(snapshot.key!);
    });
    const unsub2 = ref.on('child_added', (snapshot) => {
      listener2Keys.push(snapshot.key!);
    });

    await wait(150);

    await ref.child('before').set({ value: 1 });

    await wait(350); // Respect 3Hz rate limit

    // Unsubscribe first listener
    unsub1();

    await ref.child('after').set({ value: 2 });

    await wait(200);

    unsub2();

    // Listener 1 should only have 'before'
    expect(listener1Keys).toContain('before');
    expect(listener1Keys).not.toContain('after');

    // Listener 2 should have both
    expect(listener2Keys).toContain('before');
    expect(listener2Keys).toContain('after');
  });

  it('mixed event types (value + child_added) both receive correct events', async () => {
    const path = uniquePath('test/subscribers/mixed-events');
    const ref = db.ref(path);

    await ref.set({ initial: true });

    const valueSnapshots: unknown[] = [];
    const addedKeys: string[] = [];

    const unsub1 = ref.on('value', (snapshot) => {
      valueSnapshots.push(snapshot.val());
    });
    const unsub2 = ref.on('child_added', (snapshot) => {
      addedKeys.push(snapshot.key!);
    });

    await wait(200);

    await ref.child('newItem').set({ added: true });

    await wait(200);

    unsub1();
    unsub2();

    // value should have received snapshots
    expect(valueSnapshots.length).toBeGreaterThanOrEqual(1);

    // child_added should have received initial + newItem
    expect(addedKeys).toContain('initial');
    expect(addedKeys).toContain('newItem');
  });

  it('different paths can be subscribed independently', async () => {
    const path1 = uniquePath('test/subscribers/path1');
    const path2 = uniquePath('test/subscribers/path2');

    await db.ref(path1).set({ data: 'path1' });
    await db.ref(path2).set({ data: 'path2' });

    let value1: unknown = null;
    let value2: unknown = null;

    const unsub1 = db.ref(path1).on('value', (snapshot) => {
      value1 = snapshot.val();
    });
    const unsub2 = db.ref(path2).on('value', (snapshot) => {
      value2 = snapshot.val();
    });

    await wait(200);

    unsub1();
    unsub2();

    expect(value1).toEqual({ data: 'path1' });
    expect(value2).toEqual({ data: 'path2' });
  });

  it('subscribing to same path twice with different event types works', async () => {
    const path = uniquePath('test/subscribers/same-path-diff-events');
    const ref = db.ref(path);

    await ref.set({ existing: { value: 1 } });

    const valueSnapshots: unknown[] = [];
    const changedKeys: string[] = [];

    const unsub1 = ref.on('value', (snapshot) => {
      valueSnapshots.push(snapshot.val());
    });
    const unsub2 = ref.on('child_changed', (snapshot) => {
      changedKeys.push(snapshot.key!);
    });

    await wait(150);

    await ref.child('existing/value').set(2);

    await wait(200);

    unsub1();
    unsub2();

    // value should have snapshots
    expect(valueSnapshots.length).toBeGreaterThanOrEqual(1);

    // child_changed should have 'existing'
    expect(changedKeys).toContain('existing');
  });
});
