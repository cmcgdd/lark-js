/**
 * Transport - abstract interface for communication channels.
 * Both WebSocket and WebTransport implement this interface.
 */

export type TransportState = 'disconnected' | 'connecting' | 'connected';

export interface TransportOptions {
  onMessage: (data: string) => void;
  onOpen: () => void;
  onClose: (code: number, reason: string) => void;
  onError: (error: Error) => void;
}

/**
 * Abstract transport interface.
 * Implementations handle the specifics of WebSocket vs WebTransport.
 */
export interface Transport {
  /**
   * Current transport state.
   */
  readonly state: TransportState;

  /**
   * Whether the transport is connected.
   */
  readonly connected: boolean;

  /**
   * Connect to the server.
   */
  connect(url: string): Promise<void>;

  /**
   * Send a message over the reliable channel.
   * For WebSocket: sends as-is.
   * For WebTransport: sends with 4-byte length prefix on bidirectional stream.
   */
  send(data: string): void;

  /**
   * Send a volatile message (fire-and-forget).
   * For WebSocket: same as send() (no true unreliable channel).
   * For WebTransport: sends as datagram (unreliable UDP).
   */
  sendVolatile(data: string): void;

  /**
   * Close the transport connection.
   */
  close(code?: number, reason?: string): void;
}
