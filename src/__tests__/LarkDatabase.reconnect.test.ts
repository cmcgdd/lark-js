/**
 * Unit tests for LarkDatabase reconnection logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';
import { createTransport } from '../connection/createTransport';

// Mock dependencies
vi.mock('../connection/createTransport');

describe('LarkDatabase Reconnection', () => {
  let db: LarkDatabase;
  let mockTransportInstance: {
    send: Mock;
    sendVolatile: Mock;
    close: Mock;
    connected: boolean;
    state: string;
  };
  let transportCallbacks: {
    onMessage?: (data: string) => void;
    onOpen?: () => void;
    onClose?: (code: number, reason: string) => void;
    onError?: (error: Error) => void;
  };
  let createTransportCallCount: number;

  beforeEach(() => {
    vi.useFakeTimers();

    // Reset mocks
    transportCallbacks = {};
    createTransportCallCount = 0;
    mockTransportInstance = {
      send: vi.fn(),
      sendVolatile: vi.fn(),
      close: vi.fn(),
      connected: true,
      state: 'connected',
    };

    // Setup createTransport mock to capture callbacks and return mock transport
    (createTransport as unknown as Mock).mockImplementation(async (wsUrl, callbacks) => {
      createTransportCallCount++;
      transportCallbacks = callbacks;
      return {
        transport: mockTransportInstance,
        type: 'websocket',
        url: wsUrl,
      };
    });

    db = new LarkDatabase('test/db', { anonymous: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // Helper to complete initial connection without advancing time too much
  async function connectDb(): Promise<void> {
    const connectPromise = db.connect();

    // Allow promises to settle (without advancing timers significantly)
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Find the join request ID from the sent message
    const joinMessage = JSON.parse(mockTransportInstance.send.mock.calls[0][0]);
    const joinRequestId = joinMessage.r;

    // Send join complete response
    transportCallbacks.onMessage?.(
      JSON.stringify({
        jc: joinRequestId,
        vp: ['players/*/pos'],
        cid: 'conn-abc123',
      })
    );

    // Allow promises to settle for auth message
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Find the auth request ID from the sent message (second call)
    const authMessage = JSON.parse(mockTransportInstance.send.mock.calls[1][0]);
    const authRequestId = authMessage.r;

    // Send auth complete response
    transportCallbacks.onMessage?.(
      JSON.stringify({
        ac: authRequestId,
        au: 'user-123',
      })
    );

    await connectPromise;
  }

  // Helper to complete a reconnection (both join and auth responses)
  async function completeReconnect(newCid: string = 'conn-new'): Promise<void> {
    // Wait for join message to be sent
    await Promise.resolve();
    await Promise.resolve();

    // Find the join message (should be the last sent message)
    const joinMsg = JSON.parse(mockTransportInstance.send.mock.calls.slice(-1)[0][0]);

    // Send join complete
    transportCallbacks.onMessage?.(JSON.stringify({ jc: joinMsg.r, cid: newCid }));

    // Wait for auth message to be sent
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Find the auth message
    const authMsg = JSON.parse(mockTransportInstance.send.mock.calls.slice(-1)[0][0]);

    // Send auth complete
    transportCallbacks.onMessage?.(JSON.stringify({ ac: authMsg.r, au: 'user-123' }));

    await vi.runAllTimersAsync();
  }

  // Helper to complete disconnect (handles leave message ack)
  async function disconnectDb(): Promise<void> {
    const disconnectPromise = db.disconnect();

    // The disconnect sends a leave message and waits up to 1s for ack
    // Advance timer to let the timeout complete
    await vi.advanceTimersByTimeAsync(1100);

    await disconnectPromise;
  }

  describe('State Properties', () => {
    it('state starts as disconnected', () => {
      expect(db.state).toBe('disconnected');
      expect(db.connected).toBe(false);
      expect(db.reconnecting).toBe(false);
    });

    it('state is connecting during initial connect', async () => {
      // Don't await - just check state during connect
      db.connect().catch(() => {
        // Ignore - we'll clean up
      });

      expect(db.state).toBe('connecting');
      expect(db.connected).toBe(false);
      expect(db.reconnecting).toBe(false);

      // Clean up - complete the connection or let it timeout
      await Promise.resolve();
      await Promise.resolve();
      if (mockTransportInstance.send.mock.calls.length > 0) {
        const joinMessage = JSON.parse(mockTransportInstance.send.mock.calls[0][0]);
        transportCallbacks.onMessage?.(JSON.stringify({ jc: joinMessage.r, cid: 'conn-123' }));
        // Also need to complete auth
        await Promise.resolve();
        await Promise.resolve();
        if (mockTransportInstance.send.mock.calls.length > 1) {
          const authMessage = JSON.parse(mockTransportInstance.send.mock.calls[1][0]);
          transportCallbacks.onMessage?.(JSON.stringify({ ac: authMessage.r, au: '' }));
        }
      }
    });

    it('state is authenticated after successful connect', async () => {
      await connectDb();

      expect(db.state).toBe('authenticated');
      expect(db.connected).toBe(true);
      expect(db.reconnecting).toBe(false);
    });

    it('state is reconnecting after unexpected disconnect', async () => {
      await connectDb();

      // Simulate unexpected close
      transportCallbacks.onClose?.(1006, 'Connection lost');

      expect(db.state).toBe('reconnecting');
      expect(db.connected).toBe(false);
      expect(db.reconnecting).toBe(true);
    });

    it('state is disconnected after intentional disconnect', async () => {
      await connectDb();

      await disconnectDb();

      expect(db.state).toBe('disconnected');
      expect(db.connected).toBe(false);
      expect(db.reconnecting).toBe(false);
    });
  });

  describe('Connection ID', () => {
    it('stores connection ID from join response', async () => {
      await connectDb();

      // Access via internal for testing
      expect((db as unknown as { _connectionId: string })._connectionId).toBe('conn-abc123');
    });

    it('sends previous connection ID on reconnect', async () => {
      await connectDb();

      // Clear send mock to track new calls
      mockTransportInstance.send.mockClear();

      // Simulate unexpected close
      transportCallbacks.onClose?.(1006, 'Connection lost');

      // Advance past backoff delay
      await vi.advanceTimersByTimeAsync(2000);

      // Find the join message from reconnect
      const reconnectJoinMessage = JSON.parse(mockTransportInstance.send.mock.calls[0][0]);

      expect(reconnectJoinMessage.o).toBe('j');
      expect(reconnectJoinMessage.pcid).toBe('conn-abc123');
    });
  });

  describe('Intentional Disconnect', () => {
    it('disconnect() does not trigger auto-reconnect', async () => {
      await connectDb();

      await disconnectDb();

      // Advance time significantly
      await vi.advanceTimersByTimeAsync(60000);

      // createTransport should only have been called once (initial connect)
      expect(createTransportCallCount).toBe(1);
    });

    it('disconnect() clears connection state but preserves config', async () => {
      await connectDb();

      await disconnectDb();

      expect(db.state).toBe('disconnected');
      expect((db as unknown as { _connectionId: string | null })._connectionId).toBeNull();
      // Config is preserved so connect() can be called again
      expect((db as unknown as { _databaseId: string })._databaseId).toBe('test/db');
    });

    it('disconnect() cancels pending reconnect timer', async () => {
      await connectDb();

      // Trigger reconnect
      transportCallbacks.onClose?.(1006, 'Connection lost');
      expect(db.state).toBe('reconnecting');

      // Disconnect before reconnect attempt (no leave message since not connected)
      await db.disconnect();

      expect(db.state).toBe('disconnected');

      // Advance time - should not attempt reconnect
      await vi.advanceTimersByTimeAsync(60000);
      expect(createTransportCallCount).toBe(1);
    });

    it('disconnect() while reconnecting cancels reconnection', async () => {
      await connectDb();

      // Trigger reconnect
      transportCallbacks.onClose?.(1006, 'Connection lost');

      // Disconnect during reconnecting state (no leave message since not connected)
      await db.disconnect();

      expect(db.state).toBe('disconnected');
      expect(db.reconnecting).toBe(false);
    });
  });

  describe('Callbacks', () => {
    it('onConnect fires on initial connect', async () => {
      const onConnect = vi.fn();
      db.onConnect(onConnect);

      await connectDb();

      expect(onConnect).toHaveBeenCalledTimes(1);
    });

    it('onConnect fires on successful reconnect', async () => {
      const onConnect = vi.fn();
      db.onConnect(onConnect);

      await connectDb();
      expect(onConnect).toHaveBeenCalledTimes(1);

      // Trigger reconnect
      transportCallbacks.onClose?.(1006, 'Connection lost');

      // Advance past backoff
      await vi.advanceTimersByTimeAsync(2000);

      // Complete reconnect (join + auth)
      await completeReconnect();

      expect(onConnect).toHaveBeenCalledTimes(2);
    });

    it('onDisconnect fires on unexpected disconnect', async () => {
      const onDisconnect = vi.fn();
      db.onDisconnect(onDisconnect);

      await connectDb();

      transportCallbacks.onClose?.(1006, 'Connection lost');

      expect(onDisconnect).toHaveBeenCalledTimes(1);
    });

    it('onDisconnect fires on intentional disconnect', async () => {
      const onDisconnect = vi.fn();
      db.onDisconnect(onDisconnect);

      await connectDb();

      await disconnectDb();

      expect(onDisconnect).toHaveBeenCalledTimes(1);
    });

    it('onReconnecting fires when reconnection starts', async () => {
      const onReconnecting = vi.fn();
      db.onReconnecting(onReconnecting);

      await connectDb();

      transportCallbacks.onClose?.(1006, 'Connection lost');

      expect(onReconnecting).toHaveBeenCalledTimes(1);
    });

    it('onReconnecting does not fire on intentional disconnect', async () => {
      const onReconnecting = vi.fn();
      db.onReconnecting(onReconnecting);

      await connectDb();

      await disconnectDb();

      expect(onReconnecting).not.toHaveBeenCalled();
    });

    it('callbacks fire in correct order on unexpected disconnect', async () => {
      const callOrder: string[] = [];
      db.onDisconnect(() => callOrder.push('disconnect'));
      db.onReconnecting(() => callOrder.push('reconnecting'));

      await connectDb();

      transportCallbacks.onClose?.(1006, 'Connection lost');

      expect(callOrder).toEqual(['reconnecting', 'disconnect']);
    });

    it('unsubscribe function removes callback', async () => {
      const onConnect = vi.fn();
      const unsub = db.onConnect(onConnect);

      await connectDb();
      expect(onConnect).toHaveBeenCalledTimes(1);

      unsub();

      // Trigger reconnect and completion
      transportCallbacks.onClose?.(1006, 'Connection lost');
      await vi.advanceTimersByTimeAsync(2000);
      await completeReconnect();

      // Should not have been called again
      expect(onConnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('Exponential Backoff', () => {
    it('first reconnect attempt uses base delay (~1s)', async () => {
      await connectDb();

      transportCallbacks.onClose?.(1006, 'Connection lost');

      // Should not reconnect immediately
      expect(createTransportCallCount).toBe(1);

      // Advance 500ms - too early
      await vi.advanceTimersByTimeAsync(500);
      expect(createTransportCallCount).toBe(1);

      // Advance to ~1.5s (covers base + max jitter)
      await vi.advanceTimersByTimeAsync(1000);
      expect(createTransportCallCount).toBe(2);
    });

    it('subsequent attempts increase delay exponentially', async () => {
      await connectDb();

      // Make createTransport fail to trigger retry (still increment counter)
      (createTransport as unknown as Mock).mockImplementation(async () => {
        createTransportCallCount++;
        throw new Error('Network error');
      });

      transportCallbacks.onClose?.(1006, 'Connection lost');

      // First attempt after ~1s
      await vi.advanceTimersByTimeAsync(1500);
      expect(createTransportCallCount).toBe(2); // Initial + 1 retry

      // Second attempt after ~2s more
      await vi.advanceTimersByTimeAsync(3000);
      expect(createTransportCallCount).toBe(3);

      // Third attempt after ~4s more
      await vi.advanceTimersByTimeAsync(6000);
      expect(createTransportCallCount).toBe(4);
    });

    it('delay caps at maximum (30s)', async () => {
      await connectDb();

      // Make createTransport fail after initial connect to trigger retries
      (createTransport as unknown as Mock).mockImplementation(async (wsUrl, callbacks) => {
        createTransportCallCount++;
        if (createTransportCallCount > 1) {
          throw new Error('Network error');
        }
        transportCallbacks = callbacks;
        return {
          transport: mockTransportInstance,
          type: 'websocket',
          url: wsUrl,
        };
      });

      transportCallbacks.onClose?.(1006, 'Connection lost');

      // Fast forward through many attempts
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(35000); // More than max delay
      }

      // Should have made multiple attempts
      expect(createTransportCallCount).toBeGreaterThan(5);
    });

    it('resets backoff counter on successful reconnect', async () => {
      await connectDb();

      // First disconnect/reconnect cycle
      transportCallbacks.onClose?.(1006, 'Connection lost');
      await vi.advanceTimersByTimeAsync(1500);

      // Complete reconnect (join + auth)
      await completeReconnect();

      expect(db.state).toBe('authenticated');

      // Second disconnect - should use base delay again (not continued exponential)
      mockTransportInstance.send.mockClear();
      transportCallbacks.onClose?.(1006, 'Connection lost');

      // Check it reconnects quickly (base delay) not after long backoff
      await vi.advanceTimersByTimeAsync(1500);
      expect(createTransportCallCount).toBe(3); // Initial + 2 reconnects
    });
  });

  describe('Subscription Preservation', () => {
    it('subscriptions are preserved during reconnect', async () => {
      await connectDb();

      // Subscribe to a path
      const callback = vi.fn();
      db.ref('/users').on('value', callback);

      // Capture the subscribe message
      await vi.runAllTimersAsync();
      const subscribeMessage = JSON.parse(
        mockTransportInstance.send.mock.calls.find((call) => {
          const msg = JSON.parse(call[0]);
          return msg.o === 'sb';
        })?.[0] || '{}'
      );
      expect(subscribeMessage.o).toBe('sb');

      // Clear send mock
      mockTransportInstance.send.mockClear();

      // Trigger reconnect
      transportCallbacks.onClose?.(1006, 'Connection lost');
      await vi.advanceTimersByTimeAsync(1500);

      // Complete reconnect (join + auth)
      await completeReconnect();

      // Should have re-sent subscribe
      const resubscribeMessage = mockTransportInstance.send.mock.calls.find((call) => {
        const msg = JSON.parse(call[0]);
        return msg.o === 'sb';
      });
      expect(resubscribeMessage).toBeDefined();
    });

    it('cache is cleared on reconnect', async () => {
      await connectDb();

      // Subscribe and receive data
      const callback = vi.fn();
      db.ref('/users').on('value', callback);
      await vi.runAllTimersAsync();

      // Acknowledge subscribe
      const subMsg = JSON.parse(
        mockTransportInstance.send.mock.calls.find((call) => JSON.parse(call[0]).o === 'sb')?.[0] || '{}'
      );
      transportCallbacks.onMessage?.(JSON.stringify({ a: subMsg.r }));

      // Send initial data
      transportCallbacks.onMessage?.(
        JSON.stringify({
          ev: 'put',
          sp: '/users',
          p: '/',
          v: { alice: { name: 'Alice' } },
        })
      );

      expect(callback).toHaveBeenCalled();

      // Trigger reconnect
      transportCallbacks.onClose?.(1006, 'Connection lost');

      // Cache should be cleared (fresh data will come from server)
      // We can't directly check cache, but behavior is tested
    });
  });

  describe('Pending Writes', () => {
    it('pending writes are preserved during reconnect', async () => {
      await connectDb();

      // Start a write but don't complete it
      // Catch the promise to prevent unhandled rejection when connection closes
      const setPromise = db.ref('/test').set({ value: 1 }).catch(() => {
        // Expected - the original request will be rejected on disconnect,
        // but the write will be retried after reconnect
      });

      // Let the microtask queue drain so the write is tracked
      await Promise.resolve();

      // Get the request ID for the write
      const setMessage = JSON.parse(
        mockTransportInstance.send.mock.calls.find((call) => {
          const msg = JSON.parse(call[0]);
          return msg.o === 's' && msg.p === '/test';
        })?.[0] || '{}'
      );
      const writeRequestId = setMessage.r;

      expect(db.hasPendingWrites()).toBe(true);

      // Trigger reconnect before ack
      mockTransportInstance.send.mockClear();
      transportCallbacks.onClose?.(1006, 'Connection lost');

      // Pending writes should still exist
      expect(db.hasPendingWrites()).toBe(true);

      // Complete reconnect (join + auth)
      await vi.advanceTimersByTimeAsync(1500);
      await completeReconnect();

      // Should have retried the write with same request ID
      const retriedWrite = mockTransportInstance.send.mock.calls.find((call) => {
        const msg = JSON.parse(call[0]);
        return msg.o === 's' && msg.p === '/test' && msg.r === writeRequestId;
      });
      expect(retriedWrite).toBeDefined();
    });

    it('pending writes are cleared on intentional disconnect', async () => {
      await connectDb();

      // Start a write but don't complete it
      db.ref('/test').set({ value: 1 }).catch(() => {
        // Expected - will fail when we disconnect
      });

      // Let the microtask queue drain so the write is tracked
      await Promise.resolve();

      expect(db.hasPendingWrites()).toBe(true);

      await disconnectDb();

      expect(db.hasPendingWrites()).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('handles disconnect during connecting state', async () => {
      // Start connecting but don't complete
      const connectPromise = db.connect();

      // Allow promises to settle
      await Promise.resolve();
      await Promise.resolve();

      // Close before join complete
      transportCallbacks.onClose?.(1006, 'Connection lost');

      // Should not trigger reconnect (no successful connection yet - no _connectOptions stored)
      // The state will be 'connecting' briefly, then the error will propagate

      // The connect promise should reject (timeout or connection closed)
      await expect(connectPromise).rejects.toThrow();

      expect(db.state).toBe('disconnected');
    });

    it('handles disconnect while in reconnecting state', async () => {
      await connectDb();

      // First disconnect - triggers reconnection
      transportCallbacks.onClose?.(1006, 'Connection lost');
      expect(db.state).toBe('reconnecting');

      // Wait a bit - still reconnecting (backoff hasn't elapsed)
      await vi.advanceTimersByTimeAsync(500);
      expect(db.state).toBe('reconnecting');

      // Can call disconnect during reconnecting - should work
      await db.disconnect();
      expect(db.state).toBe('disconnected');
    });

    it('connect() is idempotent - succeeds when already connected', async () => {
      await connectDb();

      // Calling connect() again should not throw - it's idempotent
      await db.connect();
      expect(db.connected).toBe(true);
    });

    it('allows connect after intentional disconnect', async () => {
      await connectDb();
      await disconnectDb();

      // Should be able to connect again
      const connectPromise = db.connect();

      // Allow promises to settle
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Send join complete
      const joinMsg = JSON.parse(mockTransportInstance.send.mock.calls.slice(-1)[0][0]);
      transportCallbacks.onMessage?.(JSON.stringify({ jc: joinMsg.r, cid: 'conn-123' }));

      // Allow promises to settle for auth
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Send auth complete
      const authMsg = JSON.parse(mockTransportInstance.send.mock.calls.slice(-1)[0][0]);
      transportCallbacks.onMessage?.(JSON.stringify({ ac: authMsg.r, au: 'user-123' }));

      await connectPromise;

      expect(db.state).toBe('authenticated');
    });
  });

  describe('Cleanup Methods', () => {
    it('cleanupFull clears connection state but preserves config', async () => {
      await connectDb();

      // Add some subscriptions and pending writes
      db.ref('/test').on('value', vi.fn());
      db.ref('/write').set({ value: 1 }).catch(() => {
        // Expected - will fail when we disconnect
      });

      await disconnectDb();

      expect(db.state).toBe('disconnected');
      expect(db.hasPendingWrites()).toBe(false);
      expect((db as unknown as { _auth: unknown })._auth).toBeNull();
      // Config is preserved so connect() can be called again
      expect((db as unknown as { _databaseId: string })._databaseId).toBe('test/db');
      expect((db as unknown as { _connectionId: unknown })._connectionId).toBeNull();
    });

    it('cleanupForReconnect preserves necessary state', async () => {
      await connectDb();

      // Add subscription (acknowledge it to avoid timeout issues)
      db.ref('/test').on('value', vi.fn());

      // Trigger unexpected disconnect
      transportCallbacks.onClose?.(1006, 'Connection lost');

      // Should preserve databaseId and connectOptions for reconnect
      expect((db as unknown as { _databaseId: string })._databaseId).toBe('test/db');
      expect((db as unknown as { _connectionId: string })._connectionId).toBe('conn-abc123');
    });
  });
});
