// 規格書 6-(1) 客戶管理（後台顯示為「公司管理」）
// ※ 所有欄位皆可編輯，含統一編號 —— 打錯要能改，但仍不得與其他公司重複。
// ※ 刪除（10/22 客戶要求，A 方案）：底下還有帳號、客戶圖庫印花、專屬範圍，
//    或被任何資料指定為適用對象時不得刪除，並列出要先處理哪些。
//    沒有任何關聯的公司（例如建錯的）才能真的刪掉。
// ※ 停用：is_active = false。停用公司底下的帳號無法登入前台，後台清單照常顯示。

import { many, one, query } from '../db/index.js';
import { requireAdmin } from '../lib/auth.js';
import { registerBatchDelete } from '../lib/batch-delete.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { ENTITY } from '../lib/scope.js';
import { pageResult, parsePaging, requireBool, requireText } from '../lib/validate.js';

// 適用對象的 entity_type → 畫面上的模組名稱，刪除被擋時告訴使用者去哪裡處理
const ENTITY_LABEL = {
  [ENTITY.fabricType]: '布樣種類',
  [ENTITY.weave]: '組織',
  [ENTITY.composition]: '成分',
  [ENTITY.elasticity]: '彈性',
  [ENTITY.weaveSpec]: '組織規格',
  [ENTITY.background]: '背景',
  [ENTITY.model3d]: '3D 模型',
  [ENTITY.pantone]: 'Pantone 色票',
};

/** 列出公司底下還掛著的資料，空陣列代表可以刪。 */
async function blockersOf(customerId) {
  const [accounts, patterns, ranges, scoped] = await Promise.all([
    one('select count(*)::int as count from accounts where customer_id = $1', [customerId]),
    one('select count(*)::int as count from patterns where customer_id = $1', [customerId]),
    one('select count(*)::int as count from spec_ranges where customer_id = $1', [customerId]),
    many(
      `select entity_type, count(*)::int as count from scope_customers
        where customer_id = $1 group by entity_type order by entity_type`,
      [customerId],
    ),
  ]);
  const list = [];
  if (accounts.count) list.push(`帳號 ${accounts.count} 個`);
  if (patterns.count) list.push(`客戶圖庫印花 ${patterns.count} 張`);
  if (ranges.count) list.push('布厚布重專屬範圍 1 組');
  for (const row of scoped) {
    list.push(`${ENTITY_LABEL[row.entity_type] ?? row.entity_type} ${row.count} 筆（適用對象）`);
  }
  return list;
}

async function deleteCustomer(id) {
  const current = await one('select * from customers where id = $1', [id]);
  if (!current) throw notFound('公司不存在');
  const blockers = await blockersOf(current.id);
  if (blockers.length > 0) {
    throw badRequest(`「${current.name}」底下還有：${blockers.join('、')}，請先刪除或改掛其他公司後再刪除`);
  }
  await query('delete from customers where id = $1', [current.id]);
}

const view = (row) => ({
  id: row.id,
  name: row.name,
  taxId: row.tax_id,
  contactName: row.contact_name,
  contactPhone: row.contact_phone,
  contactAddress: row.contact_address,
  contactEmail: row.contact_email,
  isActive: row.is_active,
  createdAt: row.created_at,
});

function readBody(body) {
  return {
    name: requireText(body?.name, '公司名稱', 50),
    taxId: requireText(body?.taxId, '統一編號', 50),
    contactName: requireText(body?.contactName, '聯絡人', 50, { required: false }),
    contactPhone: requireText(body?.contactPhone, '聯絡電話', 50, { required: false }),
    contactAddress: requireText(body?.contactAddress, '聯絡地址', 100, { required: false }),
    contactEmail: requireText(body?.contactEmail, '聯絡信箱', 50, { required: false }),
  };
}

export default async function customerRoutes(app) {
  app.addHook('preHandler', requireAdmin);

  // 畫面上的搜尋列：搜尋公司名稱或統一編號
  app.get('/api/admin/customers', async (request) => {
    const keyword = (request.query?.keyword ?? '').trim();
    const paging = parsePaging(request.query, { defaultSize: 10 });
    const where = keyword ? 'where name ilike $1 or tax_id ilike $1' : '';
    const params = keyword ? [`%${keyword}%`] : [];

    const rows = await many(
      `select * from customers ${where} order by name limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, paging.size, paging.offset],
    );
    const { count } = await one(`select count(*)::int as count from customers ${where}`, params);
    return pageResult(rows.map(view), count, paging);
  });

  // 供其他模組的「適用對象」Checkbox 取用完整客戶清單，不分頁
  // 各模組的下拉選單（帳號的公司、適用對象的客戶清單）用這支。
  // 停用的公司不列出來，避免被指派到新資料；已經存在的關聯不受影響，
  // 那些是從 scope_customers join 回來的，不經過這裡。
  app.get('/api/admin/customers/all', async () => {
    const rows = await many('select id, name, tax_id from customers where is_active order by name');
    return rows.map((row) => ({ id: row.id, name: row.name, taxId: row.tax_id }));
  });

  app.get('/api/admin/customers/:id', async (request) => {
    const row = await one('select * from customers where id = $1', [request.params.id]);
    if (!row) throw notFound('公司不存在');
    return view(row);
  });

  app.post('/api/admin/customers', async (request, reply) => {
    const data = readBody(request.body);
    const exists = await one('select id from customers where tax_id = $1', [data.taxId]);
    if (exists) throw conflict(`統一編號 ${data.taxId} 已存在，不可重複建立`);

    const row = await one(
      `insert into customers (name, tax_id, contact_name, contact_phone, contact_address, contact_email)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [data.name, data.taxId, data.contactName, data.contactPhone, data.contactAddress, data.contactEmail],
    );
    reply.code(201);
    return view(row);
  });

  app.put('/api/admin/customers/:id', async (request) => {
    const current = await one('select * from customers where id = $1', [request.params.id]);
    if (!current) throw notFound('公司不存在');

    const data = readBody(request.body);
    // 統一編號可以修改，但不得與其他公司重複
    const clash = await one(
      'select id from customers where tax_id = $1 and id <> $2',
      [data.taxId, current.id],
    );
    if (clash) throw conflict(`統一編號 ${data.taxId} 已存在，不得重複`);

    const row = await one(
      `update customers
          set name = $2, tax_id = $3, contact_name = $4, contact_phone = $5,
              contact_address = $6, contact_email = $7, updated_at = now()
        where id = $1 returning *`,
      [current.id, data.name, data.taxId, data.contactName, data.contactPhone,
       data.contactAddress, data.contactEmail],
    );
    return view(row);
  });

  // 啟用／停用。停用的公司不會出現在前台，但後台清單仍看得到，可隨時啟用回來。
  app.put('/api/admin/customers/:id/active', async (request) => {
    const current = await one('select * from customers where id = $1', [request.params.id]);
    if (!current) throw notFound('公司不存在');
    const isActive = requireBool(request.body?.isActive, '啟用狀態');
    const row = await one(
      'update customers set is_active = $2, updated_at = now() where id = $1 returning *',
      [current.id, isActive],
    );
    return view(row);
  });

  app.delete('/api/admin/customers/:id', async (request, reply) => {
    await deleteCustomer(Number(request.params.id));
    reply.code(204);
  });

  registerBatchDelete(app, '/api/admin/customers', deleteCustomer);
}
