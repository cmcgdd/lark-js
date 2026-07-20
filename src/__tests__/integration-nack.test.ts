/**
 * Integration tests for NACK handling.
 *
 * These tests verify:
 * 1. Writes to denied paths get permission_denied
 * 2. Optimistic updates fire before nack
 * 3. NACK on one path does not affect unrelated paths
 *
 * Requires security rules on javascript-integration project:
 * - /__denied__/* - read: false, write: false
 * - /__write_denied__/* - read: true, write: false
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';

// Generate a unique database ID for this test run
const testRunId = `test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
const DATABASE_ID = `javascript-integration/${testRunId}`;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Server enforces 3Hz write rate limit
const WRITE_DELAY = 350;

describe('NACK Handling Integration Tests', () => {
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

  describe('Permission Denied', () => {
    it('write to __denied__ path rejects with permission_denied', async () => {
      const ref = db.ref('/__denied__/test');

      await expect(ref.set({ foo: 'bar' })).rejects.toMatchObject({
        code: 'permission_denied',
      });
    });

    it('write to __write_denied__ path rejects with permission_denied', async () => {
      const ref = db.ref('/__write_denied__/test');

      await expect(ref.set({ foo: 'bar' })).rejects.toMatchObject({
        code: 'permission_denied',
      });
    });

    it('update to denied path rejects with permission_denied', async () => {
      const ref = db.ref('/__denied__/test');

      await expect(ref.update({ foo: 'bar' })).rejects.toMatchObject({
        code: 'permission_denied',
      });
    });

    it('remove on denied path rejects with permission_denied', async () => {
      const ref = db.ref('/__denied__/test');

      await expect(ref.remove()).rejects.toMatchObject({
        code: 'permission_denied',
      });
    });
  });

  describe('NACK Does Not Affect Unrelated Views', () => {
    it('nack on one View does not affect writes to unrelated paths', async () => {
      // Subscribe to a denied path
      const deniedRef = db.ref('/__write_denied__');
      const deniedCallback = vi.fn();
      const deniedUnsubscribe = deniedRef.on('value', deniedCallback);
      await delay(200);

      // Subscribe to an unrelated normal path
      const normalRef = db.ref('/nack-test/unrelated');
      const normalCallback = vi.fn();
      const normalUnsubscribe = normalRef.on('value', normalCallback);
      await delay(200);

      // Trigger nack on denied path
      try {
        await deniedRef.child('test').set({ x: 1 });
      } catch {
        // Expected
      }

      // Writes to the normal path should still work
      await normalRef.set({ works: true });

      // Verify the write succeeded
      const snapshot = await normalRef.once();
      expect(snapshot.val()).toEqual({ works: true });

      deniedUnsubscribe();
      normalUnsubscribe();
      await delay(WRITE_DELAY);
    });
  });

  describe('Optimistic Updates', () => {
    it('optimistic update still fires before nack', async () => {
      const ref = db.ref('/__write_denied__');
      const callback = vi.fn();
      const unsubscribe = ref.on('value', callback);
      await delay(200);
      callback.mockClear();

      // Fire off write - optimistic update should fire immediately
      const writePromise = ref.child('optimistic').set({ x: 1 });

      // Callback should have been called synchronously with optimistic value
      // (before the nack comes back)
      expect(callback).toHaveBeenCalled();

      // But the write will fail
      await expect(writePromise).rejects.toMatchObject({
        code: 'permission_denied',
      });

      unsubscribe();
      await delay(WRITE_DELAY);
    });

    it('displayCache reverts to server truth after nack', async () => {
      const ref = db.ref('/__write_denied__');
      const callback = vi.fn();
      const unsubscribe = ref.on('value', callback);
      await delay(200);

      // Clear to capture only post-nack callbacks
      callback.mockClear();

      // Fire off write - this will be nacked
      const writePromise = ref.child('revert-test').set({ optimistic: true });

      // Callback fires with optimistic value
      expect(callback).toHaveBeenCalledTimes(1);

      // Wait for nack
      await expect(writePromise).rejects.toMatchObject({
        code: 'permission_denied',
      });

      // After nack, callback should fire again with server truth (optimistic value removed)
      // Give a moment for the nack handling to complete
      await delay(50);

      // Should have fired again to revert the optimistic update
      expect(callback.mock.calls.length).toBeGreaterThanOrEqual(2);

      unsubscribe();
      await delay(WRITE_DELAY);
    });
  });
});
