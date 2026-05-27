/**
 * Environment variable loading.
 *
 * Secrets: env only. Never hardcoded (rule.md).
 * All env vars validated at startup — fail fast on missing config.
 */

import dotenv from 'dotenv';

/** Load .env file */
dotenv.config();

/** Get required env var — throws if missing */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/** Get optional env var with default */
export function optionalEnv(key: string, defaultValue: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return value;
}




