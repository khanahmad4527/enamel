import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Pool, type QueryResultRow } from "pg";
import { config } from "../config/config";

/**
 * A read pool over the practice database.
 *
 * Deliberately used for reads only. Slot search intersects five tables
 * across a date range, which is four queries in SQL and dozens of round
 * trips through the API; that is worth a direct connection. Writing
 * through it would not be — a write that skips Directus skips the
 * scheduling hook, the permission model and the audit trail with it.
 *
 * The connection has no idea who is asking. Every query in this service
 * therefore carries an explicit clinic filter derived from the caller's
 * own token, because there is no policy layer underneath to catch a
 * missing one. That is the trade this file makes, and the reason
 * `AvailabilityService` never takes a clinic id from the request body.
 */
@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private pool!: Pool;

  onModuleInit(): void {
    this.pool = new Pool({
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      password: config.db.password,
      max: 8,
      idleTimeoutMillis: 30_000,
      // A slot search that has not answered in ten seconds is not going
      // to; failing fast keeps a slow query from holding the pool.
      statement_timeout: 10_000,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  async rows<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query<T>(sql, params);
    return result.rows;
  }

  async one<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.rows<T>(sql, params);
    return rows[0] ?? null;
  }

  /**
   * A write, where the rows are not the point.
   *
   * `rows` would do, and saying `query` at the call site is the
   * difference between "I am reading something" and "I am changing
   * something" being visible in the code rather than inferred from the
   * SQL.
   */
  async query(sql: string, params: unknown[] = []): Promise<number> {
    const result = await this.pool.query(sql, params);
    return result.rowCount ?? 0;
  }

  /** Answers whether the database is reachable, for the health endpoint. */
  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
}
