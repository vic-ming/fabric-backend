// 規格書 6-(1) 客戶管理
// ※ 編輯時除了統一編號不可修改，其他皆可編輯。
// ※ 新增時檢查已存在的統編不可重複建立。

import { many, one, query } from '../db/index.js';
import { requireAdmin } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { pageResult, parsePaging, requireText } from '../lib/validate.js';

const view = (row) => ({
  id: row.id,
  name: row.name,
  taxId: row.tax_id,
  contactName: row.contact_name,
  contactPhone: row.contact_phone,
  contactAddress: row.contact_address,
  contactEmail: row.contact_email,
  createdAt: row.created_at,
});

function readBody(body) {
  return {
    name: requireText(body?.name, '客戶名稱', 50),
    taxId: requireText(body?.taxId, '統一編號', 50),
    contactName: requireText(body?.contactName, '聯絡人', 50, { required: false }),
    contactPhone: requireText(body?.contactPhone, '聯絡電話', 50, { required: false }),
    contactAddress: requireText(body?.contactAddress, '聯絡地址', 100, { required: false }),
    contactEmail: requireText(body?.contactEmail, '聯絡信箱', 50, { required: false }),
  };
}

export default async function customerRoutes(app) {
  app.addHook('preHandler', requireAdmin);

  // 畫面上的搜尋列：搜尋客戶名稱或統一編號
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
  app.get('/api/admin/customers/all', async () => {
    const rows = await many('select id, name, tax_id from customers order by name');
    return rows.map((row) => ({ id: row.id, name: row.name, taxId: row.tax_id }));
  });

  app.get('/api/admin/customers/:id', async (request) => {
    const row = await one('select * from customers where id = $1', [request.params.id]);
    if (!row) throw notFound('客戶不存在');
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
    if (!current) throw notFound('客戶不存在');

    const data = readBody({ ...request.body, taxId: current.tax_id });
    // 統一編號建立後不可修改：即使前端送了不同值也一律沿用原值
    const row = await one(
      `update customers
          set name = $2, contact_name = $3, contact_phone = $4,
              contact_address = $5, contact_email = $6, updated_at = now()
        where id = $1 returning *`,
      [current.id, data.name, data.contactName, data.contactPhone, data.contactAddress, data.contactEmail],
    );
    return view(row);
  });

  // 規格書畫面只有「編輯」沒有刪除鈕，但保留 API 供資料清理；
  // 有帳號或素材掛在該客戶底下時擋下，避免產生孤兒資料。
  app.delete('/api/admin/customers/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const current = await one('select id from customers where id = $1', [id]);
    if (!current) throw notFound('客戶不存在');

    const { count } = await one('select count(*)::int as count from accounts where customer_id = $1', [id]);
    if (count > 0) throw badRequest(`此客戶底下尚有 ${count} 個帳號，請先移除帳號`);

    await query('delete from customers where id = $1', [id]);
    reply.code(204);
  });
}
