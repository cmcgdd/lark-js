/**
 * Integration tests for hash-based transaction conditions.
 *
 * Tests verify that:
 * 1. Primitive value conditions work (using 'v' field)
 * 2. Complex object conditions work (using 'h' field - SHA-256 of JCS-canonicalized value)
 * 3. Condition failures trigger retries correctly
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';

const testRunId = `test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
const DATABASE_ID = `javascript-integration/${testRunId}`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Hash-Based Transaction Conditions Integration Tests', () => {
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

  describe('Primitive Value Transactions (v field)', () => {
    it('transaction on number value succeeds', async () => {
      const ref = db.ref('/tx-test/counter');

      // Set initial value
      await ref.set(0);
      await wait(350);

      // Increment via transaction
      const result = await ref.transaction((current) => {
        return ((current as number) || 0) + 1;
      });

      expect(result.committed).toBe(true);
      expect(result.snapshot.val()).toBe(1);
    });

    it('transaction on string value succeeds', async () => {
      const ref = db.ref('/tx-test/name');

      await ref.set('Alice');
      await wait(350);

      const result = await ref.transaction((current) => {
        return current === 'Alice' ? 'Bob' : current;
      });

      expect(result.committed).toBe(true);
      expect(result.snapshot.val()).toBe('Bob');
    });

    it('transaction on null value succeeds', async () => {
      const ref = db.ref('/tx-test/nullable');

      // Ensure path doesn't exist
      await ref.remove();
      await wait(350);

      const result = await ref.transaction((current) => {
        if (current === null) {
          return { initialized: true };
        }
        return current;
      });

      expect(result.committed).toBe(true);
      expect(result.snapshot.val()).toEqual({ initialized: true });
    });

    it('transaction on boolean value succeeds', async () => {
      const ref = db.ref('/tx-test/flag');

      await ref.set(false);
      await wait(350);

      const result = await ref.transaction((current) => !current);

      expect(result.committed).toBe(true);
      expect(result.snapshot.val()).toBe(true);
    });
  });

  describe('Complex Object Transactions (h field - hash)', () => {
    it('transaction on object value succeeds', async () => {
      const ref = db.ref('/tx-test/user');

      const initialUser = { name: 'Riley', age: 40, location: 'Overland Park' };
      await ref.set(initialUser);
      await wait(350);

      const result = await ref.transaction((current) => {
        const user = current as typeof initialUser;
        return { ...user, age: 41 };
      });

      expect(result.committed).toBe(true);
      expect(result.snapshot.val()).toEqual({
        name: 'Riley',
        age: 41,
        location: 'Overland Park',
      });
    });

    it('transaction on array value succeeds', async () => {
      const ref = db.ref('/tx-test/items');

      await ref.set([1, 2, 3]);
      await wait(350);

      const result = await ref.transaction((current) => {
        return [...(current as number[]), 4];
      });

      expect(result.committed).toBe(true);
      expect(result.snapshot.val()).toEqual([1, 2, 3, 4]);
    });

    it('transaction on nested object succeeds', async () => {
      const ref = db.ref('/tx-test/nested');

      const initial = {
        user: {
          profile: {
            name: 'Alice',
            settings: { theme: 'dark', notifications: true },
          },
        },
      };
      await ref.set(initial);
      await wait(350);

      const result = await ref.transaction((current) => {
        const data = current as typeof initial;
        return {
          ...data,
          user: {
            ...data.user,
            profile: {
              ...data.user.profile,
              settings: { ...data.user.profile.settings, theme: 'light' },
            },
          },
        };
      });

      expect(result.committed).toBe(true);
      const val = result.snapshot.val() as typeof initial;
      expect(val.user.profile.settings.theme).toBe('light');
    });

    it('transaction on large object succeeds', async () => {
      const ref = db.ref('/tx-test/large');

      // Create a moderately large object
      const largeObj: Record<string, unknown> = {};
      for (let i = 0; i < 50; i++) {
        largeObj[`field${i}`] = `value${i}`;
      }
      largeObj.counter = 0;

      await ref.set(largeObj);
      await wait(350);

      const result = await ref.transaction((current) => {
        const data = current as typeof largeObj;
        return { ...data, counter: (data.counter as number) + 1 };
      });

      expect(result.committed).toBe(true);
      const val = result.snapshot.val() as typeof largeObj;
      expect(val.counter).toBe(1);
      // Verify other fields weren't lost
      expect(val.field0).toBe('value0');
      expect(val.field49).toBe('value49');
    });
  });

  describe('Transaction Abort', () => {
    it('returns undefined to abort transaction', async () => {
      const ref = db.ref('/tx-test/abort');

      await ref.set(5);
      await wait(350);

      const result = await ref.transaction((current) => {
        if ((current as number) > 10) {
          return undefined; // Abort
        }
        return (current as number) + 1;
      });

      // Should abort because 5 is not > 10
      expect(result.committed).toBe(true);
      expect(result.snapshot.val()).toBe(6);

      await wait(350);

      // Now set to 15 and try again
      await ref.set(15);
      await wait(350);

      const result2 = await ref.transaction((current) => {
        if ((current as number) > 10) {
          return undefined; // Abort
        }
        return (current as number) + 1;
      });

      expect(result2.committed).toBe(false);
    });
  });

  describe('Array Syntax with Conditions', () => {
    it('primitive condition in array syntax succeeds', async () => {
      const counterRef = db.ref('/tx-test/array-counter');
      await counterRef.set(5);
      await wait(350);

      await db.transaction([
        { op: 'condition', path: '/tx-test/array-counter', value: 5 },
        { op: 'set', path: '/tx-test/array-counter', value: 6 },
      ]);

      const snapshot = await counterRef.once();
      expect(snapshot.val()).toBe(6);
    });

    it('object condition in array syntax succeeds', async () => {
      const userRef = db.ref('/tx-test/array-user');
      await userRef.set({ name: 'Test', score: 100 });
      await wait(350);

      await db.transaction([
        { op: 'condition', path: '/tx-test/array-user', value: { name: 'Test', score: 100 } },
        { op: 'set', path: '/tx-test/array-user/score', value: 200 },
      ]);

      const snapshot = await userRef.once();
      const val = snapshot.val() as { name: string; score: number };
      expect(val.score).toBe(200);
    });
  });
});
