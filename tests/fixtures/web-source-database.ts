import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'
import type { Pool } from 'pg'

export async function createWebSourceTestDatabase() {
  const db = new PGlite({ extensions: { vector } })
  const pool = {
    query: async (sql: string, params?: unknown[]) => { const result = await db.query(sql, params); return { ...result, rowCount: result.affectedRows ?? result.rows.length } },
    connect: async () => ({ query: pool.query, release() {} }),
  } as unknown as Pool
  await db.exec(`CREATE EXTENSION vector;
    CREATE TABLE organization(id text PRIMARY KEY,metadata text);
    CREATE TABLE help_collection(id uuid PRIMARY KEY,org_id text,name text,description text,icon text DEFAULT 'folder',position int,visible boolean DEFAULT true);
    CREATE TABLE scheduled_task(id uuid PRIMARY KEY,kind text NOT NULL,ref_id uuid,item_id text,schedule_at timestamptz NOT NULL,status text DEFAULT 'pending',attempts int DEFAULT 0,result text,manual_retry boolean DEFAULT false,updated_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX task_reference ON scheduled_task(kind,ref_id) WHERE item_id IS NULL;`)
  for (const migration of ['0020_help_vector_index', '0021_ai_training']) {
    await db.exec(await readFile(new URL(`../../server/db/migrations/${migration}.sql`, import.meta.url), 'utf8'))
  }
  const orgId = 'web-source-' + randomUUID()
  await pool.query('INSERT INTO organization(id) VALUES($1)', [orgId])
  return { db, pool, orgId }
}
