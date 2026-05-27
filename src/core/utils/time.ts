/**
 * Time utilities.
 *
 * Consistent timestamp handling across the system.
 */

/** Get current timestamp in milliseconds */
export function nowMs(): number {
  return Date.now();
}

/** Get current timestamp in seconds */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Calculate elapsed time in milliseconds */
export function elapsedMs(startMs: number): number {
  return Date.now() - startMs;
}

/** Check if a duration has elapsed */
export function hasElapsed(startMs: number, durationMs: number): boolean {
  return elapsedMs(startMs) >= durationMs;
}

/** Sleep for a given number of milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}


