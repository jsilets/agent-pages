// For tests only: a D1 stand-in that runs real SQL. It applies each file in ../migrations to a SQLite database in memory.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const DIR = join(fileURLToPath(import.meta.url), '../../migrations');

/** The parts of D1Database that the Worker uses: prepare, bind, first, all, run and batch. */
export function testDb(): D1Database {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(DIR).sort()) db.exec(readFileSync(join(DIR, f), 'utf8'));
  const prepare = (sql: string, args: SQLInputValue[] = []) => ({
    bind: (...a: SQLInputValue[]) => prepare(sql, a),
    first: async () => {
      const row = db.prepare(sql).get(...args);
      return row ? { ...row } : null;
    },
    all: async () => ({ results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { prepare, batch: async (list: { run: () => Promise<unknown> }[]) => Promise.all(list.map((s) => s.run())) } as unknown as D1Database;
}
