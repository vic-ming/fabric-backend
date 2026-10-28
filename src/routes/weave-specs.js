// 規格書 6-(6) 組織規格管理 / 圖表 24-25
// ※ 可新增、編輯及刪除組織規格資料。
// ※ 包括上傳組織預覽圖及組織模型的資料檔案。
// ※ 編號建立後不可修改；織物細項需先選織物，清單篩選為該布樣種類對應到的組織。
// ※ 成分合計須為 100%。
//
// 表單同時含檔案與欄位，故一律以 multipart/form-data 送出；
// 陣列型欄位（compositions / customerIds / keepFileIds）以 JSON 字串夾帶。

import { many, one, query, tx } from '../db/index.js';
import { requireAdmin } from '../lib/auth.js';
import { registerBatchDelete } from '../lib/batch-delete.js';
import { badRequest, notFound } from '../lib/errors.js';
import { IMAGE_MIME, removeFile, saveUpload } from '../lib/files.js';
import { missingTextures, parseU3m } from '../lib/u3m.js';
import {
  ENTITY, assertCustomersExist, assertScopedCodeUnique,
  attachScope, clearScope, parseScope, writeScope,
} from '../lib/scope.js';
import { pageResult, parsePaging, requireBool, requireInt, requireNumber, requireText } from '../lib/validate.js';

const SELECT = `select ws.*, ft.name as fabric_type_name, w.name as weave_name,
                       pf.storage_key as preview_key, pf.original_name as preview_name
                  from weave_specs ws
                  join fabric_types ft on ft.id = ws.fabric_type_id
                  join weaves w on w.id = ws.weave_id
                  join files pf on pf.id = ws.preview_file_id`;

function parseJsonField(value, label, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw badRequest(`${label}格式錯誤`);
  }
}

function readCompositions(raw) {
  const list = parseJsonField(raw, '成分', []);
  if (!Array.isArray(list) || list.length === 0) throw badRequest('請至少填寫一項成分');

  const seen = new Set();
  const items = list.map((item) => {
    const compositionId = requireInt(item?.compositionId, '成分項目');
    const percent = requireNumber(item?.percent, '成分比例', { min: 0.01, max: 100, decimals: 2 });
    if (seen.has(compositionId)) throw badRequest('同一項成分不可重複選擇');
    seen.add(compositionId);
    return { compositionId, percent };
  });

  const total = items.reduce((sum, item) => sum + item.percent, 0);
  // 浮點數誤差容忍到小數兩位
  if (Math.abs(total - 100) > 0.005) {
    throw badRequest(`成分比例合計須為 100%，目前為 ${total.toFixed(2)}%`);
  }
  return items;
}

/** 收齊 multipart 的欄位與檔案。preview 為單張圖，dataFiles 可多檔且不限格式。 */
async function collectMultipart(request) {
  if (!request.isMultipart()) throw badRequest('請以 multipart/form-data 送出');
  const fields = {};
  let preview = null;
  const dataFiles = [];

  for await (const part of request.parts()) {
    if (part.type !== 'file') {
      fields[part.fieldname] = part.value;
      continue;
    }
    if (part.fieldname === 'preview') {
      // 規格書：組織預覽圖 接受 JPG,PNG,GIF
      preview = await saveUpload(part, 'weave-specs/preview', IMAGE_MIME);
    } else {
      // 規格書：組織資料 上傳任意檔案，不限制檔案數量和格式。
      // .u3m 要留下內容供解析（串流只能讀一次，事後讀不到）
      const isU3m = /\.u3m$/i.test(part.filename ?? '');
      dataFiles.push(await saveUpload(part, 'weave-specs/data', null, { keepBuffer: isU3m }));
    }
  }
  return { fields, preview, dataFiles };
}

/**
 * 上傳的組織資料若含 .u3m，就解析它：
 *   ・比對引用到的六張貼圖有沒有一起上傳，缺了就擋下並列出檔名
 *   ・使用者沒填設計尺寸時，自動帶入 .u3m 記錄的實際尺寸
 *
 * @param alsoHaveNames 編輯時保留下來的舊檔名，一併算進「已經有的檔案」
 */
