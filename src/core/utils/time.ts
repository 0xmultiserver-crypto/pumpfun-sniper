/**
 * Time utilities.
 *
 * Consistent timestamp handling across the system.
 */

/** Get current timestamp in milliseconds */
export function nowMs(): number {
  return Date.now();
}

/** Calculate elapsed time in milliseconds */
export function elapsedMs(startMs: number): number {
  return Date.now() - startMs;
}


