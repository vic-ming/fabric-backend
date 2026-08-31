// 資料庫存取層。
//
// 對外只暴露 query / one / many / tx 四個函式，內部依 DB_DRIVER 決定實作：
//   pglite — PostgreSQL 編譯成 WASM，跑在同一個 Node 行程內，開發免安裝伺服器
//   pg     — 連線至正式的 PostgreSQL（GCP Cloud SQL）
// 兩者皆為 PostgreSQL，SQL 方言與 $1 佔位符寫法完全相同，
// 因此 routes 層無須知道目前是哪個 driver。

import { readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { config, rootDir } from '../config.js';

let driver = null;

async function createPglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  await mkdir(config.dbDataDir, { recursive: true });
  const db = new PGlite(config.dbDataDir);
  await db.waitReady;
  return {
    kind: 'pglite',
    async query(sql, params = []) {
      const result = await db.query(sql, params);
      return { rows: result.rows ?? [], rowCount: result.affectedRows ?? (result.rows?.length ?? 0) };
    },
    async tx(fn) {
      // PGlite 為單連線，直接下 BEGIN/COMMIT 即可。
      await db.exec('begin');
      try {
        const value = await fn(driver);
        await db.exec('commit');
        return value;
      } catch (error) {
        await db.exec('rollback');
        throw error;
      }
    },
    async exec(sql) {
      await db.exec(sql);
    },
    async close() {
      await db.close();
    },
  };
}

async function createPg() {
  const pg = await import('pg');
  // 時區設在連線參數上，pool 內每條連線才會一致（單次 SET 只影響其中一條）
  const pool = new pg.default.Pool({
    connectionString: config.dbUrl,
    options: `-c timezone=${config.timezone}`,
  });
  return {
    kind: 'pg',
    async query(sql, params = []) {
      return pool.query(sql, params);
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const scoped = {
          ...this,
          query: (sql, params = []) => client.query(sql, params),
          exec: (sql) => client.query(sql),
          tx: (inner) => inner(scoped),
        };
        const value = await fn(scoped);
        await client.query('commit');
        return value;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async close() {
      await pool.end();
    },
  };
}

export async function initDb() {
  if (driver) return driver;
  driver = config.dbDriver === 'pg' ? await createPg() : await createPglite();
  // pglite 為單連線，於此處設定時區；pg 則已設在連線參數上
  if (driver.kind === 'pglite') await driver.exec(`set timezone to '${config.timezone}'`);
  return driver;
}

export function db() {
  if (!driver) throw new Error('資料庫尚未初始化，請先呼叫 initDb()');
  return driver;
}

export const query = (sql, params) => db().query(sql, params);
export const tx = (fn) => db().tx(fn);

/** 取單列；查無資料回傳 null。 */
export async function one(sql, params) {
  const { rows } = await query(sql, params);
  return rows[0] ?? null;
}

/** 取多列。 */
export async function many(sql, params) {
  const { rows } = await query(sql, params);
  return rows;
}

/** 建立所有資料表（schema.sql 內皆為 create table if not exists，可重複執行）。 */
export async function migrate() {
  const sql = await readFile(resolve(rootDir, 'src/db/schema.sql'), 'utf8');
  await db().exec(sql);
}