function applyU3m(dataFiles, size, alsoHaveNames = []) {
  const u3mFile = dataFiles.find((f) => f.buffer && /\.u3m$/i.test(f.original_name ?? ''));
  if (!u3mFile) return size;

  const parsed = parseU3m(u3mFile.buffer);
  if (!parsed) throw badRequest(`${u3mFile.original_name} 不是有效的 .u3m（內容無法解析）`);

  const have = [...dataFiles.map((f) => f.original_name), ...alsoHaveNames];
  const missing = missingTextures(parsed, have);
  if (missing.length > 0) {
    throw badRequest(
      `${u3mFile.original_name} 需要搭配 ${parsed.textures.length} 張貼圖，`
      + `還缺 ${missing.length} 張：${missing.map((p) => p.split('/').pop()).join('、')}`,
    );
  }

  // 使用者沒填就用 .u3m 裡的實際尺寸；填了就尊重使用者的值
  return {
    designWidthCm: size.designWidthCm ?? parsed.designWidthCm,
    designHeightCm: size.designHeightCm ?? parsed.designHeightCm,
  };
}

async function loadOne(id) {
  const row = await one(`${SELECT} where ws.id = $1`, [id]);
  if (!row) throw notFound('組織規格不存在');
  await attachScope(ENTITY.weaveSpec, [row]);

  const compositions = await many(
    `select wsc.composition_id, wsc.percent, c.code, c.name_zh, c.name_en
       from weave_spec_compositions wsc
       join compositions c on c.id = wsc.composition_id
      where wsc.weave_spec_id = $1
      order by wsc.percent desc, c.code`,
    [id],
  );
  const files = await many(
    `select f.id, f.storage_key, f.original_name, f.mime_type, f.byte_size
       from weave_spec_files wsf
       join files f on f.id = wsf.file_id
      where wsf.weave_spec_id = $1
      order by wsf.sort_order, f.id`,
    [id],
  );

  return {
    id: row.id,
    code: row.code,
    fabricTypeId: row.fabric_type_id,
    fabricTypeName: row.fabric_type_name,
    weaveId: row.weave_id,
    weaveName: row.weave_name,
    weight: Number(row.weight),
    thickness: Number(row.thickness),
    density: row.density,
    designWidthCm: row.design_width_cm === null ? null : Number(row.design_width_cm),
    designHeightCm: row.design_height_cm === null ? null : Number(row.design_height_cm),
    finishing: row.finishing,
    isActive: row.is_active,
    preview: { id: row.preview_file_id, url: `/api/files/${row.preview_key}`, name: row.preview_name },
    files: files.map((f) => ({
      id: f.id, url: `/api/files/${f.storage_key}`, name: f.original_name,
      mimeType: f.mime_type, byteSize: Number(f.byte_size),
    })),
    compositions: compositions.map((c) => ({
      compositionId: c.composition_id, code: c.code,
      nameZh: c.name_zh, nameEn: c.name_en, percent: Number(c.percent),
    })),
    scopeType: row.scope_type,
    customers: row.customers ?? [],
  };
}

