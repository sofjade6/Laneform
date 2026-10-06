import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const { db, sql } = createDb(url, { max: 1 });
await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
await sql.end();
console.log('migrations applied');
