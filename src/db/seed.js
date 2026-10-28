// 初始資料。
//
// 只建立規格書明文指定為「預設值」的東西，以及一組可登入的管理員帳號：
//   ・圖表 23 的 7 個預設印花分類
//   ・圖表 20 / 21 的布重、布厚全域預設範圍
// 布樣種類、組織、成分、彈性等選項不預先塞資料 —— 依專案方向，
// 這些一律由客戶在後台自行建立，後台建了什麼前台才有什麼。

import { many, one, query } from './index.js';
import { hashPassword } from '../lib/auth.js';
import { DEFAULT_RANGE } from '../routes/spec-ranges.js';
import { DEFAULT_PATTERN_CATEGORIES } from '../routes/patterns.js';

export async function seed({ log = console.log } = {}) {

  // --- 印花預設分類 ---
  const existingCategories = await many('select name from pattern_categories');
  const known = new Set(existingCategories.map((row) => row.name));
  let added = 0;
  for (const [index, name] of DEFAULT_PATTERN_CATEGORIES.entries()) {
    if (known.has(name)) continue;
    await query('insert into pattern_categories (name, sort_order) values ($1, $2)', [name, index + 1]);
    added += 1;
  }
  if (added > 0) log(`已建立 ${added} 個預設印花分類`);

  // --- 布重／布厚全域預設 ---
  const globalRange = await one('select id from spec_ranges where customer_id is null');
  if (!globalRange) {
    await query(
      `insert into spec_ranges (customer_id, weight_min, weight_max, weight_unit,
                                thickness_min, thickness_max, thickness_unit)
       values (null, $1, $2, $3, $4, $5, $6)`,
      [DEFAULT_RANGE.weightMin, DEFAULT_RANGE.weightMax, DEFAULT_RANGE.weightUnit,
       DEFAULT_RANGE.thicknessMin, DEFAULT_RANGE.thicknessMax, DEFAULT_RANGE.thicknessUnit],
    );
    log(`已建立全域預設範圍：布重 ${DEFAULT_RANGE.weightMin}~${DEFAULT_RANGE.weightMax} ${DEFAULT_RANGE.weightUnit}、`
      + `布厚 ${DEFAULT_RANGE.thicknessMin}~${DEFAULT_RANGE.thicknessMax} ${DEFAULT_RANGE.thicknessUnit}`);
  }

  // --- 初始管理員帳號 ---
  // customer_id 為 NULL 即「系統管理者」。密碼可由環境變數覆寫。
  const anyAdmin = await one('select id from accounts where customer_id is null');
  if (!anyAdmin) {
    const username = process.env.ADMIN_USERNAME ?? 'admin';
    const password = process.env.ADMIN_PASSWORD ?? 'admin1234';
    await query(
      `insert into accounts (customer_id, username, display_name, password_hash, valid_from, valid_to)
       values (null, $1, $2, $3, current_date, date '2099-12-31')`,
      [username, '系統管理者', await hashPassword(password)],
    );
    log(`已建立管理員帳號：${username} / ${password}　← 上線前請務必修改密碼`);
  }
}

// 直接以 node src/db/seed.js 執行時
if (import.meta.url === `file://${process.argv[1]}`) {
  const { initDb, migrate } = await import('./index.js');
  await initDb();
  await migrate();
  await seed();
  process.exit(0);
}
