// 「適用對象」共用邏輯。
//
// 規格書中布樣種類、組織、成分、彈性、組織規格、背景、3D 模型七個模組
// 都有同一組欄位：Radio「全域／指定客戶」＋ Checkbox 客戶清單，
// 且都附註「當選擇指定客戶時，至少需選擇一項始得儲存」。
// 這裡把該規則集中一處，避免七份重複實作。

import { many, one, query } from '../db/index.js';
import { badRequest, conflict } from './errors.js';
import { requireIdArray, requireOneOf } from './validate.js';

export const ENTITY = {
  fabricType: 'fabric_type',
  weave: 'weave',
  composition: 'composition',
  elasticity: 'elasticity',
  weaveSpec: 'weave_spec',
  background: 'background',
  model3d: 'model_3d',
  pantone: 'pantone',
};

/** 解析並驗證前端送來的適用對象設定。未指定時預設為全域。 */
export function parseScope(body) {
  const scopeType = requireOneOf(body?.scopeType ?? 'global', '適用對象', ['global', 'customers']);
  if (scopeType === 'global') return { scopeType, customerIds: [] };

  const customerIds = requireIdArray(body?.customerIds ?? [], '適用客戶');
  if (customerIds.length === 0) {
    throw badRequest('選擇指定客戶時，至少需選擇一位客戶');
  }
  return { scopeType, customerIds };
}

/**
 * 編碼「同公司不可重複、跨公司可重複」。
 *
 * 可不可以重複取決於兩筆資料有沒有共同的可見對象，所以沒辦法用唯一索引表達：
 *   ・新資料是全域 → 所有公司都看得到，與表內任何一筆同編碼者都衝突
 *   ・新資料指定客戶 → 只跟「全域」或「同樣指定到這幾間公司」的資料衝突
 * 例：甲公司與乙公司可以各有一個編碼 WO 的布樣種類，但若已存在一筆全域的 WO，
 * 兩家都看得到它，就不能再建。
 *
 * sameAs 讓編碼搭配其他欄位一起判斷，例如 Pantone 是「同系列內」色號不可重複：
 *   sameAs = { color_type: 'TPX' } → 只有色號相同、且系列也相同才算撞號。
 *
 * table 與 sameAs 的欄位名稱只由程式內的呼叫端以常數傳入，不接受外部輸入。
 */
export async function assertScopedCodeUnique({
  table, entityType, code, scope, excludeId = null, label = '編碼', sameAs = {},
}) {
  const extra = Object.entries(sameAs);
  const extraSql = extra
    .map(([column], i) => `and t.${column} is not distinct from $${6 + i}`)
    .join(' ');
  const clash = await one(
    `select t.id from ${table} t
      where t.code = $1
        and ($2::int is null or t.id <> $2)
        ${extraSql}
        and ($3
             or t.scope_type = 'global'
             or exists (select 1 from scope_customers sc
                         where sc.entity_type = $4
                           and sc.entity_id = t.id
                           and sc.customer_id = any($5::int[])))
      limit 1`,
    [code, excludeId, scope.scopeType === 'global', entityType, scope.customerIds,
     ...extra.map(([, value]) => value)],
  );
  if (clash) {
    throw conflict(`${label} ${code} 已被同一適用對象的資料使用，不得重複`);
  }
}

/** 確認客戶皆存在，避免寫入孤兒關聯。 */
export async function assertCustomersExist(customerIds) {
  if (customerIds.length === 0) return;
  const rows = await many('select id from customers where id = any($1::int[])', [customerIds]);
  if (rows.length !== customerIds.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = customerIds.filter((id) => !found.has(id));
    throw badRequest(`客戶不存在：${missing.join(', ')}`);
  }
}

/** 覆寫某筆資料的適用客戶清單。scopeType 為 global 時清空關聯。 */
export async function writeScope(dbx, entityType, entityId, { scopeType, customerIds }) {
  const run = dbx?.query ? dbx.query.bind(dbx) : query;
  await run('delete from scope_customers where entity_type = $1 and entity_id = $2', [entityType, entityId]);
  if (scopeType !== 'customers' || customerIds.length === 0) return;
  await run(
    `insert into scope_customers (entity_type, entity_id, customer_id)
     select $1, $2, unnest($3::int[])`,
    [entityType, entityId, customerIds],
  );
}

export async function clearScope(dbx, entityType, entityId) {
  const run = dbx?.query ? dbx.query.bind(dbx) : query;
  await run('delete from scope_customers where entity_type = $1 and entity_id = $2', [entityType, entityId]);
}

/**
 * 把適用客戶掛回清單資料上，回傳格式：
 *   row.scopeType = 'global' | 'customers'
 *   row.customers = [{ id, name }]
 * 一次查完全部，不對每列各發一次查詢。
 */
export async function attachScope(entityType, rows) {
  if (rows.length === 0) return rows;
  const ids = rows.map((row) => row.id);
  const links = await many(
    `select sc.entity_id, c.id, c.name
       from scope_customers sc
       join customers c on c.id = sc.customer_id
      where sc.entity_type = $1 and sc.entity_id = any($2::int[])
      order by c.name`,
    [entityType, ids],
  );
  const grouped = new Map();
  for (const link of links) {
    if (!grouped.has(link.entity_id)) grouped.set(link.entity_id, []);
    grouped.get(link.entity_id).push({ id: link.id, name: link.name });
  }
  for (const row of rows) row.customers = grouped.get(row.id) ?? [];
  return rows;
}

/**
 * 前台可見性條件。傳入客戶 id，回傳一段可直接併入 where 的 SQL 與參數。
 * 系統管理者（customerId 為 null）看得到全部。
 */
export function visibleToCustomer(entityType, tableAlias, customerId, paramIndex) {
  if (customerId === null || customerId === undefined) {
    return { sql: 'true', params: [] };
  }
  return {
    sql: `(${tableAlias}.scope_type = 'global' or exists (
            select 1 from scope_customers sc
             where sc.entity_type = '${entityType}'
               and sc.entity_id = ${tableAlias}.id
               and sc.customer_id = $${paramIndex}))`,
    params: [customerId],
  };
}
