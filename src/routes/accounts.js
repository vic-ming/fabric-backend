// 規格書 6-(2) 帳號管理 / 圖表 10
// ※ 編輯時公司和帳號不可修改，其他皆可編輯，包括密碼。
// ※ 迄日不得早於起日。
// ※ 公司清單 = 客戶管理建立的客戶 + 系統管理者；選系統管理者即為後台管理員帳號。

import { many, one, query } from '../db/index.js';
import { accountStatus, hashPassword, requireAdmin, roleOf } from '../lib/auth.js';
import { toDateString } from '../lib/dates.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { pageResult, parsePaging, requireDate, requireText } from '../lib/validate.js';

const view = (row) => ({
  id: row.id,
  customerId: row.customer_id,
  customerName: row.customer_name ?? '系統管理者',
  username: row.username,
  displayName: row.display_name,
  role: roleOf(row),
  validFrom: toDateString(row.valid_from),
  validTo: toDateString(row.valid_to),
  status: accountStatus(row),
});

const SELECT = `select a.*, c.name as customer_name
                  from accounts a
                  left join customers c on c.id = a.customer_id`;

export default async function accountRoutes(app) {
  app.addHook('preHandler', requireAdmin);

  // 畫面篩選：搜尋帳號或姓名、全部公司、全部狀態
  app.get('/api/admin/accounts', async (request) => {
    const keyword = (request.query?.keyword ?? '').trim();
    const customerId = request.query?.customerId ?? '';
    const status = request.query?.status ?? '';
    const paging = parsePaging(request.query, { defaultSize: 10 });

    const conditions = [];
    const params = [];
    if (keyword) {
      params.push(`%${keyword}%`);
      conditions.push(`(a.username ilike $${params.length} or a.display_name ilike $${params.length})`);
    }
    if (customerId === 'admin') {
      conditions.push('a.customer_id is null');
    } else if (customerId) {
      params.push(Number(customerId));
      conditions.push(`a.customer_id = $${params.length}`);
    }
    // 狀態由生效期間推導，不另存欄位
    if (status === 'active') conditions.push('current_date between a.valid_from and a.valid_to');
    if (status === 'inactive') conditions.push('current_date not between a.valid_from and a.valid_to');

    const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
    const rows = await many(
      `${SELECT} ${where} order by c.name nulls first, a.username
       limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, paging.size, paging.offset],
    );
    // where 子句只引用 a.*，計數不需要 join 客戶表
    const { count } = await one(`select count(*)::int as count from accounts a ${where}`, params);
    return pageResult(rows.map(view), count, paging);
  });

  app.get('/api/admin/accounts/:id', async (request) => {
    const row = await one(`${SELECT} where a.id = $1`, [request.params.id]);
    if (!row) throw notFound('帳號不存在');
    return view(row);
  });

  app.post('/api/admin/accounts', async (request, reply) => {
    const body = request.body ?? {};
    // customerId 為 null / 'admin' 代表系統管理者帳號
    const customerId = body.customerId === null || body.customerId === '' || body.customerId === 'admin'
      ? null
      : Number(body.customerId);
    if (customerId !== null) {
      const customer = await one('select id from customers where id = $1', [customerId]);
      if (!customer) throw badRequest('選擇的公司不存在');
    }

    const username = requireText(body.username, '帳號', 50);
    const displayName = requireText(body.displayName, '姓名', 50);
    const password = requireText(body.password, '密碼', 50);
    const validFrom = requireDate(body.validFrom, '生效起日');
    const validTo = requireDate(body.validTo, '生效迄日');
    if (validTo < validFrom) throw badRequest('生效迄日不得早於生效起日');

    const exists = await one('select id from accounts where username = $1', [username]);
    if (exists) throw conflict(`帳號 ${username} 已存在`);

    const created = await one(
      `insert into accounts (customer_id, username, display_name, password_hash, valid_from, valid_to)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [customerId, username, displayName, await hashPassword(password), validFrom, validTo],
    );
    reply.code(201);
    return view(await one(`${SELECT} where a.id = $1`, [created.id]));
  });

  app.put('/api/admin/accounts/:id', async (request) => {
    const current = await one('select * from accounts where id = $1', [request.params.id]);
    if (!current) throw notFound('帳號不存在');

    const body = request.body ?? {};
    const displayName = requireText(body.displayName, '姓名', 50);
    const validFrom = requireDate(body.validFrom, '生效起日');
    const validTo = requireDate(body.validTo, '生效迄日');
    if (validTo < validFrom) throw badRequest('生效迄日不得早於生效起日');
    // 密碼留白代表不變更
    const password = body.password ? requireText(body.password, '密碼', 50) : null;

    // 公司與帳號建立後不可修改，此處刻意不讀 body 的 customerId / username
    await query(
      `update accounts
          set display_name = $2, valid_from = $3, valid_to = $4,
              password_hash = coalesce($5, password_hash), updated_at = now()
        where id = $1`,
      [current.id, displayName, validFrom, validTo, password ? await hashPassword(password) : null],
    );
    return view(await one(`${SELECT} where a.id = $1`, [current.id]));
  });

  app.delete('/api/admin/accounts/:id', async (request, reply) => {
    const id = Number(request.params.id);
    if (id === request.user.id) throw badRequest('不可刪除自己目前登入的帳號');
    const current = await one('select id from accounts where id = $1', [id]);
    if (!current) throw notFound('帳號不存在');
    await query('delete from accounts where id = $1', [id]);
    reply.code(204);
  });
}
