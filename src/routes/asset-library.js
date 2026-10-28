// 規格書 6-(7) 背景管理 與 6-(8) 3D 模型管理。
//
// 兩者的欄位大致相同（編碼 + 名稱 + 檔案 + 適用對象），因此共用同一份實作，
// 以參數區分差異：
//   ・背景   只收 .hdr（three.js 的環境光貼圖格式），其餘格式擋下
//   ・3D 模型 另有公分尺寸（算貼圖重複次數用）
// 兩者都有啟用／停用（背景於 10/22 客戶要求加入）。
//
// 編碼「同公司不可重複、跨公司可重複」：A 公司與 B 公司可以各有一個叫「衣服」
// 的模型，檔案不同，所以名稱不設唯一，改以編碼識別。

import { many, one, tx } from '../db/index.js';
import { requireAdmin } from '../lib/auth.js';
import { registerBatchDelete } from '../lib/batch-delete.js';
import { badRequest, notFound } from '../lib/errors.js';
import { removeFile, saveUpload } from '../lib/files.js';
import {
  ENTITY, assertCustomersExist, assertScopedCodeUnique,
  attachScope, clearScope, parseScope, writeScope,
} from '../lib/scope.js';
import { pageResult, parsePaging, requireBool, requireNumber, requireText } from '../lib/validate.js';

const extensionOf = (filename) => {
  const dot = String(filename ?? '').lastIndexOf('.');
  return dot > 0 ? filename.slice(dot).toLowerCase() : '';
};

/**
 * @param table       資料表名稱 backgrounds | models_3d
 * @param entityType  scope_customers 用的 entity_type
 * @param folder      storage 子目錄
 * @param label       錯誤訊息用的中文名稱
 * @param extensions  允許的副檔名清單，null 代表不限
 * @param hasSize     是否有公分尺寸欄位
 * @param hasActive   是否有啟用／停用
 */