export default async function weaveSpecRoutes(app) {
  app.addHook('preHandler', requireAdmin);

  app.get('/api/admin/weave-specs', async (request) => {
    const paging = parsePaging(request.query, { defaultSize: 20 });
    const conditions = [];
    const params = [];
    if (request.query?.keyword) {
      params.push(`%${String(request.query.keyword).trim()}%`);
      conditions.push(`ws.code ilike $${params.length}`);
    }
    if (request.query?.fabricTypeId) {
      params.push(Number(request.query.fabricTypeId));
      conditions.push(`ws.fabric_type_id = $${params.length}`);
    }
    const where = conditions.length ? `where ${conditions.join(' and ')}` : '';

    const rows = await many(
      `${SELECT} ${where} order by ws.code limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, paging.size, paging.offset],
    );
    await attachScope(ENTITY.weaveSpec, rows);
    const { count } = await one(`select count(*)::int as count from weave_specs ws ${where}`, params);

    return pageResult(rows.map((row) => ({
      id: row.id,
      code: row.code,
      fabricTypeName: row.fabric_type_name,
      weaveName: row.weave_name,
      weight: Number(row.weight),
      thickness: Number(row.thickness),
      isActive: row.is_active,
      preview: { url: `/api/files/${row.preview_key}`, name: row.preview_name },
      scopeType: row.scope_type,
      customers: row.customers ?? [],
    })), count, paging);
  });

  app.get('/api/admin/weave-specs/:id', async (request) => loadOne(Number(request.params.id)));

  app.post('/api/admin/weave-specs', async (request, reply) => {
    const { fields, preview, dataFiles } = await collectMultipart(request);
    const uploaded = [preview, ...dataFiles].filter(Boolean);

    try {
      const code = requireText(fields.code, '編號', 50);
      const fabricTypeId = requireInt(fields.fabricTypeId, '織物');
      const weaveId = requireInt(fields.weaveId, '織物細項');
      const weight = requireNumber(fields.weight, '布重', { min: 0, max: 999.99, decimals: 2 });
      const thickness = requireNumber(fields.thickness, '布厚', { min: 0, max: 999.99, decimals: 2 });
      const density = requireText(fields.density, '經緯密度', 100, { required: false });
      const finishing = requireText(fields.finishing, '後整理', 100, { required: false });
      // 組織在真實世界的尺寸，前台用它算貼圖在模型上的重複次數
      const designWidthCm = requireNumber(fields.designWidthCm, '組織寬度 (cm)', {
        min: 0.001, max: 99999, required: false, decimals: 3,
      });
      const designHeightCm = requireNumber(fields.designHeightCm, '組織高度 (cm)', {
        min: 0.001, max: 99999, required: false, decimals: 3,
      });
      const compositions = readCompositions(fields.compositions);
      const scope = parseScope({
        scopeType: fields.scopeType,
        customerIds: parseJsonField(fields.customerIds, '適用客戶', []),
      });

      if (!preview) throw badRequest('組織預覽圖為必填');
      if (dataFiles.length === 0) throw badRequest('組織資料為必填，請至少上傳一個檔案');
      const size = applyU3m(dataFiles, { designWidthCm, designHeightCm });
      await assertScopedCodeUnique({
        table: 'weave_specs', entityType: ENTITY.weaveSpec, code, scope, label: '組織規格編號',
      });
      await assertWeaveBelongs(fabricTypeId, weaveId);
      await assertCompositionsExist(compositions);
      await assertCustomersExist(scope.customerIds);

      const created = await tx(async (dbx) => {
        const row = await dbx.query(
          `insert into weave_specs (code, fabric_type_id, weave_id, weight, thickness,
                                    density, finishing, design_width_cm, design_height_cm,
                                    preview_file_id, scope_type)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
          [code, fabricTypeId, weaveId, weight, thickness, density, finishing,
           size.designWidthCm, size.designHeightCm, preview.id, scope.scopeType],
        ).then((r) => r.rows[0]);
        await writeCompositions(dbx, row.id, compositions);
        await writeDataFiles(dbx, row.id, dataFiles.map((f) => f.id));
        await writeScope(dbx, ENTITY.weaveSpec, row.id, scope);
        return row;
      });

      reply.code(201);
      return loadOne(created.id);
    } catch (error) {
      for (const file of uploaded) await removeFile(file.id).catch(() => {});
      throw error;
    }
  });

  app.put('/api/admin/weave-specs/:id', async (request) => {
    const current = await one('select * from weave_specs where id = $1', [request.params.id]);
    if (!current) throw notFound('組織規格不存在');

    const { fields, preview, dataFiles } = await collectMultipart(request);
    const uploaded = [preview, ...dataFiles].filter(Boolean);

    try {
      const fabricTypeId = requireInt(fields.fabricTypeId, '織物');
      const weaveId = requireInt(fields.weaveId, '織物細項');
      const weight = requireNumber(fields.weight, '布重', { min: 0, max: 999.99, decimals: 2 });
      const thickness = requireNumber(fields.thickness, '布厚', { min: 0, max: 999.99, decimals: 2 });
      const density = requireText(fields.density, '經緯密度', 100, { required: false });
      const finishing = requireText(fields.finishing, '後整理', 100, { required: false });
      // 組織在真實世界的尺寸，前台用它算貼圖在模型上的重複次數
      const designWidthCm = requireNumber(fields.designWidthCm, '組織寬度 (cm)', {
        min: 0.001, max: 99999, required: false, decimals: 3,
      });
      const designHeightCm = requireNumber(fields.designHeightCm, '組織高度 (cm)', {
        min: 0.001, max: 99999, required: false, decimals: 3,
      });
      const compositions = readCompositions(fields.compositions);
      const scope = parseScope({
        scopeType: fields.scopeType,
        customerIds: parseJsonField(fields.customerIds, '適用客戶', []),
      });
      // 前端送回要保留的既有檔案 id；未列入者視為刪除
      const keepFileIds = parseJsonField(fields.keepFileIds, '保留檔案', null);

      await assertWeaveBelongs(fabricTypeId, weaveId);
      await assertCompositionsExist(compositions);
      await assertCustomersExist(scope.customerIds);
      // 適用對象改了，編號的可見範圍跟著變，要重新確認沒有撞號
      await assertScopedCodeUnique({
        table: 'weave_specs', entityType: ENTITY.weaveSpec, code: current.code,
        scope, excludeId: current.id, label: '組織規格編號',
      });

      const existingFiles = await many(
        'select file_id from weave_spec_files where weave_spec_id = $1', [current.id],
      ).then((rows) => rows.map((r) => r.file_id));
      const kept = keepFileIds === null
        ? existingFiles
        : existingFiles.filter((id) => keepFileIds.map(Number).includes(id));
      const keptNames = kept.length === 0 ? [] : await many(
        'select original_name from files where id = any($1::int[])', [kept],
      ).then((rows) => rows.map((r) => r.original_name));
      const size = applyU3m(dataFiles, { designWidthCm, designHeightCm }, keptNames);

      if (kept.length + dataFiles.length === 0) {
        throw badRequest('組織資料為必填，請至少保留或上傳一個檔案');
      }

      const removedPreview = preview ? current.preview_file_id : null;
      const removedFiles = existingFiles.filter((id) => !kept.includes(id));

      // 編號建立後不可修改，此處刻意不讀 fields.code
      await tx(async (dbx) => {
        await dbx.query(
          `update weave_specs
              set fabric_type_id = $2, weave_id = $3, weight = $4, thickness = $5,
                  density = $6, finishing = $7, design_width_cm = $8, design_height_cm = $9,
                  preview_file_id = $10, scope_type = $11, updated_at = now()
            where id = $1`,
          [current.id, fabricTypeId, weaveId, weight, thickness, density, finishing,
           size.designWidthCm, size.designHeightCm,
           preview ? preview.id : current.preview_file_id, scope.scopeType],
        );
        await dbx.query('delete from weave_spec_compositions where weave_spec_id = $1', [current.id]);
        await writeCompositions(dbx, current.id, compositions);
        await dbx.query('delete from weave_spec_files where weave_spec_id = $1', [current.id]);
        await writeDataFiles(dbx, current.id, [...kept, ...dataFiles.map((f) => f.id)]);
        await writeScope(dbx, ENTITY.weaveSpec, current.id, scope);
      });

      // 資料庫關聯解除後才刪實體檔案
      for (const id of removedFiles) await removeFile(id).catch(() => {});
      if (removedPreview) await removeFile(removedPreview).catch(() => {});

      return loadOne(current.id);
    } catch (error) {
      for (const file of uploaded) await removeFile(file.id).catch(() => {});
      throw error;
    }
  });

  // 啟用／停用（10/22 客戶要求）。停用的組織規格不出現在前台，後台清單仍看得到。
  app.put('/api/admin/weave-specs/:id/active', async (request) => {
    const current = await one('select id from weave_specs where id = $1', [request.params.id]);
    if (!current) throw notFound('組織規格不存在');
    const isActive = requireBool(request.body?.isActive, '啟用狀態');
    await query(
      'update weave_specs set is_active = $2, updated_at = now() where id = $1',
      [current.id, isActive],
    );
    return loadOne(current.id);
  });

  async function deleteWeaveSpec(id) {
    const current = await one('select * from weave_specs where id = $1', [id]);
    if (!current) throw notFound('組織規格不存在');

    const fileIds = await many(
      'select file_id from weave_spec_files where weave_spec_id = $1', [current.id],
    ).then((rows) => rows.map((r) => r.file_id));

    await tx(async (dbx) => {
      await clearScope(dbx, ENTITY.weaveSpec, current.id);
      await dbx.query('delete from weave_specs where id = $1', [current.id]);
    });
    for (const fileId of fileIds) await removeFile(fileId).catch(() => {});
    await removeFile(current.preview_file_id).catch(() => {});
  }

  app.delete('/api/admin/weave-specs/:id', async (request, reply) => {
    await deleteWeaveSpec(Number(request.params.id));
    reply.code(204);
  });

  registerBatchDelete(app, '/api/admin/weave-specs', deleteWeaveSpec);
}

async function assertWeaveBelongs(fabricTypeId, weaveId) {
  const weave = await one('select * from weaves where id = $1', [weaveId]);
  if (!weave) throw badRequest('織物細項不存在');
  if (weave.fabric_type_id !== fabricTypeId) {
    throw badRequest('織物細項不屬於所選的織物，請重新選擇');
  }
}

async function assertCompositionsExist(items) {
  const ids = items.map((item) => item.compositionId);
  const rows = await many('select id from compositions where id = any($1::int[])', [ids]);
  if (rows.length !== ids.length) throw badRequest('成分項目不存在');
}

async function writeCompositions(dbx, weaveSpecId, items) {
  for (const item of items) {
    await dbx.query(
      'insert into weave_spec_compositions (weave_spec_id, composition_id, percent) values ($1, $2, $3)',
      [weaveSpecId, item.compositionId, item.percent],
    );
  }
}

async function writeDataFiles(dbx, weaveSpecId, fileIds) {
  for (const [index, fileId] of fileIds.entries()) {
    await dbx.query(
      'insert into weave_spec_files (weave_spec_id, file_id, sort_order) values ($1, $2, $3)',
      [weaveSpecId, fileId, index],
    );
  }
}
