/**
 * Shared utilities for integration tests.
 */

import { LarkDatabase } from '../LarkDatabase';

// Generate a unique database ID for this test run
const testRunId = `test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
export const DATABASE_ID = `javascript-integration/${testRunId}`;

// Shared database instance
let sharedDb: LarkDatabase | null = null;

/**
 * Get or create a shared database connection.
 */
export async function getSharedDb(): Promise<LarkDatabase> {
  // If we have a connected db, return it
  if (sharedDb && sharedDb.connected) {
    return sharedDb;
  }

  // If the db exists but is not connected (maybe disconnected or reconnecting),
  // disconnect it properly and create a new one
  if (sharedDb) {
    try {
      await sharedDb.disconnect();
    } catch {
      // Ignore errors during cleanup
    }
    sharedDb = null;
  }

  sharedDb = new LarkDatabase(DATABASE_ID, { anonymous: true });
  await sharedDb.connect();

  return sharedDb;
}

/**
 * Disconnect the shared database.
 */
export async function disconnectSharedDb(): Promise<void> {
  if (sharedDb) {
    try {
      await sharedDb.disconnect();
    } catch {
      // Ignore errors during cleanup
    }
    sharedDb = null;
  }
}

/**
 * Wait for a specified number of milliseconds.
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a unique path for a test to avoid conflicts.
 */
export function uniquePath(prefix: string): string {
  return `${prefix}/${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}
