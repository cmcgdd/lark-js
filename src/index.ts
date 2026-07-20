/**
 * @lark-sh/client - JavaScript client for Lark real-time database
 *
 * @example
 * ```typescript
 * import { LarkDatabase } from '@lark-sh/client';
 *
 * const db = new LarkDatabase();
 * await db.connect('my-project/my-database', { anonymous: true });
 *
 * // Write data
 * await db.ref('players/abc').set({ name: 'Riley', score: 0 });
 *
 * // Subscribe to changes
 * const unsubscribe = db.ref('players').on('child_changed', (snap) => {
 *   console.log(`Player ${snap.key} changed:`, snap.val());
 * });
 *
 * // Later: unsubscribe
 * unsubscribe();
 *
 * // Disconnect
 * await db.disconnect();
 * ```
 */

// Main classes
export { LarkDatabase, ServerValue } from './LarkDatabase';
export type {
  ConnectOptions,
  AuthInfo,
  TransactionOp,
  TransactionSetOp,
  TransactionUpdateOp,
  TransactionDeleteOp,
  TransactionConditionOp,
  TransactionObject,
} from './LarkDatabase';

export { DatabaseReference, ThenableReference } from './DatabaseReference';
export type { SnapshotCallback, QueryState, TransactionResult } from './DatabaseReference';

export { DataSnapshot } from './DataSnapshot';

export { OnDisconnect } from './OnDisconnect';

export { LarkError } from './LarkError';

// Protocol types (for advanced usage)
export type { EventType } from './protocol/constants';
export type { QueryParams } from './protocol/messages';

// Connection utilities (for advanced usage)
export { PendingWriteManager } from './connection/PendingWriteManager';
export type { WriteOperation, PendingWrite } from './connection/PendingWriteManager';

// Transport (for advanced usage)
export type { TransportType } from './connection/createTransport';

// Utility functions (for advanced usage)
export { generatePushId } from './utils/pushid';
export { isVolatilePath } from './utils/volatile';
