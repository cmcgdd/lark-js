import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageQueue } from '../connection/MessageQueue';
import { LarkError } from '../LarkError';

describe('MessageQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('nextRequestId', () => {
    it('returns incrementing string IDs', () => {
      const queue = new MessageQueue();
      expect(queue.nextRequestId()).toBe('1');
      expect(queue.nextRequestId()).toBe('2');
      expect(queue.nextRequestId()).toBe('3');
    });
  });

  describe('registerRequest / handleMessage', () => {
    it('resolves on ack', async () => {
      const queue = new MessageQueue();
      const promise = queue.registerRequest('1');

      queue.handleMessage({ a: '1' });

      await expect(promise).resolves.toBeUndefined();
    });

    it('rejects on nack with LarkError', async () => {
      const queue = new MessageQueue();
      const promise = queue.registerRequest('1');

      queue.handleMessage({
        n: '1',
        e: 'permission_denied',
        m: 'Write denied',
      });

      await expect(promise).rejects.toThrow(LarkError);
      await expect(promise).rejects.toMatchObject({
        code: 'permission_denied',
        message: 'Write denied',
      });
    });

    it('resolves join complete with volatile paths and connection ID', async () => {
      const queue = new MessageQueue();
      const promise = queue.registerRequest('1');

      queue.handleMessage({
        jc: '1',
        vp: ['players/*/position', 'players/*/rotation'],
        cid: '-OhgLedGN0vr714Sh6PJ',
      });

      await expect(promise).resolves.toEqual({
        volatilePaths: ['players/*/position', 'players/*/rotation'],
        connectionId: '-OhgLedGN0vr714Sh6PJ',
        serverTime: null,
      });
    });

    it('resolves join complete with empty array when no volatile paths', async () => {
      const queue = new MessageQueue();
      const promise = queue.registerRequest('1');

      queue.handleMessage({
        jc: '1',
        vp: null,
      });

      await expect(promise).resolves.toEqual({
        volatilePaths: [],
        connectionId: null,
        serverTime: null,
      });
    });

    it('resolves once response with value', async () => {
      const queue = new MessageQueue();
      const promise = queue.registerRequest('1');

      queue.handleMessage({
        oc: '1',
        ov: { name: 'Riley', score: 10 },
      });

      await expect(promise).resolves.toEqual({ name: 'Riley', score: 10 });
    });

    it('returns true when message was handled', () => {
      const queue = new MessageQueue();
      queue.registerRequest('1');

      expect(queue.handleMessage({ a: '1' })).toBe(true);
    });

    it('returns false for unhandled messages', () => {
      const queue = new MessageQueue();

      expect(queue.handleMessage({ a: 'unknown' })).toBe(false);
      expect(queue.handleMessage({ ev: 'put', sp: '/foo', p: '/', v: 'bar' })).toBe(false);
    });
  });

  describe('timeout', () => {
    it('rejects after timeout', async () => {
      const queue = new MessageQueue(1000);
      const promise = queue.registerRequest('1');

      vi.advanceTimersByTime(1001);

      await expect(promise).rejects.toThrow('timed out');
    });

    it('uses custom timeout', async () => {
      const queue = new MessageQueue(30000);
      const promise = queue.registerRequest('1', 500);

      vi.advanceTimersByTime(501);

      await expect(promise).rejects.toThrow('timed out');
    });

    it('clears timeout on ack', async () => {
      const queue = new MessageQueue(1000);
      const promise = queue.registerRequest('1');

      // Respond before timeout
      queue.handleMessage({ a: '1' });
      await expect(promise).resolves.toBeUndefined();

      // Advance time past what would have been the timeout
      vi.advanceTimersByTime(2000);

      // If timeout wasn't cleared, we'd have issues
      expect(queue.pendingCount).toBe(0);
    });
  });

  describe('rejectAll', () => {
    it('rejects all pending requests', async () => {
      const queue = new MessageQueue();
      const p1 = queue.registerRequest('1');
      const p2 = queue.registerRequest('2');
      const p3 = queue.registerRequest('3');

      queue.rejectAll(new Error('Connection closed'));

      await expect(p1).rejects.toThrow('Connection closed');
      await expect(p2).rejects.toThrow('Connection closed');
      await expect(p3).rejects.toThrow('Connection closed');
      expect(queue.pendingCount).toBe(0);
    });
  });

  describe('rejectLocally', () => {
    it('rejects a specific pending request', async () => {
      const queue = new MessageQueue();
      const p1 = queue.registerRequest('1');
      const p2 = queue.registerRequest('2');

      const result = queue.rejectLocally('1', new LarkError('write_tainted', 'Tainted write'));

      expect(result).toBe(true);
      await expect(p1).rejects.toThrow('Tainted write');
      await expect(p1).rejects.toMatchObject({ code: 'write_tainted' });

      // p2 should still be pending
      expect(queue.pendingCount).toBe(1);
    });

    it('returns false for non-existent request', () => {
      const queue = new MessageQueue();

      const result = queue.rejectLocally('nonexistent', new Error('test'));

      expect(result).toBe(false);
    });

    it('clears timeout when rejecting locally', async () => {
      const queue = new MessageQueue(1000);
      const promise = queue.registerRequest('1');

      queue.rejectLocally('1', new Error('Rejected locally'));

      // Advance time past timeout
      vi.advanceTimersByTime(2000);

      // Should have rejected with local error, not timeout
      await expect(promise).rejects.toThrow('Rejected locally');
    });

    it('removes request from pending', async () => {
      const queue = new MessageQueue();
      const promise = queue.registerRequest('1');
      expect(queue.pendingCount).toBe(1);

      queue.rejectLocally('1', new Error('test'));

      expect(queue.pendingCount).toBe(0);
      // Catch the rejection to prevent unhandled rejection
      await expect(promise).rejects.toThrow('test');
    });
  });

  describe('pendingCount', () => {
    it('tracks pending requests', () => {
      const queue = new MessageQueue();
      expect(queue.pendingCount).toBe(0);

      queue.registerRequest('1');
      expect(queue.pendingCount).toBe(1);

      queue.registerRequest('2');
      expect(queue.pendingCount).toBe(2);

      queue.handleMessage({ a: '1' });
      expect(queue.pendingCount).toBe(1);
    });
  });
});
