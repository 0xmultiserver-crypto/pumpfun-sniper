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
