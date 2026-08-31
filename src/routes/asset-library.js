// 規格書 6-(7) 背景管理 與 6-(8) 3D 模型管理。
// 兩者欄位完全相同（檔案 + 不得重複的名稱 + 適用對象），
// 畫面也只差在標題與檔案類型，因此共用同一份實作，以參數區分。

import { many, one, query, tx } from '../db/index.js';
import { requireAdmin } from '../lib/auth.js';
import { conflict, notFound } from '../lib/errors.js';
import { removeFile, saveUpload } from '../lib/files.js';
import { ENTITY, assertCustomersExist, attachScope, clearScope, parseScope, writeScope } from '../lib/scope.js';
import { badRequest } from '../lib/errors.js';
import { pageResult, parsePaging, requireText } from '../lib/validate.js';

/**
 * @param table       資料表名稱 backgrounds | models_3d
 * @param entityType  scope_customers 用的 entity_type
 * @param folder      storage 子目錄
 * @param label       錯誤訊息用的中文名稱
 */
function createAssetRoutes({ table, entityType, folder, label, basePath }) {
  const SELECT = `select a.*, f.storage_key, f.original_name, f.mime_type, f.byte_size
                    from ${table} a join files f on f.id = a.file_id`;

  const view = (row) => ({
    id: row.id,
    name: row.name,
    file: {
      id: row.file_id,
      url: `/api/files/${row.storage_key}`,
      name: row.original_name,
      mimeType: row.mime_type,
      byteSize: Number(row.byte_size),
    },
    scopeType: row.scope_type,
    customers: row.customers ?? [],
    createdAt: row.created_at,
  });

  return async function assetRoutes(app) {
    app.addHook('preHandler', requireAdmin);

    // 畫面篩選：搜尋名稱 + 全部適用對象
    app.get(basePath, async (request) => {
      const paging = parsePaging(request.query, { defaultSize: 20 });
      const conditions = [];
      const params = [];

      if (request.query?.keyword) {
        params.push(`%${String(request.query.keyword).trim()}%`);
        conditions.push(`a.name ilike $${params.length}`);
      }
      if (request.query?.scopeType === 'global') {
        conditions.push(`a.scope_type = 'global'`);
      } else if (request.query?.customerId) {
        params.push(Number(request.query.customerId));
        conditions.push(`exists (select 1 from scope_customers sc
                                  where sc.entity_type = '${entityType}'
                                    and sc.entity_id = a.id
                                    and sc.customer_id = $${params.length})`);
      }
      const where = conditions.length ? `where ${conditions.join(' and ')}` : '';

      const rows = await many(
        `${SELECT} ${where} order by a.name limit $${params.length + 1} offset $${params.length + 2}`,
        [...params, paging.size, paging.offset],
      );
      await attachScope(entityType, rows);
      const { count } = await one(`select count(*)::int as count from ${table} a ${where}`, params);
      return pageResult(rows.map(view), count, paging);
    });

    app.post(basePath, async (request, reply) => {
      if (!request.isMultipart()) throw badRequest('請以 multipart/form-data 上傳');

      const fields = {};
      let upload = null;
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          // 3D 模型與背景檔格式眾多（obj / glb / fbx / hdr…），不限制 MIME
          upload = await saveUpload(part, folder);
        } else {
          fields[part.fieldname] = part.value;
        }
      }

      try {
        if (!upload) throw badRequest(`請選擇要上傳的${label}檔案`);
        const name = requireText(fields.name, '名稱', 50);
        const scope = parseScope({
          scopeType: fields.scopeType,
          customerIds: fields.customerIds ? JSON.parse(fields.customerIds) : [],
        });
        if (await one(`select id from ${table} where name = $1`, [name])) {
          throw conflict(`${label}名稱「${name}」已存在，不得重複`);
        }
        await assertCustomersExist(scope.customerIds);

        const created = await tx(async (dbx) => {
          const row = await dbx.query(
            `insert into ${table} (name, file_id, scope_type) values ($1, $2, $3) returning *`,
            [name, upload.id, scope.scopeType],
          ).then((r) => r.rows[0]);
          await writeScope(dbx, entityType, row.id, scope);
          return row;
        });

        reply.code(201);
        const row = await one(`${SELECT} where a.id = $1`, [created.id]);
        await attachScope(entityType, [row]);
        return view(row);
      } catch (error) {
        if (upload) await removeFile(upload.id).catch(() => {});
        throw error;
      }
    });

    // 規格書畫面只有上傳與刪除，但適用對象調整不該逼使用者重傳檔案，
    // 因此提供只改名稱／適用對象的更新端點。
    app.put(`${basePath}/:id`, async (request) => {
      const current = await one(`select * from ${table} where id = $1`, [request.params.id]);
      if (!current) throw notFound(`${label}不存在`);

      const name = requireText(request.body?.name, '名稱', 50);
      const scope = parseScope(request.body);
      const duplicate = await one(`select id from ${table} where name = $1 and id <> $2`, [name, current.id]);
      if (duplicate) throw conflict(`${label}名稱「${name}」已存在，不得重複`);
      await assertCustomersExist(scope.customerIds);

      await tx(async (dbx) => {
        await dbx.query(
          `update ${table} set name = $2, scope_type = $3, updated_at = now() where id = $1`,
          [current.id, name, scope.scopeType],
        );
        await writeScope(dbx, entityType, current.id, scope);
      });

      const row = await one(`${SELECT} where a.id = $1`, [current.id]);
      await attachScope(entityType, [row]);
      return view(row);
    });

    app.delete(`${basePath}/:id`, async (request, reply) => {
      const current = await one(`select * from ${table} where id = $1`, [request.params.id]);
      if (!current) throw notFound(`${label}不存在`);
      await tx(async (dbx) => {
        await clearScope(dbx, entityType, current.id);
        await dbx.query(`delete from ${table} where id = $1`, [current.id]);
      });
      await removeFile(current.file_id).catch(() => {});
      reply.code(204);
    });
  };
}

export const backgroundRoutes = createAssetRoutes({
  table: 'backgrounds',
  entityType: ENTITY.background,
  folder: 'backgrounds',
  label: '背景',
  basePath: '/api/admin/backgrounds',
});

export const model3dRoutes = createAssetRoutes({
  table: 'models_3d',
  entityType: ENTITY.model3d,
  folder: 'models-3d',
  label: '3D 模型',
  basePath: '/api/admin/models-3d',
});
