/**
 * Integration tests for child_moved events when priority changes.
 *
 * Firebase fires child_moved when setPriority() changes a child's position
 * in the default (priority-based) ordering.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';

const TEST_DATABASE = 'javascript-integration/test';
const WRITE_DELAY = 350;

let db: LarkDatabase;

function uniquePath(prefix: string): string {
  return `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Integration: child_moved with Priority', () => {
  beforeAll(async () => {
    db = new LarkDatabase(TEST_DATABASE, { anonymous: true });
    await db.connect();
  });

  afterAll(async () => {
    await db.disconnect();
  });

  it('fires child_moved when setPriority changes sort order', async () => {
    const path = uniquePath('test/priority-moved');
    const ref = db.ref(path);

    // Set up initial data with priorities
    await ref.child('a').setWithPriority('first', 1);
    await pause(WRITE_DELAY);
    await ref.child('b').setWithPriority('second', 5);
    await pause(WRITE_DELAY);
    await ref.child('c').setWithPriority('third', 10);
    await pause(WRITE_DELAY);

    const movedEvents: { key: string; prevKey: string | null }[] = [];
    const changedEvents: string[] = [];

    // Subscribe WITHOUT orderBy - should use priority ordering by default
    const unsub1 = ref.on('child_moved', (snap, prevKey) => {
      movedEvents.push({ key: snap.key!, prevKey: prevKey ?? null });
    });

    const unsub2 = ref.on('child_changed', (snap) => {
      changedEvents.push(snap.key!);
    });

    await pause(300);

    // Change a's priority to 15 (should move from first to last)
    await ref.child('a').setPriority(15);
    await pause(WRITE_DELAY + 200);

    unsub1();
    unsub2();

    // child_moved should fire for 'a' since it moved from first to last
    const aMove = movedEvents.find(m => m.key === 'a');
    expect(aMove).toBeDefined();
    expect(aMove?.prevKey).toBe('c'); // Now after 'c'

    // child_changed should also fire
    expect(changedEvents).toContain('a');
  });

  it('fires child_moved when priority is reset to null', async () => {
    const path = uniquePath('test/priority-null');
    const ref = db.ref(path);

    // Set up data - 'a' and 'b' have priorities, will sort before 'c' (no priority)
    await ref.child('a').setWithPriority('a', 1);
    await pause(WRITE_DELAY);
    await ref.child('b').setWithPriority('b', 2);
    await pause(WRITE_DELAY);

    const movedEvents: { key: string; prevKey: string | null }[] = [];

    const unsub = ref.on('child_moved', (snap, prevKey) => {
      movedEvents.push({ key: snap.key!, prevKey: prevKey ?? null });
    });

    await pause(300);

    // Reset b's priority to null - should move it to sort by key after 'a'
    // (null priority items sort before numeric/string priority items by priority,
    // but after them when the null-priority item's key is greater)
    await ref.child('b').setPriority(null);
    await pause(WRITE_DELAY + 200);

    unsub();

    // b's priority changed, which should trigger child_moved
    const bMove = movedEvents.find(m => m.key === 'b');
    expect(bMove).toBeDefined();
  });

  it('DOES fire child_moved when priority changes even if order stays same (Firebase Case 2003)', async () => {
    // Firebase behavior: child_moved fires for ANY priority change when ordering by priority,
    // regardless of whether the position actually changes. This is "Case 2003" behavior.
    const path = uniquePath('test/priority-no-move');
    const ref = db.ref(path);

    // Set up data with gaps in priority
    await ref.child('a').setWithPriority('a', 1);
    await pause(WRITE_DELAY);
    await ref.child('b').setWithPriority('b', 10);
    await pause(WRITE_DELAY);
    await ref.child('c').setWithPriority('c', 100);
    await pause(WRITE_DELAY);

    const movedEvents: string[] = [];
    const changedEvents: string[] = [];

    const unsub1 = ref.on('child_moved', (snap) => {
      movedEvents.push(snap.key!);
    });

    const unsub2 = ref.on('child_changed', (snap) => {
      changedEvents.push(snap.key!);
    });

    await pause(300);

    // Change b's priority but keep it between a(1) and c(100)
    await ref.child('b').setPriority(50);
    await pause(WRITE_DELAY + 200);

    unsub1();
    unsub2();

    // child_changed should fire
    expect(changedEvents).toContain('b');

    // Firebase Case 2003: child_moved DOES fire for ANY priority change
    expect(movedEvents).toContain('b');
  });

  it('fires child_moved with orderByPriority() explicit ordering', async () => {
    const path = uniquePath('test/priority-explicit');
    const ref = db.ref(path);

    await ref.child('x').setWithPriority('x', 10);
    await pause(WRITE_DELAY);
    await ref.child('y').setWithPriority('y', 20);
    await pause(WRITE_DELAY);
    await ref.child('z').setWithPriority('z', 30);
    await pause(WRITE_DELAY);

    const movedEvents: { key: string; prevKey: string | null }[] = [];

    // Explicit orderByPriority
    const unsub = ref.orderByPriority().on('child_moved', (snap, prevKey) => {
      movedEvents.push({ key: snap.key!, prevKey: prevKey ?? null });
    });

    await pause(300);

    // Move x to last
    await ref.child('x').setPriority(100);
    await pause(WRITE_DELAY + 200);

    unsub();

    const xMove = movedEvents.find(m => m.key === 'x');
    expect(xMove).toBeDefined();
    expect(xMove?.prevKey).toBe('z');
  });
});
