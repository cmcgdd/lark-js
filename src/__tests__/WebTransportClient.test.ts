/**
 * Unit tests for WebTransportClient.
 *
 * Since WebTransport is not available in Node.js, we mock the WebTransport API.
 */

import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';

// We need to mock WebTransport before importing WebTransportClient
const mockStreamWriter = {
  write: vi.fn().mockResolvedValue(undefined),
  releaseLock: vi.fn(),
};

const mockStreamReader = {
  read: vi.fn(),
};

const mockDatagramWriter = {
  write: vi.fn().mockResolvedValue(undefined),
  releaseLock: vi.fn(),
};

const mockDatagramReader = {
  read: vi.fn(),
};

const mockBidirectionalStream = {
  readable: {
    getReader: () => mockStreamReader,
  },
  writable: {
    getWriter: () => mockStreamWriter,
  },
};

interface MockDatagrams {
  readable: { getReader: () => typeof mockDatagramReader };
  // Legacy, removed from the spec in 2025: Chrome/Firefox only.
  writable?: { getWriter: () => typeof mockDatagramWriter };
  // Current spec: Safari 26.4+ only.
  createWritable?: () => { getWriter: () => typeof mockDatagramWriter };
}

/**
 * Which engine's datagram send API the mock exposes. No engine ships both, so
 * tests must be able to model each one separately.
 * - 'legacy'  - Chrome/Firefox: `datagrams.writable`
 * - 'current' - Safari 26.4+: `datagrams.createWritable()`
 * - 'none'    - neither, which must fail the connection
 */
let datagramApiShape: 'legacy' | 'current' | 'none' = 'legacy';

function buildMockDatagrams(): MockDatagrams {
  const datagrams: MockDatagrams = {
    readable: { getReader: () => mockDatagramReader },
  };
  if (datagramApiShape === 'legacy') {
    datagrams.writable = { getWriter: () => mockDatagramWriter };
  } else if (datagramApiShape === 'current') {
    datagrams.createWritable = () => ({ getWriter: () => mockDatagramWriter });
  }
  return datagrams;
}

let mockWebTransportInstance: {
  ready: Promise<void>;
  closed: Promise<{ closeCode?: number; reason?: string } | undefined>;
  close: Mock;
  createBidirectionalStream: Mock;
  datagrams: MockDatagrams;
};

let mockClosedResolve: (value: { closeCode?: number; reason?: string } | undefined) => void;
let mockClosedReject: (reason?: unknown) => void;

// Mock WebTransport globally before imports
class MockWebTransport {
  ready: Promise<void>;
  closed: Promise<{ closeCode?: number; reason?: string } | undefined>;
  close: Mock;
  createBidirectionalStream: Mock;
  datagrams: MockDatagrams;

  constructor() {
    this.ready = Promise.resolve();
    this.closed = new Promise((resolve, reject) => {
      mockClosedResolve = resolve;
      mockClosedReject = reject;
    });
    this.close = vi.fn();
    this.createBidirectionalStream = vi.fn().mockResolvedValue(mockBidirectionalStream);
    this.datagrams = buildMockDatagrams();
    mockWebTransportInstance = this;
  }
}

// Set up global WebTransport mock
(globalThis as unknown as { WebTransport: typeof MockWebTransport }).WebTransport = MockWebTransport;

// Now import the module under test
import { WebTransportClient, isWebTransportAvailable } from '../connection/WebTransportClient';

describe('isWebTransportAvailable', () => {
  it('returns true when WebTransport is defined', () => {
    expect(isWebTransportAvailable()).toBe(true);
  });

  it('returns false when WebTransport is undefined', () => {
    const original = (globalThis as unknown as { WebTransport?: unknown }).WebTransport;
    delete (globalThis as unknown as { WebTransport?: unknown }).WebTransport;

    expect(isWebTransportAvailable()).toBe(false);

    (globalThis as unknown as { WebTransport: unknown }).WebTransport = original;
  });
});

