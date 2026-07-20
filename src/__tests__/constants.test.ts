import { describe, it, expect } from 'vitest';
import { eventTypeToShort, EventType, ServerEventType } from '../protocol/constants';

describe('event type mappings', () => {
  it('maps long to short event types for subscribe messages', () => {
    expect(eventTypeToShort['value']).toBe('v');
    expect(eventTypeToShort['child_added']).toBe('ca');
    expect(eventTypeToShort['child_changed']).toBe('cc');
    expect(eventTypeToShort['child_removed']).toBe('cr');
  });

  it('has server event types for put and patch', () => {
    expect(ServerEventType.PUT).toBe('put');
    expect(ServerEventType.PATCH).toBe('patch');
  });
});
