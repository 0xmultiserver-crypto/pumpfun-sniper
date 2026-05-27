/**
 * Serialization utilities.
 *
 * Safe JSON serialization with BigInt support.
 * No silent data loss.
 */

/**
 * JSON stringify with BigInt support.
 * Converts BigInt to string with 'n' suffix for round-trip safety.
 */
export function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key: string, val: unknown): unknown => {
    if (typeof val === 'bigint') {
      return `${val.toString()}n`;
    }
    return val;
  });
}

/**
 * JSON parse with BigInt support.
 * Converts string values ending with 'n' back to BigInt.
 */
export function jsonParse<T>(text: string): T {
  return JSON.parse(text, (_key: string, val: unknown): unknown => {
    if (typeof val === 'string' && /^-?\d+n$/.test(val)) {
      return BigInt(val.slice(0, -1));
    }
    return val;
  }) as T;
}



/** Generate a unique ID (signal/trade/position) */
export function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}_${random}`;
}
