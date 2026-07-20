import { describe, it, expect } from 'vitest';
import {
  isAckMessage,
  isJoinCompleteMessage,
  isNackMessage,
  isEventMessage,
  isPutEventMessage,
  isPatchEventMessage,
  isOnceResponseMessage,
} from '../protocol/messages';

describe('message type guards', () => {
  describe('isAckMessage', () => {
    it('returns true for ack messages', () => {
      expect(isAckMessage({ a: '1' })).toBe(true);
    });

    it('returns false for other message types', () => {
      expect(isAckMessage({ n: '1', e: 'error' })).toBe(false);
      expect(isAckMessage({ ev: 'put', sp: '/foo', p: '/', v: 'bar' })).toBe(false);
      expect(isAckMessage({ jc: '1', vp: [] })).toBe(false);
    });
  });

  describe('isJoinCompleteMessage', () => {
    it('returns true for join complete messages', () => {
      expect(isJoinCompleteMessage({ jc: '1' })).toBe(true);
      expect(isJoinCompleteMessage({ jc: '1', vp: ['players/*/position'] })).toBe(true);
      expect(isJoinCompleteMessage({ jc: '1', vp: null })).toBe(true);
    });

    it('returns false for regular ack', () => {
      expect(isJoinCompleteMessage({ a: '1' })).toBe(false);
    });
  });

  describe('isNackMessage', () => {
    it('returns true for nack messages', () => {
      expect(isNackMessage({ n: '1', e: 'permission_denied' })).toBe(true);
      expect(isNackMessage({ n: '1', e: 'error', m: 'Error message' })).toBe(true);
    });

    it('returns false for other message types', () => {
      expect(isNackMessage({ a: '1' })).toBe(false);
    });
  });

  describe('isEventMessage', () => {
    it('returns true for put event messages', () => {
      expect(isEventMessage({ ev: 'put', sp: '/foo', p: '/', v: { bar: 1 } })).toBe(true);
      expect(isEventMessage({ ev: 'put', sp: '/foo', p: '/child', v: 'value' })).toBe(true);
    });

    it('returns true for patch event messages', () => {
      expect(isEventMessage({ ev: 'patch', sp: '/foo', p: '/', v: { 'bar/baz': 1 } })).toBe(true);
    });

    it('returns false for other message types', () => {
      expect(isEventMessage({ a: '1' })).toBe(false);
      expect(isEventMessage({ oc: '1', ov: {} })).toBe(false);
    });
  });

  describe('isPutEventMessage', () => {
    it('returns true for put event messages', () => {
      expect(isPutEventMessage({ ev: 'put', sp: '/foo', p: '/', v: { bar: 1 } })).toBe(true);
      expect(isPutEventMessage({ ev: 'put', sp: '/foo', p: '/child', v: null })).toBe(true);
    });

    it('returns false for patch messages', () => {
      expect(isPutEventMessage({ ev: 'patch', sp: '/foo', p: '/', v: {} })).toBe(false);
    });

    it('returns false for other message types', () => {
      expect(isPutEventMessage({ a: '1' })).toBe(false);
    });
  });

  describe('isPatchEventMessage', () => {
    it('returns true for patch event messages', () => {
      expect(isPatchEventMessage({ ev: 'patch', sp: '/foo', p: '/', v: { 'a/b': 1 } })).toBe(true);
    });

    it('returns false for put messages', () => {
      expect(isPatchEventMessage({ ev: 'put', sp: '/foo', p: '/', v: {} })).toBe(false);
    });

    it('returns false for other message types', () => {
      expect(isPatchEventMessage({ a: '1' })).toBe(false);
    });
  });

  describe('isOnceResponseMessage', () => {
    it('returns true for once response messages', () => {
      expect(isOnceResponseMessage({ oc: '1', ov: { foo: 'bar' } })).toBe(true);
      expect(isOnceResponseMessage({ oc: '1', ov: null })).toBe(true);
    });

    it('returns false for other message types', () => {
      expect(isOnceResponseMessage({ a: '1' })).toBe(false);
    });
  });

});