describe('WebTransportClient', () => {
  let client: WebTransportClient;
  let mockCallbacks: {
    onMessage: Mock;
    onOpen: Mock;
    onClose: Mock;
    onError: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default to the Chrome/Firefox shape; tests override as needed
    datagramApiShape = 'legacy';

    // Reset read mocks to return done: true by default (no messages)
    mockStreamReader.read.mockResolvedValue({ done: true });
    mockDatagramReader.read.mockResolvedValue({ done: true });

    mockCallbacks = {
      onMessage: vi.fn(),
      onOpen: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    };

    client = new WebTransportClient(mockCallbacks);
  });

  describe('initial state', () => {
    it('starts disconnected', () => {
      expect(client.state).toBe('disconnected');
      expect(client.connected).toBe(false);
    });
  });

  describe('datagram API compatibility', () => {
    // No engine ships both forms: Chrome/Firefox have `writable`, Safari 26.4+
    // has `createWritable()`. See w3c/webtransport#638.
    it('uses datagrams.writable on engines that expose it (Chrome/Firefox)', async () => {
      datagramApiShape = 'legacy';

      await client.connect('https://server.com:7778/wt');

      expect(client.connected).toBe(true);
      client.sendVolatile('{"o":"s"}');
      expect(mockDatagramWriter.write).toHaveBeenCalledTimes(1);
    });

    it('uses datagrams.createWritable() on engines that expose it (Safari 26.4+)', async () => {
      datagramApiShape = 'current';

      await client.connect('https://server.com:7778/wt');

      expect(client.connected).toBe(true);
      client.sendVolatile('{"o":"s"}');
      expect(mockDatagramWriter.write).toHaveBeenCalledTimes(1);
    });

    it('prefers createWritable() when an engine somehow exposes both', async () => {
      datagramApiShape = 'current';
      const createWritable = vi.fn(() => ({ getWriter: () => mockDatagramWriter }));
      const legacyGetWriter = vi.fn(() => mockDatagramWriter);

      const BothWebTransport = class extends MockWebTransport {
        constructor() {
          super();
          this.datagrams = {
            readable: { getReader: () => mockDatagramReader },
            writable: { getWriter: legacyGetWriter },
            createWritable,
          };
        }
      };
      const original = (globalThis as unknown as { WebTransport: unknown }).WebTransport;
      (globalThis as unknown as { WebTransport: unknown }).WebTransport = BothWebTransport;

      try {
        await new WebTransportClient(mockCallbacks).connect('https://server.com:7778/wt');
        expect(createWritable).toHaveBeenCalled();
        expect(legacyGetWriter).not.toHaveBeenCalled();
      } finally {
        (globalThis as unknown as { WebTransport: unknown }).WebTransport = original;
      }
    });

    it('fails the connection when neither datagram API is available', async () => {
      // Datagrams are the reason to use WebTransport at all, so this must fail
      // loudly and let the caller fall back to WebSocket.
      datagramApiShape = 'none';

      const failing = new WebTransportClient(mockCallbacks);

      await expect(failing.connect('https://server.com:7778/wt')).rejects.toThrow(
        /datagrams unavailable/i
      );
      expect(failing.state).toBe('disconnected');
      expect(failing.connected).toBe(false);
    });
  });

  describe('connect', () => {
    it('connects successfully', async () => {
      await client.connect('https://server.com:7778/wt');

      expect(client.state).toBe('connected');
      expect(client.connected).toBe(true);
      expect(mockCallbacks.onOpen).toHaveBeenCalledTimes(1);
    });

    it('creates bidirectional stream', async () => {
      await client.connect('https://server.com:7778/wt');

      expect(mockWebTransportInstance.createBidirectionalStream).toHaveBeenCalled();
    });

    it('throws if already connected', async () => {
      await client.connect('https://server.com:7778/wt');

      await expect(client.connect('https://server.com:7778/wt')).rejects.toThrow(
        'Already connected or connecting'
      );
    });

    it('handles connection failure', async () => {
      // Override the mock to fail on ready
      const FailingWebTransport = class {
        ready = Promise.reject(new Error('Connection refused'));
        closed = new Promise(() => {});
        close = vi.fn();
        createBidirectionalStream = vi.fn();
        datagrams = { readable: { getReader: () => ({}) }, writable: { getWriter: () => ({}) } };
      };
      (globalThis as unknown as { WebTransport: unknown }).WebTransport = FailingWebTransport;

      const failingClient = new WebTransportClient(mockCallbacks);

      await expect(failingClient.connect('https://server.com:7778/wt')).rejects.toThrow(
        'Connection refused'
      );

      expect(failingClient.state).toBe('disconnected');
      expect(failingClient.connected).toBe(false);

      // Restore mock
      (globalThis as unknown as { WebTransport: unknown }).WebTransport = MockWebTransport;
    });
  });

  describe('send (reliable)', () => {
    it('sends message with 4-byte length prefix', async () => {
      await client.connect('https://server.com:7778/wt');

      client.send('{"test":"message"}');

      // Should have called write twice: once for length, once for message
      expect(mockStreamWriter.write).toHaveBeenCalledTimes(2);

      // First call: 4-byte length prefix
      const lengthPrefix = mockStreamWriter.write.mock.calls[0][0] as Uint8Array;
      expect(lengthPrefix.length).toBe(4);
      // Big-endian encoding of 18 (length of '{"test":"message"}')
      expect(lengthPrefix[0]).toBe(0);
      expect(lengthPrefix[1]).toBe(0);
      expect(lengthPrefix[2]).toBe(0);
      expect(lengthPrefix[3]).toBe(18);

      // Second call: the actual message
      const message = mockStreamWriter.write.mock.calls[1][0] as Uint8Array;
      const decoder = new TextDecoder();
      expect(decoder.decode(message)).toBe('{"test":"message"}');
    });

    it('throws if not connected', () => {
      expect(() => client.send('test')).toThrow('WebTransport not connected');
    });
  });

  describe('sendVolatile (datagram)', () => {
    it('sends message as datagram without length prefix', async () => {
      await client.connect('https://server.com:7778/wt');

      client.sendVolatile('{"volatile":"data"}');

      expect(mockDatagramWriter.write).toHaveBeenCalledTimes(1);

      const message = mockDatagramWriter.write.mock.calls[0][0] as Uint8Array;
      const decoder = new TextDecoder();
      expect(decoder.decode(message)).toBe('{"volatile":"data"}');
    });

    it('throws if not connected', () => {
      expect(() => client.sendVolatile('test')).toThrow('WebTransport not connected');
    });
  });

  describe('message framing (reading)', () => {
    it('handles complete message in single read', async () => {
      // Prepare a framed message
      const message = '{"hello":"world"}';
      const encoder = new TextEncoder();
      const msgBytes = encoder.encode(message);
      const framedMessage = new Uint8Array(4 + msgBytes.length);
      new DataView(framedMessage.buffer).setUint32(0, msgBytes.length, false);
      framedMessage.set(msgBytes, 4);

      mockStreamReader.read
        .mockResolvedValueOnce({ value: framedMessage, done: false })
        .mockResolvedValue({ done: true });

      await client.connect('https://server.com:7778/wt');

      // Give the read loop time to process
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockCallbacks.onMessage).toHaveBeenCalledWith('{"hello":"world"}');
    });

    it('handles message split across multiple reads', async () => {
      const message = '{"split":"message"}';
      const encoder = new TextEncoder();
      const msgBytes = encoder.encode(message);
      const framedMessage = new Uint8Array(4 + msgBytes.length);
      new DataView(framedMessage.buffer).setUint32(0, msgBytes.length, false);
      framedMessage.set(msgBytes, 4);

      // Split the message into two parts
      const part1 = framedMessage.slice(0, 10);
      const part2 = framedMessage.slice(10);

      mockStreamReader.read
        .mockResolvedValueOnce({ value: part1, done: false })
        .mockResolvedValueOnce({ value: part2, done: false })
        .mockResolvedValue({ done: true });

      await client.connect('https://server.com:7778/wt');

      // Give the read loop time to process
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockCallbacks.onMessage).toHaveBeenCalledWith('{"split":"message"}');
    });

    it('handles multiple messages in single read', async () => {
      const msg1 = '{"first":1}';
      const msg2 = '{"second":2}';
      const encoder = new TextEncoder();

      const msg1Bytes = encoder.encode(msg1);
      const msg2Bytes = encoder.encode(msg2);

      const combined = new Uint8Array(4 + msg1Bytes.length + 4 + msg2Bytes.length);
      new DataView(combined.buffer).setUint32(0, msg1Bytes.length, false);
      combined.set(msg1Bytes, 4);
      new DataView(combined.buffer).setUint32(4 + msg1Bytes.length, msg2Bytes.length, false);
      combined.set(msg2Bytes, 4 + msg1Bytes.length + 4);

      mockStreamReader.read
        .mockResolvedValueOnce({ value: combined, done: false })
        .mockResolvedValue({ done: true });

      await client.connect('https://server.com:7778/wt');

      // Give the read loop time to process
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockCallbacks.onMessage).toHaveBeenCalledTimes(2);
      expect(mockCallbacks.onMessage).toHaveBeenNthCalledWith(1, '{"first":1}');
      expect(mockCallbacks.onMessage).toHaveBeenNthCalledWith(2, '{"second":2}');
    });
  });

  describe('datagram reading', () => {
    it('receives datagrams and calls onMessage', async () => {
      const encoder = new TextEncoder();
      const datagram = encoder.encode('{"volatile":"event"}');

      mockDatagramReader.read
        .mockResolvedValueOnce({ value: datagram, done: false })
        .mockResolvedValue({ done: true });

      await client.connect('https://server.com:7778/wt');

      // Give the datagram loop time to process
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockCallbacks.onMessage).toHaveBeenCalledWith('{"volatile":"event"}');
    });
  });

  describe('close', () => {
    it('closes the transport', async () => {
      await client.connect('https://server.com:7778/wt');

      client.close(0, 'Test close');

      expect(client.state).toBe('disconnected');
      expect(client.connected).toBe(false);
      expect(mockWebTransportInstance.close).toHaveBeenCalledWith({
        closeCode: 0,
        reason: 'Test close',
      });
    });

    it('releases writer locks', async () => {
      await client.connect('https://server.com:7778/wt');

      client.close();

      expect(mockStreamWriter.releaseLock).toHaveBeenCalled();
      expect(mockDatagramWriter.releaseLock).toHaveBeenCalled();
    });
  });

  describe('connection close handling', () => {
    it('calls onClose when transport closes', async () => {
      await client.connect('https://server.com:7778/wt');

      // Simulate transport close
      mockClosedResolve({ closeCode: 1000, reason: 'Normal closure' });

      // Give time for promise to resolve
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockCallbacks.onClose).toHaveBeenCalledWith(1000, 'Normal closure');
      expect(client.state).toBe('disconnected');
    });

    it('defaults closeCode and reason when absent from the close info', async () => {
      // `closeCode` has no default in the WebIDL, so it may be absent.
      // It must not reach onClose (and reconnect logic) as undefined.
      await client.connect('https://server.com:7778/wt');

      mockClosedResolve(undefined);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockCallbacks.onClose).toHaveBeenCalledWith(0, '');
    });

    it('preserves WebTransportError detail when closed rejects', async () => {
      // close() during "connecting" rejects `closed` per spec. Collapsing that
      // to a generic message is what made these failures undiagnosable.
      await client.connect('https://server.com:7778/wt');

      mockClosedReject(
        Object.assign(new Error('handshake failed'), { source: 'session', streamErrorCode: 42 })
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockCallbacks.onClose).toHaveBeenCalledWith(
        0,
        expect.stringContaining('handshake failed')
      );
      const reason = mockCallbacks.onClose.mock.calls[0][1] as string;
      expect(reason).toContain('source=session');
      expect(reason).toContain('streamErrorCode=42');
    });
  });
});
