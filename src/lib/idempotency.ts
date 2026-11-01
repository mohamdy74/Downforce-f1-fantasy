/**
 * Idempotency key utilities for preventing duplicate API calls
 *
 * Uses a combination of localStorage and in-memory tracking to ensure
 * that write operations (insert/update) are only processed once even
 * if the user clicks rapidly or network retries occur.
 */

const inFlightKeys = new Set<string>();

/**
 * Generate a unique idempotency key for a specific operation
 *
 * @param prefix - Operation type prefix (e.g., 'prediction', 'sprint-pred', 'pole')
 * @param userId - Current user ID
 * @param raceId - Current race ID
 * @returns A unique idempotency key
 */
export function generateIdempotencyKey(prefix: string, userId: string, raceId: string): string {
  // Check if we already have a key in localStorage for this operation
  const storageKey = `dfr:idem:${prefix}:${userId}:${raceId}`;
  let key = localStorage.getItem(storageKey);

  if (!key) {
    // Generate a new UUID-like key
    key = `${prefix}_${userId}_${raceId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    try {
      localStorage.setItem(storageKey, key);
    } catch {
      // localStorage might be full or unavailable
    }
  }

  return key;
}

/**
 * Check if an operation with this key is already in flight
 *
 * @param key - The idempotency key to check
 * @returns true if the operation is already in flight
 */
export function isInFlight(key: string): boolean {
  return inFlightKeys.has(key);
}

/**
 * Mark an operation as in flight
 *
 * @param key - The idempotency key for the operation
 */
export function markInFlight(key: string): void {
  inFlightKeys.add(key);
}

/**
 * Mark an operation as completed and clean up the key
 *
 * @param key - The idempotency key for the operation
 * @param prefix - Operation type prefix for cleanup
 * @param userId - Current user ID for cleanup
 * @param raceId - Current race ID for cleanup
 */
export function markCompleted(key: string, prefix: string, userId: string, raceId: string): void {
  inFlightKeys.delete(key);

  // Clean up the localStorage key
  const storageKey = `dfr:idem:${prefix}:${userId}:${raceId}`;
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // Ignore localStorage errors
  }
}

/**
 * Clear all in-flight keys (useful for cleanup)
 */
export function clearInFlight(): void {
  inFlightKeys.clear();
}

/**
 * Create Supabase request headers with idempotency key
 *
 * @param key - The idempotency key
 * @returns Headers object with idempotency key
 */
export function idempotencyHeaders(key: string): Record<string, string> {
  return {
    "Idempotency-Key": key,
    "X-Idempotency-Key": key, // Some APIs use this format
  };
}
