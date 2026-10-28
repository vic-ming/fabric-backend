// 前台取用端點。
//
// 前台目前仍以 src/data/*.js 靜態檔運作；這組端點即為後續改接的來源。
// 所有回傳都已依登入者所屬客戶過濾過（全域 + 該客戶專屬），
// 前端不需要、也不應該自己再做一次適用對象判斷。

import { many } from '../db/index.js';
import { authenticate } from '../lib/auth.js';
import { ENTITY } from '../lib/scope.js';
import { basename, parseU3m } from '../lib/u3m.js';
import { storage } from '../storage/index.js';
import { resolveRangeFor } from './spec-ranges.js';

// OP 含量後台沒有設定畫面，沿用資料內容.xlsx 的輸入限制。
const OP_RANGE = { opMin: 0, opMax: 60, opUnit: '%' };

// u3m 材質通道 → 前台 3D 預覽使用的名稱
const U3M_CHANNELS = {
  basecolor: 'base', normal: 'nrm', roughness: 'rough', displacement: 'disp', metalness: 'mtl', alpha: 'alpha',
};

// storage_key 每次上傳都不同，同一個 key 的內容不會變，解析結果可以一直留著。
const u3mCache = new Map();

function readU3m(storageKey) {
  if (!u3mCache.has(storageKey)) {
    u3mCache.set(storageKey, (async () => {
      const chunks = [];
      for await (const chunk of await storage().stream(storageKey)) chunks.push(chunk);
      return parseU3m(Buffer.concat(chunks));
    })().catch(() => null));
  }
  return u3mCache.get(storageKey);
}

/**
 * 從組織資料檔裡找出 .u3m，依它引用的貼圖路徑對應到實際上傳的檔案，
 * 前台才知道哪張是 BASE、哪張是法線。沒有 .u3m 或解析失敗回 null。
 */
