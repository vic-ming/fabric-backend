import { initDb, migrate, query } from './index.js';

const reset = process.argv.includes('--reset');

await initDb();

if (reset) {
  // 開發用：整個 public schema 砍掉重建
  await query('drop schema public cascade');
  await query('create schema public');
  console.log('已清空資料庫');
}

await migrate();
console.log('資料表已建立');
process.exit(0);
