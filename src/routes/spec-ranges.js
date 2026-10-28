// 規格書 6-(4) 布厚布重範圍設定 / 圖表 19-21
// ※ 可設定全域的預設範圍區間。
// ※ 可新增單一客戶的設定值；每個客戶只能被獨立設定一組。
//
// 註：規格書圖表 21 布厚「最大值 預設為 34」與同頁畫面圖及第 11 頁的 3.4 mm 不符，
// 判定為文件筆誤，此處以 3.4 為準（已列入待客戶確認清單）。

import { many, one, query } from '../db/index.js';
import { requireAdmin } from '../lib/auth.js';
import { registerBatchDelete } from '../lib/batch-delete.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { requireInt, requireNumber, requireText } from '../lib/validate.js';

export const DEFAULT_RANGE = {
  weightMin: 43, weightMax: 527, weightUnit: 'g/m2',
  thicknessMin: 0.01, thicknessMax: 3.4, thicknessUnit: 'mm',
};

const view = (row) => ({
  id: row.id,
  customerId: row.customer_id,
  customerName: row.customer_name ?? null,
  weightMin: Number(row.weight_min),
  weightMax: Number(row.weight_max),
  weightUnit: row.weight_unit,
  thicknessMin: Number(row.thickness_min),
  thicknessMax: Number(row.thickness_max),
  thicknessUnit: row.thickness_unit,
});

// 數字，小數點後兩位、0.01~999
const num = (value, label) => requireNumber(value, label, { min: 0.01, max: 999, decimals: 2 });

function readBody(body) {
  const data = {
    weightMin: num(body?.weightMin, '布重最小值'),
    weightMax: num(body?.weightMax, '布重最大值'),
    weightUnit: requireText(body?.weightUnit, '布重單位', 50),
    thicknessMin: num(body?.thicknessMin, '布厚最小值'),
    thicknessMax: num(body?.thicknessMax, '布厚最大值'),
    thicknessUnit: requireText(body?.thicknessUnit, '布厚單位', 50),
  };
  if (data.weightMax < data.weightMin) throw badRequest('布重最大值不得小於最小值');
  if (data.thicknessMax < data.thicknessMin) throw badRequest('布厚最大值不得小於最小值');
  return data;
}

const SELECT = `select s.*, c.name as customer_name
                  from spec_ranges s
                  left join customers c on c.id = s.customer_id`;

/** 取得某客戶適用的範圍：有專屬設定就用專屬，否則落回全域預設。 */
export async function resolveRangeFor(customerId) {
  if (customerId) {
    const own = await one(`${SELECT} where s.customer_id = $1`, [customerId]);
    if (own) return view(own);
  }
  const global = await one(`${SELECT} where s.customer_id is null`);
  return global ? view(global) : { id: null, customerId: null, customerName: null, ...DEFAULT_RANGE };
}

export default async function specRangeRoutes(app) {
  app.addHook('preHandler', requireAdmin);

  app.get('/api/admin/spec-ranges', async () => {
    const rows = await many(`${SELECT} order by s.customer_id nulls first, c.name`);
    const global = rows.find((row) => row.customer_id === null);
    return {
      global: global ? view(global) : { id: null, customerId: null, customerName: null, ...DEFAULT_RANGE },
      customers: rows.filter((row) => row.customer_id !== null).map(view),
    };
  });

  // 儲存全域預設（畫面上的「儲存全域預設」按鈕）
  app.put('/api/admin/spec-ranges/global', async (request) => {
    const data = readBody(request.body);
    const existing = await one('select id from spec_ranges where customer_id is null');
    if (existing) {
      await query(
        `update spec_ranges
            set weight_min = $2, weight_max = $3, weight_unit = $4,
                thickness_min = $5, thickness_max = $6, thickness_unit = $7, updated_at = now()
          where id = $1`,
        [existing.id, data.weightMin, data.weightMax, data.weightUnit,
         data.thicknessMin, data.thicknessMax, data.thicknessUnit],
      );
    } else {
      await query(
        `insert into spec_ranges (customer_id, weight_min, weight_max, weight_unit,
                                  thickness_min, thickness_max, thickness_unit)
         values (null, $1, $2, $3, $4, $5, $6)`,
        [data.weightMin, data.weightMax, data.weightUnit,
         data.thicknessMin, data.thicknessMax, data.thicknessUnit],
      );
    }
    return view(await one(`${SELECT} where s.customer_id is null`));
  });

  app.post('/api/admin/spec-ranges', async (request, reply) => {
    const customerId = requireInt(request.body?.customerId, '客戶');
    const data = readBody(request.body);

    const customer = await one('select id, name from customers where id = $1', [customerId]);
    if (!customer) throw badRequest('客戶不存在');
    const exists = await one('select id from spec_ranges where customer_id = $1', [customerId]);
    if (exists) throw conflict(`「${customer.name}」已有專屬範圍設定，請直接編輯`);

    const created = await one(
      `insert into spec_ranges (customer_id, weight_min, weight_max, weight_unit,
                                thickness_min, thickness_max, thickness_unit)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [customerId, data.weightMin, data.weightMax, data.weightUnit,
       data.thicknessMin, data.thicknessMax, data.thicknessUnit],
    );
    reply.code(201);
    return view(await one(`${SELECT} where s.id = $1`, [created.id]));
  });

  app.put('/api/admin/spec-ranges/:id', async (request) => {
    const current = await one('select * from spec_ranges where id = $1', [request.params.id]);
    if (!current) throw notFound('範圍設定不存在');
    if (current.customer_id === null) throw badRequest('全域預設請使用 /spec-ranges/global 更新');

    const data = readBody(request.body);
    await query(
      `update spec_ranges
          set weight_min = $2, weight_max = $3, weight_unit = $4,
              thickness_min = $5, thickness_max = $6, thickness_unit = $7, updated_at = now()
        where id = $1`,
      [current.id, data.weightMin, data.weightMax, data.weightUnit,
       data.thicknessMin, data.thicknessMax, data.thicknessUnit],
    );
    return view(await one(`${SELECT} where s.id = $1`, [current.id]));
  });

  async function deleteRange(id) {
    const current = await one('select * from spec_ranges where id = $1', [id]);
    if (!current) throw notFound('範圍設定不存在');
    if (current.customer_id === null) throw badRequest('全域預設不可刪除');
    await query('delete from spec_ranges where id = $1', [current.id]);
  }

  app.delete('/api/admin/spec-ranges/:id', async (request, reply) => {
    await deleteRange(Number(request.params.id));
    reply.code(204);
  });

  registerBatchDelete(app, '/api/admin/spec-ranges', deleteRange);
}
