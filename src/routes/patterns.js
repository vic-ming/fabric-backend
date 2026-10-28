// 規格書 6-(5) 印花管理 / 圖表 22-23
// ※ 可上傳、刪除印花圖片及修改名稱、分類。
// ※ 上傳後以檔名作為預設名稱放入；允許重複名稱之檔案存在。
// ※ 上傳可多選。
//
// 印花的歸屬與其他模組不同，不是「全域／指定客戶」而是二擇一：
//   一般分類 general  → 掛在某個預設分類底下
//   客戶圖庫 customer → 掛在單一客戶底下（一次僅能單選一個客戶）
//
// 另補一組規格書未列、但 3D 貼圖必要的欄位：圖案的實際公分尺寸。
// 貼圖在模型上的重複次數 = 模型公分尺寸 ÷ 圖案實際公分尺寸，
// 缺此資訊時大圖騰與小碎花會貼成同樣大小。

import { many, one, query } from '../db/index.js';
import { requireAdmin } from '../lib/auth.js';
import { registerBatchDelete } from '../lib/batch-delete.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { IMAGE_MIME, removeFile, saveUpload } from '../lib/files.js';
import { pageResult, parsePaging, requireInt, requireNumber, requireOneOf, requireText } from '../lib/validate.js';

// 規格書圖表 23 所列之預設分類
export const DEFAULT_PATTERN_CATEGORIES = [
  '迷彩', '動物紋', '大自然風景', '古典變形蟲', '花草', '幾何律動', '幾何格紋',
];

const view = (row) => ({
  id: row.id,
  kind: row.kind,
  categoryId: row.category_id,
  categoryName: row.category_name ?? null,
  customerId: row.customer_id,
  customerName: row.customer_name ?? null,
  name: row.name,
  file: { id: row.file_id, url: `/api/files/${row.storage_key}`, name: row.original_name, mimeType: row.mime_type },
  physicalWidthCm: row.physical_width_cm === null ? null : Number(row.physical_width_cm),
  physicalHeightCm: row.physical_height_cm === null ? null : Number(row.physical_height_cm),
  createdAt: row.created_at,
});

const SELECT = `select p.*, f.storage_key, f.original_name, f.mime_type,
                       pc.name as category_name, c.name as customer_name
                  from patterns p
                  join files f on f.id = p.file_id
                  left join pattern_categories pc on pc.id = p.category_id
                  left join customers c on c.id = p.customer_id`;

