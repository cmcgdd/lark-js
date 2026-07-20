/**
 * OnDisconnect - registers operations to perform on the server when this client disconnects.
 */

import type { LarkDatabase } from './LarkDatabase';
import { OnDisconnectAction } from './protocol/constants';

export class OnDisconnect {
  private readonly _db: LarkDatabase;
  private readonly _path: string;

  constructor(db: LarkDatabase, path: string) {
    this._db = db;
    this._path = path;
  }

  /**
   * Set a value when disconnected.
   */
  async set(value: unknown): Promise<void> {
    await this._db._sendOnDisconnect(this._path, OnDisconnectAction.SET, value);
  }

  /**
   * Update values when disconnected.
   */
  async update(values: Record<string, unknown>): Promise<void> {
    await this._db._sendOnDisconnect(this._path, OnDisconnectAction.UPDATE, values);
  }

  /**
   * Remove data when disconnected.
   */
  async remove(): Promise<void> {
    await this._db._sendOnDisconnect(this._path, OnDisconnectAction.DELETE);
  }

  /**
   * Cancel any pending onDisconnect handlers at this location.
   */
  async cancel(): Promise<void> {
    await this._db._sendOnDisconnect(this._path, OnDisconnectAction.CANCEL);
  }

  /**
   * Set a value with priority when disconnected.
   * Priority is injected as `.priority` into the value object.
   */
  async setWithPriority(value: unknown, priority: number | string): Promise<void> {
    // Priority can only be set on objects
    if (value === null || value === undefined) {
      await this._db._sendOnDisconnect(this._path, OnDisconnectAction.SET, value);
      return;
    }

    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Priority can only be set on object values');
    }

    // Inject .priority into the value
    const valueWithPriority = { ...(value as Record<string, unknown>), '.priority': priority };
    await this._db._sendOnDisconnect(this._path, OnDisconnectAction.SET, valueWithPriority);
  }
}