function createAssetRoutes({
  table, entityType, folder, label, basePath,
  extensions = null, hasSize = false, hasActive = false,
}) {
  const SELECT = `select a.*, f.storage_key, f.original_name, f.mime_type, f.byte_size
                    from ${table} a join files f on f.id = a.file_id`;

  const view = (row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    file: {
      id: row.file_id,
      url: `/api/files/${row.storage_key}`,
      name: row.original_name,
      mimeType: row.mime_type,
      byteSize: Number(row.byte_size),
    },
    ...(hasSize ? {
      sizeWidthCm: row.size_width_cm === null ? null : Number(row.size_width_cm),
      sizeHeightCm: row.size_height_cm === null ? null : Number(row.size_height_cm),
    } : {}),
    ...(hasActive ? { isActive: row.is_active } : {}),
    scopeType: row.scope_type,
    customers: row.customers ?? [],
    createdAt: row.created_at,
  });

  /** 尺寸可留白（舊資料沒有），有填就必須是正數，單位公分、可含小數。 */
  function readSize(body) {
    if (!hasSize) return {};
    return {
      sizeWidthCm: requireNumber(body?.sizeWidthCm, '寬度 (cm)', {
        min: 0.001, max: 99999, required: false, decimals: 3,
      }),
      sizeHeightCm: requireNumber(body?.sizeHeightCm, '高度 (cm)', {
        min: 0.001, max: 99999, required: false, decimals: 3,
      }),
    };
  }

  function assertExtension(filename) {
    if (!extensions) return;
    const ext = extensionOf(filename);
    if (!extensions.includes(ext)) {
      throw badRequest(`${label}只接受 ${extensions.join('、')} 格式${ext ? `，收到的是 ${ext}` : ''}`);
    }
  }

  return async function assetRoutes(app) {
    app.addHook('preHandler', requireAdmin);

    // 畫面篩選：搜尋編碼或名稱 + 全部適用對象
    app.get(basePath, async (request) => {
      const paging = parsePaging(request.query, { defaultSize: 20 });
      const conditions = [];
      const params = [];

      if (request.query?.keyword) {
        params.push(`%${String(request.query.keyword).trim()}%`);
        conditions.push(`(a.name ilike $${params.length} or a.code ilike $${params.length})`);
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
        `${SELECT} ${where} order by a.code limit $${params.length + 1} offset $${params.length + 2}`,
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
          // 副檔名先擋，避免把不該收的檔案寫進儲存層再回頭刪
          assertExtension(part.filename);
          upload = await saveUpload(part, folder);
        } else {
          fields[part.fieldname] = part.value;
        }
      }

      try {
        if (!upload) throw badRequest(`請選擇要上傳的${label}檔案`);
        const code = requireText(fields.code, '編碼', 50);
        const name = requireText(fields.name, '名稱', 50);
        const size = readSize(fields);
        const scope = parseScope({
          scopeType: fields.scopeType,
          customerIds: fields.customerIds ? JSON.parse(fields.customerIds) : [],
        });
        await assertCustomersExist(scope.customerIds);
        await assertScopedCodeUnique({
          table, entityType, code, scope, label: `${label}編碼`,
        });

        const columns = ['code', 'name', 'file_id', 'scope_type'];
        const values = [code, name, upload.id, scope.scopeType];
        if (hasSize) {
          columns.push('size_width_cm', 'size_height_cm');
          values.push(size.sizeWidthCm ?? null, size.sizeHeightCm ?? null);
        }
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

        const created = await tx(async (dbx) => {
          const row = await dbx.query(
            `insert into ${table} (${columns.join(', ')}) values (${placeholders}) returning *`,
            values,
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

    // 調整名稱、尺寸或適用對象不該逼使用者重傳檔案，所以更新端點不收檔案。
    // 編碼建立後不可變更。
    app.put(`${basePath}/:id`, async (request) => {
      const current = await one(`select * from ${table} where id = $1`, [request.params.id]);
      if (!current) throw notFound(`${label}不存在`);

      const name = requireText(request.body?.name, '名稱', 50);
      const size = readSize(request.body);
      const scope = parseScope(request.body);
      await assertCustomersExist(scope.customerIds);
      // 適用對象改了，編碼的可見範圍跟著變，要重新確認沒有撞號
      await assertScopedCodeUnique({
        table, entityType, code: current.code, scope, excludeId: current.id, label: `${label}編碼`,
      });

      await tx(async (dbx) => {
        const sets = ['name = $2', 'scope_type = $3'];
        const values = [current.id, name, scope.scopeType];
        if (hasSize) {
          sets.push(`size_width_cm = $${values.length + 1}`);
          values.push(size.sizeWidthCm ?? null);
          sets.push(`size_height_cm = $${values.length + 1}`);
          values.push(size.sizeHeightCm ?? null);
        }
        await dbx.query(
          `update ${table} set ${sets.join(', ')}, updated_at = now() where id = $1`,
          values,
        );
        await writeScope(dbx, entityType, current.id, scope);
      });

      const row = await one(`${SELECT} where a.id = $1`, [current.id]);
      await attachScope(entityType, [row]);
      return view(row);
    });

    // 啟用／停用。停用的項目不會出現在前台的選單，後台清單仍看得到。
    if (hasActive) {
      app.put(`${basePath}/:id/active`, async (request) => {
        const current = await one(`select id from ${table} where id = $1`, [request.params.id]);
        if (!current) throw notFound(`${label}不存在`);
        const isActive = requireBool(request.body?.isActive, '啟用狀態');
        await one(
          `update ${table} set is_active = $2, updated_at = now() where id = $1 returning id`,
          [current.id, isActive],
        );
        const row = await one(`${SELECT} where a.id = $1`, [current.id]);
        await attachScope(entityType, [row]);
        return view(row);
      });
    }

    async function deleteAsset(id) {
      const current = await one(`select * from ${table} where id = $1`, [id]);
      if (!current) throw notFound(`${label}不存在`);
      await tx(async (dbx) => {
        await clearScope(dbx, entityType, current.id);
        await dbx.query(`delete from ${table} where id = $1`, [current.id]);
      });
      await removeFile(current.file_id).catch(() => {});
    }

    app.delete(`${basePath}/:id`, async (request, reply) => {
      await deleteAsset(Number(request.params.id));
      reply.code(204);
    });

    registerBatchDelete(app, basePath, deleteAsset);
  };
}

export const backgroundRoutes = createAssetRoutes({
  table: 'backgrounds',
  entityType: ENTITY.background,
  folder: 'backgrounds',
  label: '背景',
  basePath: '/api/admin/backgrounds',
  // 背景是 three.js 的 HDR 環境光貼圖，其他格式載不起來
  extensions: ['.hdr'],
  hasActive: true,
});

export const model3dRoutes = createAssetRoutes({
  table: 'models_3d',
  entityType: ENTITY.model3d,
  folder: 'models-3d',
  label: '3D 模型',
  basePath: '/api/admin/models-3d',
  hasSize: true,
  hasActive: true,
});
