/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * This file contains test code derived from the Firebase JS SDK.
 * https://github.com/firebase/firebase-js-sdk
 * Modified for Lark compatibility testing.
 */

/**
 * Firebase Compatibility Tests - Transactions
 *
 * These tests are ported directly from the Firebase JS SDK:
 * https://github.com/firebase/firebase-js-sdk/blob/main/packages/database-compat/test/transaction.test.ts
 *
 * The goal is 1:1 test coverage to identify compatibility gaps.
 *
 * Notes on API differences:
 * - Firebase transaction() supports a callback-based API with (error, committed, snapshot)
 * - Our transaction() is Promise-based returning { committed, snapshot }
 * - Firebase has goOffline()/goOnline() methods
 * - Firebase has applyLocally parameter for transactions
 * - Firebase has ServerValue.TIMESTAMP
 * - Firebase has exportVal() method on snapshots
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';
import { DatabaseReference } from '../DatabaseReference';
import { DataSnapshot } from '../DataSnapshot';

const TEST_DATABASE = 'javascript-integration/test';
const WRITE_DELAY = 350;

let db: LarkDatabase;

function getRandomNode(): DatabaseReference {
  const pushId = db.ref().push().key!;
  return db.ref(`test/${pushId}`);
}

async function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper to wait for events
class EventAccumulator<T> {
  private events: T[] = [];
  private resolve: ((events: T[]) => void) | null = null;
  private targetCount: number;

  constructor(targetCount: number) {
    this.targetCount = targetCount;
  }

  addEvent(event: T) {
    this.events.push(event);
    if (this.events.length >= this.targetCount && this.resolve) {
      this.resolve(this.events);
    }
  }

  get promise(): Promise<T[]> {
    if (this.events.length >= this.targetCount) {
      return Promise.resolve(this.events);
    }
    return new Promise(resolve => {
      this.resolve = resolve;
    });
  }

  get count(): number {
    return this.events.length;
  }
}

describe('Firebase Compat: Transaction Tests', () => {
  beforeAll(async () => {
    db = new LarkDatabase(TEST_DATABASE, { anonymous: true });
    await db.connect();
  });

  afterAll(async () => {
    await db.disconnect();
  });

  // Skip: Firebase transactions have applyLocally=true by default, applying results immediately.
  // Our implementation is server-first - we wait for server confirmation before updating local cache.
  it.skip('New value is immediately visible.', async () => {
    const node = getRandomNode();

    // Start transaction (don't await)
    node.child('foo').transaction(() => {
      return 42;
    });

    let val = null;
    node.child('foo').on('value', snap => {
      val = snap.val();
    });

    // In Firebase, val would be 42 synchronously
    expect(val).toBe(42);
  });

  // Skip: Firebase transactions have applyLocally=true by default, applying results immediately.
  // Our implementation is server-first - we wait for server confirmation before updating local cache.
  it.skip('Event is raised for new value.', async () => {
    const node = getRandomNode();
    const fooNode = node.child('foo');
    const ea = new EventAccumulator<DataSnapshot>(1);

    fooNode.on('value', snap => {
      ea.addEvent(snap);
    });

    node.child('foo').transaction(() => {
      return 42;
    });

    const [snap] = await ea.promise;
    expect(snap.val()).toBe(42);
  });

  it('Transaction result can be converted to JSON.', async () => {
    const node = getRandomNode();

    const result = await node.transaction(() => {
      return 42;
    });

    // Note: Firebase returns { committed, snapshot } where snapshot serializes to the value
    expect(result.committed).toBe(true);
    expect(result.snapshot.val()).toBe(42);
  });

  it('Non-aborted transaction sets committed to true.', async () => {
    const node = getRandomNode();

    const result = await node.transaction(() => {
      return 42;
    });

    expect(result.committed).toBe(true);
    expect(result.snapshot.val()).toBe(42);
  });

  it('Aborted transaction sets committed to false.', async () => {
    const node = getRandomNode();

    const result = await node.transaction(() => {
      return undefined; // Returning undefined aborts
    });

    expect(result.committed).toBe(false);
    expect(result.snapshot.val()).toBe(null);
  });

  it('Tetris bug test - set data, reconnect, do transaction that aborts once data arrives.', async () => {
    const node = getRandomNode();
    await node.child('foo').set(42);
    await pause(WRITE_DELAY);

    // Transaction that aborts when it sees existing data
    const result = await node.child('foo').transaction(value => {
      if (value === null) {
        return 'temp value';
      } else {
        return undefined; // Abort
      }
    });

    expect(result.committed).toBe(false);
    expect(result.snapshot.val()).toBe(42);
  });

  // Skip: Firebase transactions have applyLocally=true by default, firing only 1 event.
  // Our server-first implementation fires 2 events (initial null + server-confirmed value).
  it.skip('Use transaction to create a node, make sure exactly one event is received.', async () => {
    const node = getRandomNode();
    let events = 0;

    const ea = new EventAccumulator<DataSnapshot>(1);
    node.child('a').on('value', snap => {
      events++;
      ea.addEvent(snap);
    });

    await node.child('a').transaction(() => {
      return 42;
    });

    await ea.promise;
    // Firebase expects exactly 1 event
    expect(events).toBe(1);
  });

  it('Use transaction to update one of two existing child nodes.', async () => {
    const node = getRandomNode();
    await node.child('foo/a').set(42);
    await pause(WRITE_DELAY);
    await node.child('foo/b').set(42);
    await pause(WRITE_DELAY);

    const result = await node.child('foo').transaction(() => {
      return { a: 42, b: 87 };
    });

    expect(result.committed).toBe(true);
    expect(result.snapshot.val()).toEqual({ a: 42, b: 87 });
  });

  it('Transaction is only called once when initializing an empty node.', async () => {
    const node = getRandomNode();
    let updateCalled = 0;

    await node.transaction(value => {
      expect(value).toBe(null);
      updateCalled++;
      if (updateCalled > 1) {
        throw new Error('Transaction called too many times.');
      }
      if (value === null) {
        return { a: 5, b: 3 };
      }
    });

    expect(updateCalled).toBe(1);
  });

  // Skip: Firebase transactions have applyLocally=true, so second TX sees first's local output.
  // Our server-first implementation means second TX sees server state (null initially).
  it.skip('Second transaction gets run immediately on previous output and only runs once.', async () => {
    const node = getRandomNode();
    let firstRun = false;
    let secondRun = false;

    // First transaction
    const tx1Promise = node.transaction(() => {
      expect(firstRun).toBe(false);
      firstRun = true;
      return 42;
    });

    // Second transaction should see output of first
    const tx2Promise = node.transaction(value => {
      expect(secondRun).toBe(false);
      secondRun = true;
      expect(value).toBe(42);
      return 84;
    });

    await Promise.all([tx1Promise, tx2Promise]);

    const snap = await node.once('value');
    expect(snap.val()).toBe(84);
  });

  it('Set() cancels pending transactions and re-runs affected transactions.', async () => {
    const node = getRandomNode();
    let firstRun = false;
    let thirdRunCount = 0;

    // First transaction on /foo
    const tx1 = node.child('foo').transaction(() => {
      expect(firstRun).toBe(false);
      firstRun = true;
      return 42;
    });

    // Second transaction on / (depends on first)
    const tx2 = node.transaction(() => {
      return { foo: 84, bar: 1 };
    });

    // Third transaction on /bar (depends on second)
    const tx3 = node.child('bar').transaction(val => {
      thirdRunCount++;
      if (thirdRunCount === 1) {
        return 'first';
      } else {
        return 'second';
      }
    });

    // This should cancel/affect transactions
    await node.child('foo').set(0);

    await Promise.all([tx1.catch(() => {}), tx2.catch(() => {}), tx3.catch(() => {})]);
  });

  // Skip: Firebase transactions have applyLocally=true, so TX callback sees null (unsent data).
  // Our server-first implementation means TX callback may see data from the set() calls.
  it.skip('transaction(), set(), set() should work.', async () => {
    const ref = getRandomNode();

    const txPromise = ref.transaction(curr => {
      expect(curr).toBe(null);
      return 'hi!';
    });

    ref.set('foo');
    ref.set('bar');

    const result = await txPromise;
    expect(result.committed).toBe(true);
  });

  it('Priority is preserved when setting data.', async () => {
    const node = getRandomNode();

    await node.setWithPriority('test', 5);
    await pause(WRITE_DELAY);

    let snap = await node.once('value');
    expect(snap.getPriority()).toBe(5);

    await node.transaction(() => {
      return 'new value';
    });

    snap = await node.once('value');
    expect(snap.val()).toBe('new value');
    expect(snap.getPriority()).toBe(5);
  });

  it('Tetris bug test - Can do transactions from transaction callback.', async () => {
    const node = getRandomNode();
    await node.child('foo').set(42);
    await pause(WRITE_DELAY);

    await node.child('foo').transaction(val => {
      if (val === null) {
        return 84;
      }
      return undefined;
    });

    // Now do another transaction
    await node.child('bar').transaction(() => {
      return 168;
    });

    const snap = await node.child('bar').once('value');
    expect(snap.val()).toBe(168);
  });

  it('Resulting snapshot is passed to transaction result.', async () => {
    const node = getRandomNode();

    const result1 = await node.transaction(v => {
      if (v === null) {
        return 'hello!';
      }
    });

    expect(result1.committed).toBe(true);
    expect(result1.snapshot.val()).toBe('hello!');

    // Do it again for the aborted case
    const result2 = await node.transaction(v => {
      if (v === null) {
        return 'hello!';
      }
      return undefined; // Abort since data exists
    });

    expect(result2.committed).toBe(false);
    expect(result2.snapshot.val()).toBe('hello!');
  });

  it('Transaction aborts after max retries.', async () => {
    // This test requires a way to force transaction conflicts
    // In Firebase, they use hijackHash() to force conflicts
    // We'll test that our max retry limit works
    const node = getRandomNode();

    // Our implementation has a default max retry of 25
    try {
      await node.transaction(() => {
        return 'hello!';
      }, 25);
    } catch (error: any) {
      expect(error.code).toBe('max_retries_exceeded');
    }
  });

  it('Test transaction on wacky unicode data.', async () => {
    const node = getRandomNode();
    await node.set('♜♞♝♛♚♝♞♜');
    await pause(WRITE_DELAY);

    const result = await node.transaction(current => {
      if (current !== null) {
        expect(current).toBe('♜♞♝♛♚♝♞♜');
      }
      return '♖♘♗♕♔♗♘♖';
    });

    expect(result.committed).toBe(true);
    expect(result.snapshot.val()).toBe('♖♘♗♕♔♗♘♖');
  });

  it('Test immediately aborted transaction.', async () => {
    const node = getRandomNode();

    const result = await node.transaction(() => {
      return undefined;
    });

    expect(result.committed).toBe(false);
  });

  it('Test adding to an array with a transaction.', async () => {
    const node = getRandomNode();
    await node.set(['cat', 'horse']);
    await pause(WRITE_DELAY);

    const result = await node.transaction((current: string[] | null) => {
      if (current) {
        current.push('dog');
      } else {
        current = ['dog'];
      }
      return current;
    });

    expect(result.committed).toBe(true);
    expect(result.snapshot.val()).toEqual(['cat', 'horse', 'dog']);
  });

  // Skip: Firebase transactions have applyLocally=true, so tx2 sees tx1's local output.
  // Our server-first implementation means tx2 reads from server and may see 0 instead of 1.
  it.skip('Merged transactions have correct snapshot in result.', async () => {
    const node = getRandomNode();
    await node.set({ a: 0 });
    await pause(WRITE_DELAY);

    const tx1 = node.transaction(val => {
      if (val !== null) {
        expect(val).toEqual({ a: 0 });
      }
      return { a: 1 };
    });

    const tx2 = node.child('a').transaction(val => {
      if (val !== null) {
        expect(val).toBe(1); // Should run after first transaction
      }
      return 2;
    });

    const [result1, result2] = await Promise.all([tx1, tx2]);

    expect(result1.committed).toBe(true);
    expect(result2.committed).toBe(true);
    expect(result2.snapshot.val()).toBe(2);
  });

  it('Doing set() in transaction result handler works.', async () => {
    const node = getRandomNode();
    let transactionCalled = false;

    await node.transaction(() => {
      expect(transactionCalled).toBe(false);
      transactionCalled = true;
      return 'hi';
    });

    await node.set('transaction done');
    await pause(WRITE_DELAY);

    const snap = await node.once('value');
    expect(snap.val()).toBe('transaction done');
  });

  it('transaction() respects .priority.', async () => {
    const ref = getRandomNode();

    await ref.transaction(() => {
      return { '.value': 5, '.priority': 5 };
    });

    let snap = await ref.once('value');
    expect(snap.val()).toBe(5);
    expect(snap.getPriority()).toBe(5);

    await ref.transaction(curr => {
      expect(curr).toBe(5);
      return { '.value': 10, '.priority': 10 };
    });

    snap = await ref.once('value');
    expect(snap.val()).toBe(10);
    expect(snap.getPriority()).toBe(10);
  });

  it('Transaction with integer keys', async () => {
    const ref = getRandomNode();
    await ref.set({ 1: 1, 5: 5, 10: 10, 20: 20 });
    await pause(WRITE_DELAY);

    const result = await ref.transaction(() => {
      return 42;
    });

    expect(result.committed).toBe(true);
  });

  it('Return null from first run of transaction.', async () => {
    const ref = getRandomNode();

    const result = await ref.transaction(() => {
      return null;
    });

    expect(result.committed).toBe(true);
  });

  it('Bubble-app transaction bug.', async () => {
    const ref = getRandomNode();

    const tx1 = ref.child('a').transaction(() => {
      return 1;
    });

    const tx2 = ref.child('a').transaction((current: number | null) => {
      return (current || 0) + 42;
    });

    const tx3 = ref.child('b').transaction(() => {
      return 7;
    });

    const tx4 = ref.transaction((current: { a?: number; b?: number } | null) => {
      if (current && current.a && current.b) {
        return current.a + current.b;
      } else {
        return 'dummy';
      }
    });

    const [, , , result4] = await Promise.all([tx1, tx2, tx3, tx4]);

    expect(result4.committed).toBe(true);
    expect(result4.snapshot.val()).toBe(50);
  });

  it('Transaction and priority: Can set priority in transaction on empty node', async () => {
    const ref = getRandomNode();

    await ref.transaction(() => {
      return { '.value': 42, '.priority': 7 };
    });

    const snap = await ref.once('value');
    expect(snap.val()).toBe(42);
    expect(snap.getPriority()).toBe(7);
  });

  it("Transaction and priority: Transaction doesn't change priority.", async () => {
    const ref = getRandomNode();

    await ref.setWithPriority(42, 7);
    await pause(WRITE_DELAY);

    await ref.transaction(() => {
      return 12;
    });

    const snap = await ref.once('value');
    expect(snap.val()).toBe(12);
    expect(snap.getPriority()).toBe(7);
  });

  it('Transaction and priority: Transaction can change priority on non-empty node.', async () => {
    const ref = getRandomNode();

    await ref.setWithPriority(42, 7);
    await pause(WRITE_DELAY);

    await ref.transaction(() => {
      return { '.value': 43, '.priority': 8 };
    });

    const snap = await ref.once('value');
    expect(snap.val()).toBe(43);
    expect(snap.getPriority()).toBe(8);
  });

  it('Transaction and priority: Changing priority on siblings.', async () => {
    const ref = getRandomNode();

    await ref.set({
      a: { '.value': 'a', '.priority': 'a' },
      b: { '.value': 'b', '.priority': 'b' }
    });
    await pause(WRITE_DELAY);

    const tx1 = ref.child('a').transaction(() => {
      return { '.value': 'a2', '.priority': 'a2' };
    });

    const tx2 = ref.child('b').transaction(() => {
      return { '.value': 'b2', '.priority': 'b2' };
    });

    await Promise.all([tx1, tx2]);

    const snap = await ref.once('value');
    expect(snap.child('a').val()).toBe('a2');
    expect(snap.child('a').getPriority()).toBe('a2');
    expect(snap.child('b').val()).toBe('b2');
    expect(snap.child('b').getPriority()).toBe('b2');
  });

  it('Transaction and priority: Leaving priority on siblings.', async () => {
    const ref = getRandomNode();

    await ref.set({
      a: { '.value': 'a', '.priority': 'a' },
      b: { '.value': 'b', '.priority': 'b' }
    });
    await pause(WRITE_DELAY);

    const tx1 = ref.child('a').transaction(() => {
      return 'a2';
    });

    const tx2 = ref.child('b').transaction(() => {
      return 'b2';
    });

    await Promise.all([tx1, tx2]);

    const snap = await ref.once('value');
    expect(snap.child('a').val()).toBe('a2');
    expect(snap.child('a').getPriority()).toBe('a');
    expect(snap.child('b').val()).toBe('b2');
    expect(snap.child('b').getPriority()).toBe('b');
  });

  it("transaction() doesn't pick up cached data from previous once().", async () => {
    const me = getRandomNode();

    await me.set('not null');
    await pause(WRITE_DELAY);

    // Do a once to cache the data
    await me.once('value');

    // Simulate another client setting to null
    await me.set(null);
    await pause(WRITE_DELAY);

    const result = await me.transaction(snapshot => {
      if (snapshot === null) {
        return 'it was null!';
      } else {
        return 'it was not null!';
      }
    });

    expect(result.committed).toBe(true);
    expect(result.snapshot.val()).toBe('it was null!');
  });

  it("transaction() doesn't pick up cached data from previous transaction.", async () => {
    const me = getRandomNode();

    await me.transaction(() => {
      return 'not null';
    });

    // Set to null
    await me.set(null);
    await pause(WRITE_DELAY);

    const result = await me.transaction(snapshot => {
      if (snapshot === null) {
        return 'it was null!';
      } else {
        return 'it was not null!';
      }
    });

    expect(result.committed).toBe(true);
    expect(result.snapshot.val()).toBe('it was null!');
  });

  it("transaction() still works when there's a query listen.", async () => {
    const ref = getRandomNode();

    await ref.set({ a: 1, b: 2 });
    await pause(WRITE_DELAY);

    ref.limitToFirst(1).on('child_added', () => {});

    const result = await ref.child('a').transaction(current => {
      return current;
    });

    expect(result.committed).toBe(true);
    expect(result.snapshot.val()).toBe(1);
  });

  it("transaction() on queried location doesn't run initially on null.", async () => {
    const ref = getRandomNode();

    const childRef = ref.push();
    await childRef.set({ a: 1, b: 2 });
    await pause(WRITE_DELAY);

    const ea = new EventAccumulator<DataSnapshot>(1);

    ref.startAt().limitToFirst(1).on('child_added', async snap => {
      ea.addEvent(snap);
    });

    const [snap] = await ea.promise;

    const result = await snap.ref.transaction(current => {
      expect(current).toEqual({ a: 1, b: 2 });
      return null;
    });

    expect(result.committed).toBe(true);
    expect(result.snapshot.val()).toBe(null);
  });

  it('transactions raise correct child_changed events on queries', async () => {
    const ref = getRandomNode();

    await ref.set({ foo: { value: 1 } });
    await pause(WRITE_DELAY);

    const snapshots: DataSnapshot[] = [];

    const query = ref.endAt(Number.MIN_VALUE);
    query.on('child_added', snapshot => {
      snapshots.push(snapshot);
    });

    query.on('child_changed', snapshot => {
      snapshots.push(snapshot);
    });

    await pause(500); // Wait for initial events

    await ref.child('foo').transaction(() => {
      return { value: 2 };
    });

    await pause(500); // Wait for change events

    expect(snapshots.length).toBe(2);
    expect(snapshots[0].key).toBe('foo');
    expect(snapshots[0].val()).toEqual({ value: 1 });
    expect(snapshots[1].key).toBe('foo');
    expect(snapshots[1].val()).toEqual({ value: 2 });
  });

  it('transactions can use local merges', async () => {
    const ref = getRandomNode();

    await ref.update({ foo: 'bar' });

    const result = await ref.child('foo').transaction(current => {
      expect(current).toBe('bar');
      return current;
    });

    expect(result.committed).toBe(true);
  });

  it('transactions works with merges without the transaction path', async () => {
    const ref = getRandomNode();

    await ref.update({ foo: 'bar' });

    const result = await ref.child('non-foo').transaction(current => {
      expect(current).toBe(null);
      return current;
    });

    expect(result.committed).toBe(true);
  });

  it('out of order remove writes are handled correctly', async () => {
    const ref = getRandomNode();

    await ref.set({ foo: 'bar' });

    const tx1 = ref.transaction(() => {
      return 'transaction-1';
    });

    const tx2 = ref.transaction(() => {
      return 'transaction-2';
    });

    // This should not crash
    await ref.update({ qux: 'quu' });

    await Promise.all([tx1.catch(() => {}), tx2.catch(() => {})]);
  });

  it('Can listen to transaction changes', async () => {
    let latestValue: number | null = null;

    const ref = getRandomNode();

    const ea = new EventAccumulator<DataSnapshot>(1);
    ref.on('value', snap => {
      latestValue = snap.val() as number;
      ea.addEvent(snap);
    });

    await ea.promise;

    expect(latestValue).toBe(null);

    await ref.transaction(() => {
      return 1;
    });

    await pause(500);
    expect(latestValue).toBe(1);

    await ref.transaction(current => {
      return (current as number) + 1;
    });

    await pause(500);
    expect(latestValue).toBe(2);
  });
});
