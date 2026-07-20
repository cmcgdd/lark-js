import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';

// Mock the dependencies
vi.mock('../connection/createTransport');

describe('Volatile Writes', () => {
  let db: LarkDatabase;
  let mockSend: ReturnType<typeof vi.fn>;
  let mockSendVolatile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = new LarkDatabase('test/db', { anonymous: true });
    mockSend = vi.fn();
    mockSendVolatile = vi.fn();

    // Access private properties for testing
    // Mock the transport with connected: true
    (db as unknown as { transport: { send: typeof mockSend; sendVolatile: typeof mockSendVolatile; connected: boolean } }).transport = {
      send: mockSend,
      sendVolatile: mockSendVolatile,
      connected: true,
    };
    (db as unknown as { _state: string })._state = 'authenticated';
    (db as unknown as { _volatilePaths: string[] })._volatilePaths = [
      'players/*/position',
      'players/*/rotation',
      'game/state',
    ];
  });

  describe('isVolatilePath', () => {
    it('returns true for paths matching volatile patterns', () => {
      expect(db.isVolatilePath('/players/abc/position')).toBe(true);
      expect(db.isVolatilePath('/players/xyz/rotation')).toBe(true);
      expect(db.isVolatilePath('/game/state')).toBe(true);
    });

    it('returns false for paths not matching volatile patterns', () => {
      expect(db.isVolatilePath('/players/abc/name')).toBe(false);
      expect(db.isVolatilePath('/users/alice')).toBe(false);
      expect(db.isVolatilePath('/game/config')).toBe(false);
    });

    it('returns false when no volatile paths configured', () => {
      (db as unknown as { _volatilePaths: string[] })._volatilePaths = [];
      expect(db.isVolatilePath('/players/abc/position')).toBe(false);
    });
  });

  describe('_sendVolatileSet', () => {
    it('sends message without request ID', () => {
      db._sendVolatileSet('/players/abc/position', { x: 10, y: 20 });

      expect(mockSendVolatile).toHaveBeenCalledTimes(1);
      const message = JSON.parse(mockSendVolatile.mock.calls[0][0]);
      expect(message).toEqual({
        o: 's',
        p: '/players/abc/position',
        v: { x: 10, y: 20 },
      });
      // No 'r' field (request ID)
      expect(message.r).toBeUndefined();
      // No 'pw' field (pending writes)
      expect(message.pw).toBeUndefined();
    });

    it('does not track pending writes', () => {
      const pendingWritesSpy = vi.spyOn(db['pendingWrites'], 'trackWrite');

      db._sendVolatileSet('/players/abc/position', { x: 10 });

      expect(pendingWritesSpy).not.toHaveBeenCalled();
    });

    it('is synchronous (fire-and-forget)', () => {
      const result = db._sendVolatileSet('/players/abc/position', { x: 10 });

      // Should return void (undefined), not a Promise
      expect(result).toBeUndefined();
    });
  });

  describe('_sendVolatileUpdate', () => {
    it('sends message without request ID', () => {
      db._sendVolatileUpdate('/players/abc/position', { x: 10 });

      expect(mockSendVolatile).toHaveBeenCalledTimes(1);
      const message = JSON.parse(mockSendVolatile.mock.calls[0][0]);
      expect(message).toEqual({
        o: 'u',
        p: '/players/abc/position',
        v: { x: 10 },
      });
      expect(message.r).toBeUndefined();
      expect(message.pw).toBeUndefined();
    });
  });

  describe('_sendVolatileDelete', () => {
    it('sends message without request ID', () => {
      db._sendVolatileDelete('/players/abc/position');

      expect(mockSendVolatile).toHaveBeenCalledTimes(1);
      const message = JSON.parse(mockSendVolatile.mock.calls[0][0]);
      expect(message).toEqual({
        o: 'd',
        p: '/players/abc/position',
      });
      expect(message.r).toBeUndefined();
      expect(message.pw).toBeUndefined();
    });
  });

  describe('DatabaseReference integration', () => {
    it('set() uses volatile path for matching patterns', async () => {
      const ref = db.ref('/players/abc/position');

      await ref.set({ x: 10, y: 20 });

      // Volatile writes use sendVolatile
      expect(mockSendVolatile).toHaveBeenCalledTimes(1);
      const message = JSON.parse(mockSendVolatile.mock.calls[0][0]);
      // Should be volatile (no request ID)
      expect(message.r).toBeUndefined();
    });

    it('set() uses regular path for non-matching patterns', async () => {
      // Mock messageQueue for regular writes
      const mockRegisterRequest = vi.fn().mockResolvedValue(undefined);
      (db as unknown as { messageQueue: { registerRequest: typeof mockRegisterRequest; nextRequestId: () => string } }).messageQueue = {
        registerRequest: mockRegisterRequest,
        nextRequestId: () => 'r1',
      };

      const ref = db.ref('/players/abc/name');

      await ref.set('Alice');

      // Regular writes use send (not sendVolatile)
      expect(mockSend).toHaveBeenCalledTimes(1);
      const message = JSON.parse(mockSend.mock.calls[0][0]);
      // Should be regular (has request ID)
      expect(message.r).toBe('r1');
    });

    it('update() uses volatile path for matching patterns', async () => {
      const ref = db.ref('/players/abc/position');

      await ref.update({ x: 10 });

      expect(mockSendVolatile).toHaveBeenCalledTimes(1);
      const message = JSON.parse(mockSendVolatile.mock.calls[0][0]);
      expect(message.r).toBeUndefined();
    });

    it('remove() uses volatile path for matching patterns', async () => {
      const ref = db.ref('/players/abc/position');

      await ref.remove();

      expect(mockSendVolatile).toHaveBeenCalledTimes(1);
      const message = JSON.parse(mockSendVolatile.mock.calls[0][0]);
      expect(message.r).toBeUndefined();
    });
  });

  describe('Volatile vs Regular comparison', () => {
    it('volatile writes do not track pending writes', () => {
      // Volatile writes should not add to pending writes
      db['subscriptionManager'].subscribe('/players', 'value', vi.fn());
      const view = db['subscriptionManager'].getView('/players');
      view?.setServerCache({});

      // Volatile write
      db._sendVolatileSet('/players/abc/position', { x: 10 });

      // No pending writes should be tracked for volatile writes
      expect(view?.hasPendingWrites()).toBe(false);
    });
  });
});
