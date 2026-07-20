/**
 * WebTransportClient - WebTransport implementation of the Transport interface.
 *
 * Uses QUIC-based WebTransport for:
 * - Reliable bidirectional stream (with 4-byte length prefix framing)
 * - Unreliable datagrams for volatile writes
 *
 * Browser-only (no Node.js support). Falls back to WebSocket if unavailable.
 */

import { Transport, TransportState, TransportOptions } from './Transport';

// TypeScript declarations for WebTransport API.
// Hand-rolled rather than using lib.dom.d.ts, whose WebTransportDatagramDuplexStream
// still declares `writable` as required and has no `createWritable` at all.
declare class WebTransport {
  constructor(url: string);
  ready: Promise<void>;
  // `closeCode` has no default in the IDL, so it may be absent on the resolved value.
  closed: Promise<{ closeCode?: number; reason?: string } | undefined>;
  close(options?: { closeCode?: number; reason?: string }): void;
  createBidirectionalStream(): Promise<WebTransportBidirectionalStream>;
  datagrams: WebTransportDatagrams;
}

/**
 * The datagram send API is split across engines, and neither form is universal:
 * - `writable` was removed from the spec in 2025 (w3c/webtransport#638). Chrome
 *   and Firefox still ship it; Safari 26.4+ never had it.
 * - `createWritable()` replaced it. Safari 26.4+ ships it; Chrome and Firefox
 *   have no implementation and no announced plans.
 * Both are therefore optional and must be feature-detected.
 */
interface WebTransportDatagrams {
  readonly readable?: ReadableStream<Uint8Array>;
  readonly writable?: WritableStream<Uint8Array>;
  createWritable?(options?: { sendOrder?: number }): WritableStream<Uint8Array>;
}

interface WebTransportBidirectionalStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

/**
 * Build a useful message from a WebTransport failure.
 * WebTransportError carries `source` ('session' | 'stream') and `streamErrorCode`,
 * which are the only signals distinguishing a handshake failure from a timeout
 * or an application-level close. Collapsing them loses the diagnosis.
 */
function describeWebTransportError(err: unknown): string {
  if (err == null) return 'Connection failed';

  const e = err as { message?: string; name?: string; source?: string; streamErrorCode?: number | null };
  const parts: string[] = [e.message || e.name || String(err)];

  if (e.source) parts.push(`source=${e.source}`);
  if (e.streamErrorCode != null) parts.push(`streamErrorCode=${e.streamErrorCode}`);

  return parts.join(' ');
}

export class WebTransportClient implements Transport {
  private transport: WebTransport | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private options: TransportOptions;
  private _state: TransportState = 'disconnected';
  private readLoopActive = false;
  private datagramLoopActive = false;

  constructor(options: TransportOptions) {
    this.options = options;
  }

  get state(): TransportState {
    return this._state;
  }

  get connected(): boolean {
    return this._state === 'connected';
  }

  /**
   * Connect to a WebTransport server.
   */
  async connect(url: string): Promise<void> {
    if (this._state !== 'disconnected') {
      throw new Error('Already connected or connecting');
    }

    this._state = 'connecting';

    try {
      // Create WebTransport connection
      this.transport = new WebTransport(url);

      // Calling close() while still connecting rejects both `ready` and `closed`
      // per spec. Callers may abandon this transport before it settles (the
      // connect timeout in createTransport does exactly that), so mark both as
      // handled now to avoid unhandled rejections - fatal under Node's default
      // --unhandled-rejections=throw. The real handlers are attached below.
      this.transport.ready.catch(() => {});
      this.transport.closed.catch(() => {});

      await this.transport.ready;

      // Open bidirectional stream for reliable messages
      const stream = await this.transport.createBidirectionalStream();
      this.writer = stream.writable.getWriter();

      // Get datagram writer for volatile messages.
      // See WebTransportDatagrams above - the two forms are engine-split, so
      // prefer the current spec and fall back to the legacy attribute.
      const datagrams = this.transport.datagrams;
      const datagramWritable =
        typeof datagrams.createWritable === 'function'
          ? datagrams.createWritable()
          : datagrams.writable;

      if (!datagramWritable) {
        // Datagrams are the reason to prefer WebTransport over WebSocket, so
        // this is fatal - fail loudly and let the caller fall back to WebSocket
        // rather than silently degrading volatile writes to the reliable stream.
        throw new Error(
          'WebTransport datagrams unavailable: neither datagrams.createWritable() nor datagrams.writable is supported'
        );
      }
      this.datagramWriter = datagramWritable.getWriter();

      this._state = 'connected';

      // Start reading from reliable stream
      this.readLoop(stream.readable.getReader());

      // Start reading datagrams
      const datagramReadable = datagrams.readable;
      if (datagramReadable) {
        this.datagramLoop(datagramReadable.getReader());
      }

      // Handle connection close
      this.transport.closed
        .then((info) => {
          this.handleClose(info?.closeCode ?? 0, info?.reason ?? '');
        })
        .catch((err) => {
          this.handleClose(0, describeWebTransportError(err));
        });

      this.options.onOpen();
    } catch (err) {
      this._state = 'disconnected';
      this.transport = null;
      this.writer = null;
      this.datagramWriter = null;
      throw err;
    }
  }

