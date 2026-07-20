/**
 * Coordinator client - handles HTTP requests to the coordinator service
 * to get connection details for a specific database.
 */

import { DEFAULT_COORDINATOR_URL } from '../protocol/constants';

export interface ConnectRequest {
  database: string;
}

export interface ConnectResponse {
  ws_url: string; // Full WebSocket URL (e.g., "wss://smash-1.larksh.com/ws")
  udp_host: string; // Direct IP for UDP connections
  udp_port: number; // UDP port
}

export interface CoordinatorError {
  error: string;
  message: string;
}

export class Coordinator {
  private readonly baseUrl: string;

  constructor(baseUrl: string = DEFAULT_COORDINATOR_URL) {
    // Remove trailing slash if present
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Request connection details from the coordinator.
   *
   * @param database - Database ID in format "project/database"
   * @returns Connection details including WebSocket URL and UDP host/port
   */
  async connect(database: string): Promise<ConnectResponse> {
    const body: ConnectRequest = { database };

    const response = await fetch(`${this.baseUrl}/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let errorMessage = `Coordinator request failed: ${response.status}`;
      try {
        const errorBody = (await response.json()) as CoordinatorError;
        if (errorBody.message) {
          errorMessage = errorBody.message;
        }
      } catch {
        // Ignore JSON parse errors
      }
      throw new Error(errorMessage);
    }

    const data = (await response.json()) as ConnectResponse;
    return data;
  }
}
