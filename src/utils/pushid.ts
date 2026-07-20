/**
 * Push ID generation - chronologically-sortable unique IDs.
 *
 * Format: 20 characters
 * - First 8 chars: timestamp (milliseconds since epoch, base64-encoded)
 * - Last 12 chars: random suffix (incremented on same-millisecond calls)
 *
 * This ensures:
 * - IDs created later sort after IDs created earlier
 * - IDs created in the same millisecond are unique and still sort correctly
 */

const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

// Persistent state for generating unique IDs within the same millisecond
let lastPushTime = 0;
let lastRandChars: number[] = [];

/**
 * Generate a unique push ID.
 */
export function generatePushId(): string {
  let now = Date.now();
  const duplicateTime = now === lastPushTime;
  lastPushTime = now;

  // Encode timestamp in first 8 characters
  const timeChars = new Array(8);
  for (let i = 7; i >= 0; i--) {
    timeChars[i] = PUSH_CHARS.charAt(now % 64);
    now = Math.floor(now / 64);
  }

  let id = timeChars.join('');

  if (!duplicateTime) {
    // New timestamp - generate fresh random suffix
    lastRandChars = [];
    for (let i = 0; i < 12; i++) {
      lastRandChars.push(Math.floor(Math.random() * 64));
    }
  } else {
    // Same timestamp - increment the random suffix
    // This ensures uniqueness even with multiple calls in the same millisecond
    let i = 11;
    while (i >= 0 && lastRandChars[i] === 63) {
      lastRandChars[i] = 0;
      i--;
    }
    if (i >= 0) {
      lastRandChars[i]++;
    }
  }

  // Append random suffix
  for (let i = 0; i < 12; i++) {
    id += PUSH_CHARS.charAt(lastRandChars[i]);
  }

  return id;
}
