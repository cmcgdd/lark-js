/**
 * Transport factory - creates appropriate transport based on availability and options.
 */

import { Transport, TransportOptions } from './Transport';
import { WebSocketTransport } from './WebSocketTransport';
import { WebTransportClient, isWebTransportAvailable } from './WebTransportClient';

export type TransportType = 'auto' | 'websocket' | 'webtransport';

export interface CreateTransportOptions {
  /** Force a specific transport type. Default: 'websocket' */
  transport?: TransportType;
  /** Timeout for WebTransport connection attempt in ms. Default: 2000 */
  webtransportTimeout?: number;
}

/**
 * Transform WebSocket URL to WebTransport URL.
 * wss://projectId.larkdb.net/ws → https://projectId.larkdb.net:7778-7809/wt
 *
 * Uses a random port in range 7778-7809 for load balancing.
 */
export function wsUrlToWtUrl(wsUrl: string): string {
  const url = new URL(wsUrl);

  // Change protocol: wss → https, ws → http
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';

  // Choose random port in range 7778-7809 (inclusive) for load balancing
  const port = 7778 + Math.floor(Math.random() * 32);
  url.port = String(port);

  // Change path from /ws to /wt
  url.pathname = '/wt';

  return url.toString();
}

/**
 * Result of createTransport - includes both the transport and info about what was created.
 */
export interface TransportResult {
  transport: Transport;
  type: 'websocket' | 'webtransport';
  url: string;
}

/**
 * Create a transport connection.
 *
 * By default, attempts WebTransport first (if available), falling back to WebSocket.
 * Can be forced to a specific transport type via options.
 *
 * @param wsUrl - The WebSocket URL (e.g., wss://projectId.larkdb.net/ws)
 * @param transportOptions - Callbacks for message handling
 * @param options - Transport type preferences
 */
export async function createTransport(
  wsUrl: string,
  transportOptions: TransportOptions,
  options: CreateTransportOptions = {}
): Promise<TransportResult> {
  const preferredType = options.transport || 'websocket';

  // Determine if we should try WebTransport
  const shouldTryWebTransport =
    (preferredType === 'auto' || preferredType === 'webtransport') && isWebTransportAvailable();

  // If explicitly requested webtransport but not available, throw
  if (preferredType === 'webtransport' && !isWebTransportAvailable()) {
    throw new Error('WebTransport is not available in this environment');
  }

  // Try WebTransport first if appropriate
  if (shouldTryWebTransport) {
    const wtUrl = wsUrlToWtUrl(wsUrl);
    const wtTransport = new WebTransportClient(transportOptions);
    const timeout = options.webtransportTimeout ?? 2000;

    // Create a timeout promise that we can clean up
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        reject(new Error(`WebTransport connection timeout after ${timeout}ms`));
      }, timeout);
    });

    const connectPromise = wtTransport.connect(wtUrl);

    // When the timeout wins the race, the underlying failure usually arrives
    // shortly after and is far more informative than "timeout". Report it, or
    // every WebTransport failure looks identical in the console.
    connectPromise.catch((err) => {
      if (timedOut) {
        console.warn(`WebTransport connection to ${wtUrl} failed after timeout:`, err);
      }
    });

    try {
      await Promise.race([connectPromise, timeoutPromise]);
      return {
        transport: wtTransport,
        type: 'webtransport',
        url: wtUrl,
      };
    } catch (err) {
      // Clean up the transport on failure/timeout
      try {
        wtTransport.close();
      } catch {
        // Ignore cleanup errors
      }
      // If explicitly requested webtransport, don't fall back
      if (preferredType === 'webtransport') {
        throw err;
      }
      // Otherwise fall through to WebSocket
      console.warn('WebTransport connection failed, falling back to WebSocket:', err);
    } finally {
      // Always clear the timeout to prevent unhandled rejections
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  // Use WebSocket
  const wsTransport = new WebSocketTransport(transportOptions);
  await wsTransport.connect(wsUrl);

  return {
    transport: wsTransport,
    type: 'websocket',
    url: wsUrl,
  };
}
