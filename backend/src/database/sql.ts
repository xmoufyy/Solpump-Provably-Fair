import { createClient, type Client, type InStatement, type InValue } from "@libsql/client";

export type Param = InValue;
export interface Statement {
  sql: string;
  args?: Param[];
}

/**
 * The small async SQL surface the Lab needs, over libSQL. The same code runs against a local SQLite
 * file (start.bat) and a hosted Turso database (Vercel).
 *
 * Writes that must be atomic go through `batch()`, which runs all statements in one transaction on the
 * same connection (one network round trip when hosted). Interactive transactions are deliberately not
 * offered: locally they open a second connection (losing per-connection pragmas, and a separate database
 * for ":memory:"), and hosted they cost a round trip per statement.
 *
 * Integers that cannot be represented exactly as JavaScript numbers raise an error instead of being
 * rounded (libSQL's default "number" mode).
 */
export class Sql {
  private constructor(
    private readonly client: Client,
    /** true for a file or in-memory database on this machine */
    readonly local: boolean,
    /** file path for local databases, null otherwise */
    readonly file: string | null,
  ) {}

  /** `url` is a path, ":memory:", "file:..." or a remote "libsql://..." / "https://..." URL. */
  static connect(url: string, authToken?: string): Sql {
    const remote = /^(libsql|https?|wss?):\/\//i.test(url);
    if (remote) return new Sql(createClient({ url, authToken }), false, null);
    const file = url === ":memory:" ? null : url.replace(/^file:/, "");
    return new Sql(createClient({ url: file === null ? ":memory:" : `file:${file}` }), true, file);
  }

  async all<T = Record<string, unknown>>(sql: string, ...args: Param[]): Promise<T[]> {
    const rs = await this.client.execute({ sql, args });
    return rs.rows.map((row) => Object.fromEntries(rs.columns.map((c, i) => [c, row[i]])) as T);
  }

  async get<T = Record<string, unknown>>(sql: string, ...args: Param[]): Promise<T | undefined> {
    return (await this.all<T>(sql, ...args))[0];
  }

  async run(sql: string, ...args: Param[]): Promise<{ changes: number; lastInsertRowid: number }> {
    const rs = await this.client.execute({ sql, args });
    return { changes: rs.rowsAffected, lastInsertRowid: Number(rs.lastInsertRowid ?? 0) };
  }

  /** Several statements separated by semicolons, without parameters and without a transaction. */
  async exec(sql: string): Promise<void> {
    await this.client.executeMultiple(sql);
  }

  /** All statements in one transaction: either every statement applies or none does. */
  async batch(statements: (Statement | string)[]): Promise<{ changes: number; lastInsertRowid: number }[]> {
    if (statements.length === 0) return [];
    const rs = await this.client.batch(statements as InStatement[], "write");
    return rs.map((r) => ({ changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid ?? 0) }));
  }

  close() {
    this.client.close();
  }
}
