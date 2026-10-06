import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';

export function createDb(url: string, opts: { max?: number } = {}) {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    // Les payloads de timeline sont gros : on évite que postgres.js garde en
    // mémoire des statements préparés sur des requêtes à usage unique.
    prepare: false,
  });
  return { db: drizzle(sql, { schema }), sql };
}

export type Database = ReturnType<typeof createDb>['db'];
