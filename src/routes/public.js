// 前台取用端點。
//
// 前台目前仍以 src/data/*.js 靜態檔運作；這組端點即為後續改接的來源。
// 所有回傳都已依登入者所屬客戶過濾過（全域 + 該客戶專屬），
// 前端不需要、也不應該自己再做一次適用對象判斷。

import { many, one } from '../db/index.js';
import { authenticate } from '../lib/auth.js';
import { ENTITY } from '../lib/scope.js';
import { resolveRangeFor } from './spec-ranges.js';

/** 產生「全域 或 屬於此客戶」的可見性條件。管理者（customerId 為 null）看全部。 */
function visible(entityType, alias, customerId, paramIndex) {
  if (customerId === null || customerId === undefined) return 'true';
  return `(${alias}.scope_type = 'global' or exists (
             select 1 from scope_customers sc
              where sc.entity_type = '${entityType}'
                and sc.entity_id = ${alias}.id
                and sc.customer_id = $${paramIndex}))`;
}

export default async function publicRoutes(app) {
  app.addHook('preHandler', authenticate);

  /** 織物生成功能所需的全部下拉選項，一次取回，減少前端串接次數。 */
  app.get('/api/options', async (request) => {
    const cid = request.user.customerId;
    const params = cid === null ? [] : [cid];
    const p = cid === null ? 0 : 1;

    const [fabricTypes, weaves, compositions, elasticities, specRange] = await Promise.all([
      many(`select id, name from fabric_types ft
             where ${visible(ENTITY.fabricType, 'ft', cid, p)}
             order by sort_order, name`, params),
      many(`select w.id, w.name, w.fabric_type_id from weaves w
             where ${visible(ENTITY.weave, 'w', cid, p)}
             order by sort_order, name`, params),
      many(`select id, code, name_en, name_zh, category from compositions c
             where ${visible(ENTITY.composition, 'c', cid, p)}
             order by sort_order, code`, params),
      many(`select id, name from elasticities e
             where ${visible(ENTITY.elasticity, 'e', cid, p)}
             order by sort_order, id`, params),
      resolveRangeFor(cid),
    ]);

    return {
      fabricTypes,
      // 前台「布樣種類會影響可選組織清單」：先分好組，前端直接依 key 取用
      weaves: weaves.map((w) => ({ id: w.id, name: w.name, fabricTypeId: w.fabric_type_id })),
      weavesByFabricType: weaves.reduce((acc, w) => {
        (acc[w.fabric_type_id] ??= []).push({ id: w.id, name: w.name });
        return acc;
      }, {}),
      compositions: compositions.map((c) => ({
        id: c.id, code: c.code, nameEn: c.name_en, nameZh: c.name_zh, category: c.category,
      })),
      elasticities,
      specRange: {
        weightMin: specRange.weightMin, weightMax: specRange.weightMax, weightUnit: specRange.weightUnit,
        thicknessMin: specRange.thicknessMin, thicknessMax: specRange.thicknessMax,
        thicknessUnit: specRange.thicknessUnit,
      },
    };
  });

  /** 組織規格（含預覽圖與 3D 建模檔），前台選組織時預覽樣式用。 */
  app.get('/api/weave-specs', async (request) => {
    const cid = request.user.customerId;
    const params = cid === null ? [] : [cid];
    const p = cid === null ? 0 : 1;

    const rows = await many(
      `select ws.*, ft.name as fabric_type_name, w.name as weave_name,
              pf.storage_key as preview_key
         from weave_specs ws
         join fabric_types ft on ft.id = ws.fabric_type_id
         join weaves w on w.id = ws.weave_id
         join files pf on pf.id = ws.preview_file_id
        where ${visible(ENTITY.weaveSpec, 'ws', cid, p)}
        order by ws.code`,
      params,
    );
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const [compositions, files] = await Promise.all([
      many(`select wsc.weave_spec_id, wsc.percent, c.code, c.name_zh
              from weave_spec_compositions wsc
              join compositions c on c.id = wsc.composition_id
             where wsc.weave_spec_id = any($1::int[])
             order by wsc.percent desc`, [ids]),
      many(`select wsf.weave_spec_id, f.id, f.storage_key, f.original_name, f.mime_type
              from weave_spec_files wsf
              join files f on f.id = wsf.file_id
             where wsf.weave_spec_id = any($1::int[])
             order by wsf.sort_order`, [ids]),
    ]);

    const group = (list) => list.reduce((acc, item) => {
      (acc[item.weave_spec_id] ??= []).push(item);
      return acc;
    }, {});
    const compByspec = group(compositions);
    const fileByspec = group(files);

    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      fabricTypeId: row.fabric_type_id,
      fabricTypeName: row.fabric_type_name,
      weaveId: row.weave_id,
      weaveName: row.weave_name,
      weight: Number(row.weight),
      thickness: Number(row.thickness),
      density: row.density,
      finishing: row.finishing,
      previewUrl: `/api/files/${row.preview_key}`,
      compositions: (compByspec[row.id] ?? []).map((c) => ({
        code: c.code, nameZh: c.name_zh, percent: Number(c.percent),
      })),
      files: (fileByspec[row.id] ?? []).map((f) => ({
        id: f.id, url: `/api/files/${f.storage_key}`, name: f.original_name, mimeType: f.mime_type,
      })),
    }));
  });

  /** 系統預設印花：一般分類全部可見，客戶圖庫僅該客戶自己的。 */
  app.get('/api/patterns', async (request) => {
    const cid = request.user.customerId;
    const rows = cid === null
      ? await many(`select p.*, f.storage_key, pc.name as category_name
                      from patterns p join files f on f.id = p.file_id
                      left join pattern_categories pc on pc.id = p.category_id
                     order by p.created_at desc`)
      : await many(`select p.*, f.storage_key, pc.name as category_name
                      from patterns p join files f on f.id = p.file_id
                      left join pattern_categories pc on pc.id = p.category_id
                     where p.kind = 'general' or p.customer_id = $1
                     order by p.created_at desc`, [cid]);

    const categories = await many('select id, name from pattern_categories order by sort_order, id');
    return {
      categories,
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        categoryId: row.category_id,
        categoryName: row.category_name,
        name: row.name,
        url: `/api/files/${row.storage_key}`,
        // 3D 貼圖重複次數所需：實際公分尺寸
        physicalWidthCm: row.physical_width_cm === null ? null : Number(row.physical_width_cm),
        physicalHeightCm: row.physical_height_cm === null ? null : Number(row.physical_height_cm),
      })),
    };
  });

  const assetList = (table, entityType, alias) => async (request) => {
    const cid = request.user.customerId;
    const params = cid === null ? [] : [cid];
    const p = cid === null ? 0 : 1;
    const rows = await many(
      `select ${alias}.id, ${alias}.name, f.storage_key, f.original_name, f.mime_type
         from ${table} ${alias} join files f on f.id = ${alias}.file_id
        where ${visible(entityType, alias, cid, p)}
        order by ${alias}.name`,
      params,
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      url: `/api/files/${row.storage_key}`,
      fileName: row.original_name,
      mimeType: row.mime_type,
    }));
  };

  app.get('/api/backgrounds', assetList('backgrounds', ENTITY.background, 'b'));
  app.get('/api/models-3d', assetList('models_3d', ENTITY.model3d, 'm'));
}