async function u3mView(files) {
  const u3mFile = files.find((f) => /\.u3m$/i.test(f.original_name ?? ''));
  if (!u3mFile) return null;
  const parsed = await readU3m(u3mFile.storage_key);
  if (!parsed) return null;

  const byName = new Map(files.map((f) => [basename(f.original_name), f]));
  const textures = {};
  for (const { channel, path } of parsed.textures) {
    const file = byName.get(basename(path));
    if (U3M_CHANNELS[channel] && file) textures[U3M_CHANNELS[channel]] = `/api/files/${file.storage_key}`;
  }
  // 打包下載時，貼圖要放回 .u3m 記錄的相對路徑，3D 軟體才找得到
  const texturePaths = new Map(parsed.textures.map((t) => [basename(t.path), t.path]));
  return {
    url: `/api/files/${u3mFile.storage_key}`,
    designWidthCm: parsed.designWidthCm,
    designHeightCm: parsed.designHeightCm,
    textures,
    packageEntries: files.map((f) => ({
      url: `/api/files/${f.storage_key}`,
      path: texturePaths.get(basename(f.original_name)) ?? f.original_name,
    })),
  };
}

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
      many(`select id, code, name from fabric_types ft
             where ${visible(ENTITY.fabricType, 'ft', cid, p)}
             order by sort_order, code`, params),
      many(`select w.id, w.code, w.name, w.fabric_type_id from weaves w
             where ${visible(ENTITY.weave, 'w', cid, p)}
             order by sort_order, code`, params),
      many(`select id, code, name_en, name_zh, category from compositions c
             where ${visible(ENTITY.composition, 'c', cid, p)}
             order by sort_order, code`, params),
      many(`select id, code, name from elasticities e
             where ${visible(ENTITY.elasticity, 'e', cid, p)}
             order by sort_order, code`, params),
      resolveRangeFor(cid),
    ]);

    return {
      fabricTypes,
      // 前台「布樣種類會影響可選組織清單」：先分好組，前端直接依 key 取用
      weaves: weaves.map((w) => ({ id: w.id, code: w.code, name: w.name, fabricTypeId: w.fabric_type_id })),
      weavesByFabricType: weaves.reduce((acc, w) => {
        (acc[w.fabric_type_id] ??= []).push({ id: w.id, code: w.code, name: w.name });
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
        ...OP_RANGE,
      },
    };
  });

  /** 組織規格（含預覽圖與 3D 建模檔），前台選組織時預覽樣式用。 */
  app.get('/api/weave-specs', async (request) => {
    const cid = request.user.customerId;
    const params = cid === null ? [] : [cid];
    const p = cid === null ? 0 : 1;

    const rows = await many(
      `select ws.*, ft.code as fabric_type_code, ft.name as fabric_type_name,
              w.code as weave_code, w.name as weave_name,
              pf.storage_key as preview_key
         from weave_specs ws
         join fabric_types ft on ft.id = ws.fabric_type_id
         join weaves w on w.id = ws.weave_id
         join files pf on pf.id = ws.preview_file_id
        where ws.is_active and ${visible(ENTITY.weaveSpec, 'ws', cid, p)}
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

    const toNumber = (value) => (value === null ? null : Number(value));
    return Promise.all(rows.map(async (row) => {
      const u3m = await u3mView(fileByspec[row.id] ?? []);
      return {
        id: row.id,
        code: row.code,
        fabricTypeId: row.fabric_type_id,
        fabricTypeCode: row.fabric_type_code,
        fabricTypeName: row.fabric_type_name,
        weaveId: row.weave_id,
        weaveCode: row.weave_code,
        weaveName: row.weave_name,
        weight: Number(row.weight),
        thickness: Number(row.thickness),
        density: row.density,
        warpDensity: row.warp_density,
        weftDensity: row.weft_density,
        finishing: row.finishing,
        // 組織在真實世界的尺寸，3D 貼圖重複次數 = 模型公分 ÷ 這個值。
        // 舊版後台編輯時會把尺寸清成 null，這種資料退回 .u3m 記錄的尺寸。
        designWidthCm: toNumber(row.design_width_cm) ?? u3m?.designWidthCm ?? null,
        designHeightCm: toNumber(row.design_height_cm) ?? u3m?.designHeightCm ?? null,
        previewUrl: `/api/files/${row.preview_key}`,
        compositions: (compByspec[row.id] ?? []).map((c) => ({
          code: c.code, nameZh: c.name_zh, percent: Number(c.percent),
        })),
        files: (fileByspec[row.id] ?? []).map((f) => ({
          id: f.id, url: `/api/files/${f.storage_key}`, name: f.original_name, mimeType: f.mime_type,
        })),
        u3m,
      };
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

  /**
   * @param hasSize   3D 模型帶公分尺寸，前台用它算貼圖重複次數
   * @param hasActive 停用的項目不出現在前台（後台仍看得到）
   */
  const assetList = (table, entityType, alias, { hasSize = false, hasActive = false } = {}) =>
    async (request) => {
      const cid = request.user.customerId;
      const params = cid === null ? [] : [cid];
      const p = cid === null ? 0 : 1;
      const sizeCols = hasSize ? `, ${alias}.size_width_cm, ${alias}.size_height_cm` : '';
      const activeFilter = hasActive ? `${alias}.is_active and ` : '';
      const rows = await many(
        `select ${alias}.id, ${alias}.code, ${alias}.name${sizeCols},
                f.storage_key, f.original_name, f.mime_type
           from ${table} ${alias} join files f on f.id = ${alias}.file_id
          where ${activeFilter}${visible(entityType, alias, cid, p)}
          order by ${alias}.code`,
        params,
      );
      return rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        url: `/api/files/${row.storage_key}`,
        fileName: row.original_name,
        mimeType: row.mime_type,
        ...(hasSize ? {
          sizeWidthCm: row.size_width_cm === null ? null : Number(row.size_width_cm),
          sizeHeightCm: row.size_height_cm === null ? null : Number(row.size_height_cm),
        } : {}),
      }));
    };

  app.get('/api/backgrounds', assetList('backgrounds', ENTITY.background, 'b', { hasActive: true }));
  app.get('/api/models-3d', assetList('models_3d', ENTITY.model3d, 'm', { hasSize: true, hasActive: true }));

  /**
   * 前台「素色」底圖的色號清單：全域色票 + 指定給此客戶的色票。
   * 不同系列會有相同色號，前台要以「系列＋色號」辨識，所以一併回傳 colorType。
   */
  app.get('/api/pantone', async (request) => {
    const cid = request.user.customerId;
    const params = cid === null ? [] : [cid];
    const p = cid === null ? 0 : 1;
    const rows = await many(
      `select pc.code, pc.name, pc.color_type, pc.hex from pantone_colors pc
        where ${visible(ENTITY.pantone, 'pc', cid, p)}
        order by pc.sort_order, pc.code`,
      params,
    );
    return rows.map((row) => ({ code: row.code, name: row.name, colorType: row.color_type, hex: row.hex }));
  });
}
