/**
 * Storage interface contract.
 *
 * Persistence only. NEVER business logic.
 * Strategy code uses repositories, never direct DB calls.
 */

/** Generic repository contract */
export interface IRepository<T, K = string> {
  /** Find by primary key */
  findById(id: K): Promise<T | null>;

  /** Save or update */
  save(entity: T): Promise<void>;

  /** Delete by primary key */
  delete(id: K): Promise<void>;
}

/** Cache store contract (Redis) — hot ephemeral state only */
export interface ICacheStore {
  /** Get a value by key */
  get<T>(key: string): Promise<T | null>;

  /** Set a value with optional TTL in seconds */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;

  /** Delete a key */
  delete(key: string): Promise<void>;

  /** Check if key exists */
  exists(key: string): Promise<boolean>;
}
