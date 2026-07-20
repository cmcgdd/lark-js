/**
 * Integration tests for array storage and read coercion.
 *
 * Verifies, against a live server, that:
 * 1. Arrays round-trip as arrays.
 * 2. A partial write to one element preserves the others and still renders as
 *    an array.
 * 3. Transactions can add to an array.
 * 4. A sparse array (after deletes) renders as an object per `maxKey < 2*numKeys`.
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';

const testRunId = `test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
const DATABASE_ID = `javascript-integration/${testRunId}`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Array Integration Tests', () => {
  let db: LarkDatabase;

  beforeAll(async () => {
    db = new LarkDatabase(DATABASE_ID, { anonymous: true });
    await db.connect();
  });

  afterAll(async () => {
    if (db.connected) {
      await db.disconnect();
    }
  });

  it('round-trips a dense array', async () => {
    const ref = db.ref('/arrtest/basic');
    await ref.set(['a', 'b', 'c']);
    await wait(350);
    const snap = await ref.once();
    expect(snap.val()).toEqual(['a', 'b', 'c']);
  });

  it('preserves siblings on a partial element write and still renders as an array', async () => {
    await db.ref('/arrtest/items').set([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
      { a: 5, b: 6 },
    ]);
    await wait(350);

    await db.ref('/arrtest/items/0/b').set(99);
    await wait(350);

    const snap = await db.ref('/arrtest/items').once();
    expect(snap.val()).toEqual([
      { a: 1, b: 99 },
      { a: 3, b: 4 },
      { a: 5, b: 6 },
    ]);
  });

  it('adds to an array with a transaction', async () => {
    const ref = db.ref('/arrtest/tx');
    await ref.set(['cat', 'horse']);
    await wait(350);

    const result = await ref.transaction((current: string[] | null) => {
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

  it('renders a sparse array as an object after deletes', async () => {
    await db.ref('/arrtest/sparse').set(['a', 'b', 'c', 'd', 'e']);
    await wait(350);

    // Remove 0, 1, 3 -> {2,4}: maxKey 4 is not < 2*2, so it renders as an object.
    await db.ref('/arrtest/sparse/0').remove();
    await db.ref('/arrtest/sparse/1').remove();
    await db.ref('/arrtest/sparse/3').remove();
    await wait(350);

    const snap = await db.ref('/arrtest/sparse').once();
    expect(snap.val()).toEqual({ '2': 'c', '4': 'e' });
  });
});