  /**
   * Read messages from the reliable stream.
   * Messages are framed with 4-byte big-endian length prefix.
   */
  private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    this.readLoopActive = true;
    let buffer = new Uint8Array(0);

    try {
      while (this.readLoopActive) {
        const { value, done } = await reader.read();
        if (done) break;

        // Append new data to buffer
        const newBuffer = new Uint8Array(buffer.length + value.length);
        newBuffer.set(buffer);
        newBuffer.set(value, buffer.length);
        buffer = newBuffer;

        // Parse complete messages
        while (buffer.length >= 4) {
          const view = new DataView(buffer.buffer, buffer.byteOffset);
          const msgLength = view.getUint32(0, false); // big-endian

          if (buffer.length < 4 + msgLength) break; // Not enough data yet

          // Extract message
          const msgBytes = buffer.slice(4, 4 + msgLength);
          const json = new TextDecoder().decode(msgBytes);

          // Deliver to handler
          try {
            this.options.onMessage(json);
          } catch (err) {
            console.error('Error handling message:', err);
          }

          // Remove processed bytes
          buffer = buffer.slice(4 + msgLength);
        }
      }
    } catch (err) {
      if (this.readLoopActive) {
        console.error('Read loop error:', err);
      }
    }
  }

  /**
   * Read volatile events from datagrams.
   * No framing needed - each datagram is a complete JSON message.
   */
  private async datagramLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    this.datagramLoopActive = true;

    try {
      while (this.datagramLoopActive) {
        const { value, done } = await reader.read();
        if (done) break;

        const json = new TextDecoder().decode(value);

        // Deliver to handler
        try {
          this.options.onMessage(json);
        } catch (err) {
          console.error('Error handling datagram:', err);
        }
      }
    } catch (err) {
      if (this.datagramLoopActive) {
        console.error('Datagram loop error:', err);
      }
    }
  }

  /**
   * Handle connection close.
   */
  private handleClose(code: number, reason: string): void {
    if (this._state === 'disconnected') return;

    this.readLoopActive = false;
    this.datagramLoopActive = false;
    this._state = 'disconnected';
    this.transport = null;
    this.writer = null;
    this.datagramWriter = null;

    this.options.onClose(code, reason);
  }

  /**
   * Send a message over the reliable stream.
   * Uses 4-byte big-endian length prefix.
   */
  send(data: string): void {
    if (!this.writer || this._state !== 'connected') {
      throw new Error('WebTransport not connected');
    }

    const encoder = new TextEncoder();
    const msgBytes = encoder.encode(data);

    // Create length prefix (4 bytes, big-endian)
    const lengthBuffer = new ArrayBuffer(4);
    new DataView(lengthBuffer).setUint32(0, msgBytes.length, false); // false = big-endian

    // Send length + message
    // Note: We can't await in a sync method, so we fire and let errors bubble up
    this.writer.write(new Uint8Array(lengthBuffer)).catch((err) => {
      console.error('Failed to write length prefix:', err);
    });
    this.writer.write(msgBytes).catch((err) => {
      console.error('Failed to write message:', err);
    });
  }

  /**
   * Send a volatile message via datagram (unreliable).
   * No framing needed - each datagram is a complete message.
   */
  sendVolatile(data: string): void {
    if (!this.datagramWriter || this._state !== 'connected') {
      throw new Error('WebTransport not connected');
    }

    const encoder = new TextEncoder();
    const msgBytes = encoder.encode(data);

    // Fire and forget - datagrams are unreliable by design
    this.datagramWriter.write(msgBytes).catch(() => {
      // Ignore datagram write errors - they're expected for unreliable transport
    });
  }

  /**
   * Close the WebTransport connection.
   */
  close(code: number = 0, reason: string = 'Client disconnect'): void {
    this.readLoopActive = false;
    this.datagramLoopActive = false;

    if (this.writer) {
      this.writer.releaseLock();
      this.writer = null;
    }

    if (this.datagramWriter) {
      this.datagramWriter.releaseLock();
      this.datagramWriter = null;
    }

    if (this.transport) {
      this.transport.close({ closeCode: code, reason });
      this.transport = null;
    }

    this._state = 'disconnected';
  }
}

/**
 * Check if WebTransport is available in the current environment.
 */
export function isWebTransportAvailable(): boolean {
  return typeof globalThis !== 'undefined' && 'WebTransport' in globalThis;
}