export default async function patternRoutes(app) {
  app.addHook('preHandler', requireAdmin);

  // ------------------------------------------------------------ 分類

  app.get('/api/admin/pattern-categories', async () => {
    const rows = await many('select * from pattern_categories order by sort_order, id');
    return rows.map((row) => ({ id: row.id, name: row.name }));
  });

  app.post('/api/admin/pattern-categories', async (request, reply) => {
    const name = requireText(request.body?.name, '分類名稱', 50);
    if (await one('select id from pattern_categories where name = $1', [name])) {
      throw conflict(`分類「${name}」已存在`);
    }
    const { max } = await one('select coalesce(max(sort_order), 0)::int as max from pattern_categories');
    const row = await one(
      'insert into pattern_categories (name, sort_order) values ($1, $2) returning *',
      [name, max + 1],
    );
    reply.code(201);
    return { id: row.id, name: row.name };
  });

  app.put('/api/admin/pattern-categories/:id', async (request) => {
    const current = await one('select * from pattern_categories where id = $1', [request.params.id]);
    if (!current) throw notFound('分類不存在');
    const name = requireText(request.body?.name, '分類名稱', 50);
    if (await one('select id from pattern_categories where name = $1 and id <> $2', [name, current.id])) {
      throw conflict(`分類「${name}」已存在`);
    }
    const row = await one(
      'update pattern_categories set name = $2 where id = $1 returning *',
      [current.id, name],
    );
    return { id: row.id, name: row.name };
  });

  async function deleteCategory(id) {
    const current = await one('select * from pattern_categories where id = $1', [id]);
    if (!current) throw notFound('分類不存在');
    const { count } = await one('select count(*)::int as count from patterns where category_id = $1', [id]);
    if (count > 0) throw badRequest(`「${current.name}」底下尚有 ${count} 張圖片，不得刪除`);
    await query('delete from pattern_categories where id = $1', [id]);
  }

  app.delete('/api/admin/pattern-categories/:id', async (request, reply) => {
    await deleteCategory(Number(request.params.id));
    reply.code(204);
  });

  registerBatchDelete(app, '/api/admin/pattern-categories', deleteCategory);

  // ------------------------------------------------------------ 印花圖片

  // 畫面上的兩層下拉：分類（一般分類／客戶圖庫）＋ 類型（預設分類清單／客戶清單）
  app.get('/api/admin/patterns', async (request) => {
    const kind = request.query?.kind ?? '';
    const paging = parsePaging(request.query, { defaultSize: 24 });
    const conditions = [];
    const params = [];

    if (kind) {
      params.push(requireOneOf(kind, '分類', ['general', 'customer']));
      conditions.push(`p.kind = $${params.length}`);
    }
    if (request.query?.categoryId) {
      params.push(Number(request.query.categoryId));
      conditions.push(`p.category_id = $${params.length}`);
    }
    if (request.query?.customerId) {
      params.push(Number(request.query.customerId));
      conditions.push(`p.customer_id = $${params.length}`);
    }
    if (request.query?.keyword) {
      params.push(`%${String(request.query.keyword).trim()}%`);
      conditions.push(`p.name ilike $${params.length}`);
    }

    const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
    const rows = await many(
      `${SELECT} ${where} order by p.created_at desc limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, paging.size, paging.offset],
    );
    const { count } = await one(`select count(*)::int as count from patterns p ${where}`, params);
    return pageResult(rows.map(view), count, paging);
  });

  // 單張上傳。原本支援多檔，但每張印花都要有自己的設計尺寸，
  // 多檔上傳時無法逐張指定，因此改為一次一張。
  // 欄位與檔案混在同一個 multipart 請求裡，先收齊再一起驗證，避免欄位順序影響結果。
  app.post('/api/admin/patterns', async (request, reply) => {
    if (!request.isMultipart()) throw badRequest('請以 multipart/form-data 上傳');

    const fields = {};
    const uploads = [];
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (uploads.length > 0) throw badRequest('一次只能上傳一張印花圖片');
        uploads.push(await saveUpload(part, 'patterns', IMAGE_MIME));
      } else {
        fields[part.fieldname] = part.value;
      }
    }

    try {
      if (uploads.length === 0) throw badRequest('請選擇要上傳的圖片檔案');
      const kind = requireOneOf(fields.kind ?? 'general', '類型', ['general', 'customer']);

      let categoryId = null;
      let customerId = null;
      if (kind === 'general') {
        categoryId = requireInt(fields.categoryId, '分類');
        if (!(await one('select id from pattern_categories where id = $1', [categoryId]))) {
          throw badRequest('分類不存在');
        }
      } else {
        customerId = requireInt(fields.customerId, '指定客戶');
        if (!(await one('select id from customers where id = $1', [customerId]))) {
          throw badRequest('客戶不存在');
        }
      }

      // 名稱為選填，未填寫則預設使用檔名
      const givenName = requireText(fields.name, '名稱', 255, { required: false });
      // 畫面標示為「圖案設計尺寸」，欄位沿用既有的 physical_* 以免動到資料結構
      const width = requireNumber(fields.physicalWidthCm, '圖案設計寬度', { required: false, min: 0.001 });
      const height = requireNumber(fields.physicalHeightCm, '圖案設計高度', { required: false, min: 0.001 });

      const file = uploads[0];
      const created = await one(
        `insert into patterns (kind, category_id, customer_id, name, file_id,
                               physical_width_cm, physical_height_cm)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [kind, categoryId, customerId, givenName || file.original_name, file.id, width, height],
      );

      reply.code(201);
      const row = await one(`${SELECT} where p.id = $1`, [created.id]);
      return view(row);
    } catch (error) {
      // 驗證失敗時把已落地的檔案清掉，不留孤兒
      for (const file of uploads) await removeFile(file.id).catch(() => {});
      throw error;
    }
  });

  // 修改名稱、分類（含在一般分類與客戶圖庫之間搬移）
  app.put('/api/admin/patterns/:id', async (request) => {
    const current = await one('select * from patterns where id = $1', [request.params.id]);
    if (!current) throw notFound('印花不存在');

    const body = request.body ?? {};
    const kind = requireOneOf(body.kind ?? current.kind, '類型', ['general', 'customer']);
    const name = requireText(body.name, '名稱', 255);

    let categoryId = null;
    let customerId = null;
    if (kind === 'general') {
      categoryId = requireInt(body.categoryId, '分類');
      if (!(await one('select id from pattern_categories where id = $1', [categoryId]))) {
        throw badRequest('分類不存在');
      }
    } else {
      customerId = requireInt(body.customerId, '指定客戶');
      if (!(await one('select id from customers where id = $1', [customerId]))) {
        throw badRequest('客戶不存在');
      }
    }

    const width = requireNumber(body.physicalWidthCm, '圖案實際寬度', { required: false, min: 0.001 });
    const height = requireNumber(body.physicalHeightCm, '圖案實際高度', { required: false, min: 0.001 });

    await query(
      `update patterns
          set kind = $2, category_id = $3, customer_id = $4, name = $5,
              physical_width_cm = $6, physical_height_cm = $7, updated_at = now()
        where id = $1`,
      [current.id, kind, categoryId, customerId, name, width, height],
    );
    return view(await one(`${SELECT} where p.id = $1`, [current.id]));
  });

  async function deletePattern(id) {
    const current = await one('select * from patterns where id = $1', [id]);
    if (!current) throw notFound('印花不存在');
    await query('delete from patterns where id = $1', [current.id]);
    await removeFile(current.file_id).catch(() => {});
  }

  app.delete('/api/admin/patterns/:id', async (request, reply) => {
    await deletePattern(Number(request.params.id));
    reply.code(204);
  });

  registerBatchDelete(app, '/api/admin/patterns', deletePattern);
}
