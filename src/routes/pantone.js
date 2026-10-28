// Pantone 色票管理。
//
// 規格書第六章沒有這個模組 —— 原本色票是寫死在前台的資料檔裡（PANTONE TPX 1,931 筆），
// 客戶無法維護。客戶明確要求後台要能管理，因此搬進資料庫並開放完整的增刪改查。
//
// 欄位與規則對齊「批次匯入規格」（routes/imports.js）：
//   ・色號「同公司、同系列不可重複」，建立後不可變更。
//     系列即 color_type（TPX、TPG…）：不同系列會有相同色號（10/22 客戶確認）
//   ・hex 一律由 R/G/B 換算，不另外收；CMYK 與 Lab 只保存與回傳，系統不運算
//   ・適用對象：全域 或 指定客戶（至少一位）

import { many, one, tx } from '../db/index.js';
import { requireAdmin } from '../lib/auth.js';
import { registerBatchDelete } from '../lib/batch-delete.js';
import { rgbToHex } from '../lib/batch-import.js';
import { badRequest, notFound } from '../lib/errors.js';
import {
  ENTITY, assertCustomersExist, assertScopedCodeUnique, attachScope, clearScope, parseScope, writeScope,
} from '../lib/scope.js';
import { pageResult, parsePaging, requireNumber, requireText } from '../lib/validate.js';

const view = (row) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  colorType: row.color_type,
  r: row.r,
  g: row.g,
  b: row.b,
  c: Number(row.c),
  m: Number(row.m),
  y: Number(row.y),
  k: Number(row.k),
  labL: Number(row.lab_l),
  labA: Number(row.lab_a),
  labB: Number(row.lab_b),
  hex: row.hex,
  scopeType: row.scope_type,
  customers: row.customers ?? [],
});

/** 撞號訊息帶上系列，使用者才知道是哪個系列已經有這個色號 */
export const seriesLabel = (colorType) => (colorType ? `${colorType} 系列的色號` : '未分系列的色號');

/** 新增與編輯共用的欄位（色號除外）。 */
function readFields(body) {
  const channel = (key) => {
    const value = requireNumber(body?.[key], key.toUpperCase(), { min: 0, max: 255 });
    if (!Number.isInteger(value)) throw badRequest(`${key.toUpperCase()}必須為整數`);
    return value;
  };
  const optional = (key, label, range) => requireNumber(body?.[key], label, { required: false, ...range }) ?? 0;
  const percent = { min: 0, max: 100, decimals: 2 };

  const r = channel('r');
  const g = channel('g');
  const b = channel('b');
  return {
    name: requireText(body?.name, '名稱', 100, { required: false }),
    colorType: requireText(body?.colorType, '類型', 20, { required: false }),
    r, g, b,
    c: optional('c', 'C', percent),
    m: optional('m', 'M', percent),
    y: optional('y', 'Y', percent),
    k: optional('k', 'K', percent),
    labL: optional('labL', 'Lab L', { decimals: 3 }),
    labA: optional('labA', 'Lab a', { decimals: 3 }),
    labB: optional('labB', 'Lab b', { decimals: 3 }),
    hex: rgbToHex(r, g, b),
  };
}

export default async function pantoneRoutes(app) {
  app.addHook('preHandler', requireAdmin);

  // 色票有近兩千筆，清單一律分頁，並支援以色號或名稱搜尋
  app.get('/api/admin/pantone', async (request) => {
    const paging = parsePaging(request.query, { defaultSize: 50 });
    const params = [];
    let where = '';
    if (request.query?.keyword) {
      params.push(`%${String(request.query.keyword).trim()}%`);
      where = `where code ilike $1 or name ilike $1`;
    }
    const rows = await many(
      `select * from pantone_colors ${where}
        order by sort_order, code
        limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, paging.size, paging.offset],
    );
    const { count } = await one(`select count(*)::int as count from pantone_colors ${where}`, params);
    await attachScope(ENTITY.pantone, rows);
    return pageResult(rows.map(view), count, paging);
  });

  app.post('/api/admin/pantone', async (request, reply) => {
    const code = requireText(request.body?.code, '色號', 50);
    const fields = readFields(request.body);
    const scope = parseScope(request.body);
    await assertCustomersExist(scope.customerIds);
    await assertScopedCodeUnique({
      table: 'pantone_colors', entityType: ENTITY.pantone, code, scope,
      sameAs: { color_type: fields.colorType }, label: seriesLabel(fields.colorType),
    });

    const row = await tx(async (dbx) => {
      const created = await dbx.query(
        `insert into pantone_colors
           (code, name, color_type, r, g, b, c, m, y, k, lab_l, lab_a, lab_b, hex, scope_type, sort_order)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                 coalesce((select max(sort_order) from pantone_colors), 0) + 1)
         returning *`,
        [code, fields.name, fields.colorType, fields.r, fields.g, fields.b,
         fields.c, fields.m, fields.y, fields.k, fields.labL, fields.labA, fields.labB,
         fields.hex, scope.scopeType],
      ).then((res) => res.rows[0]);
      await writeScope(dbx, ENTITY.pantone, created.id, scope);
      return created;
    });
    await attachScope(ENTITY.pantone, [row]);
    reply.code(201);
    return view(row);
  });

  app.put('/api/admin/pantone/:id', async (request) => {
    const current = await one('select * from pantone_colors where id = $1', [request.params.id]);
    if (!current) throw notFound('色票不存在');

    const fields = readFields(request.body);
    const scope = parseScope(request.body);
    await assertCustomersExist(scope.customerIds);
    // 適用對象改了，色號的可見範圍跟著變，要重新檢查有沒有撞號
    await assertScopedCodeUnique({
      table: 'pantone_colors', entityType: ENTITY.pantone, code: current.code,
      scope, excludeId: current.id,
      sameAs: { color_type: fields.colorType }, label: seriesLabel(fields.colorType),
    });

    // 編輯時不得修改色號，其餘可改
    const row = await tx(async (dbx) => {
      const updated = await dbx.query(
        `update pantone_colors
            set name = $2, color_type = $3, r = $4, g = $5, b = $6,
                c = $7, m = $8, y = $9, k = $10, lab_l = $11, lab_a = $12, lab_b = $13,
                hex = $14, scope_type = $15, updated_at = now()
          where id = $1 returning *`,
        [current.id, fields.name, fields.colorType, fields.r, fields.g, fields.b,
         fields.c, fields.m, fields.y, fields.k, fields.labL, fields.labA, fields.labB,
         fields.hex, scope.scopeType],
      ).then((res) => res.rows[0]);
      await writeScope(dbx, ENTITY.pantone, current.id, scope);
      return updated;
    });
    await attachScope(ENTITY.pantone, [row]);
    return view(row);
  });

  async function deletePantone(id) {
    const current = await one('select id from pantone_colors where id = $1', [id]);
    if (!current) throw notFound('色票不存在');
    // 色票沒有被其他資料表引用（前台只存色號字串），可直接刪除
    await tx(async (dbx) => {
      await clearScope(dbx, ENTITY.pantone, current.id);
      await dbx.query('delete from pantone_colors where id = $1', [current.id]);
    });
  }

  app.delete('/api/admin/pantone/:id', async (request, reply) => {
    await deletePantone(Number(request.params.id));
    reply.code(204);
  });

  registerBatchDelete(app, '/api/admin/pantone', deletePantone);
}
