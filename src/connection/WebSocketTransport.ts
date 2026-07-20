/**
 * WebSocketTransport - WebSocket implementation of the Transport interface.
 * Works in both browser (native WebSocket) and Node.js (ws package).
 */

import WebSocketNode from 'ws';
import { Transport, TransportState, TransportOptions } from './Transport';

// Use native WebSocket in browser, ws package in Node.js
const WebSocketImpl: typeof WebSocket =
  typeof WebSocket !== 'undefined' ? WebSocket : (WebSocketNode as unknown as typeof WebSocket);

export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null;
  private options: TransportOptions;
  private _state: TransportState = 'disconnected';

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
   * Connect to a WebSocket server.
   */
  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._state !== 'disconnected') {
        reject(new Error('Already connected or connecting'));
        return;
      }

      this._state = 'connecting';

      try {
        this.ws = new WebSocketImpl(url) as WebSocket;
      } catch (err) {
        this._state = 'disconnected';
        reject(err);
        return;
      }

      const onOpen = () => {
        cleanup();
        this._state = 'connected';
        this.setupEventHandlers();
        resolve();
        this.options.onOpen();
      };

      const onError = (event: Event) => {
        cleanup();
        this._state = 'disconnected';
        this.ws = null;
        const error = new Error('WebSocket connection failed');
        reject(error);
        this.options.onError(error);
      };

      const onClose = (event: CloseEvent) => {
        cleanup();
        this._state = 'disconnected';
        this.ws = null;
        reject(new Error(`WebSocket closed: ${event.code} ${event.reason}`));
      };

      const cleanup = () => {
        this.ws?.removeEventListener('open', onOpen);
        this.ws?.removeEventListener('error', onError);
        this.ws?.removeEventListener('close', onClose);
      };

      this.ws.addEventListener('open', onOpen);
      this.ws.addEventListener('error', onError);
      this.ws.addEventListener('close', onClose);
    });
  }

  /**
   * Set up persistent event handlers after connection is established.
   */
  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.addEventListener('message', (event: MessageEvent) => {
      this.options.onMessage(event.data as string);
    });

    this.ws.addEventListener('close', (event: CloseEvent) => {
      this._state = 'disconnected';
      this.ws = null;
      this.options.onClose(event.code, event.reason);
    });

    this.ws.addEventListener('error', () => {
      this.options.onError(new Error('WebSocket error'));
    });
  }

  /**
   * Send a message over the WebSocket.
   */
  send(data: string): void {
    if (!this.ws || this._state !== 'connected') {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(data);
  }

  /**
   * Send a volatile message.
   * WebSocket doesn't have a true unreliable channel, so this just calls send().
   */
  sendVolatile(data: string): void {
    this.send(data);
  }

  /**
   * Close the WebSocket connection.
   */
  close(code: number = 1000, reason: string = 'Client disconnect'): void {
    if (this.ws) {
      this.ws.close(code, reason);
      this.ws = null;
    }
    this._state = 'disconnected';
  }
}
