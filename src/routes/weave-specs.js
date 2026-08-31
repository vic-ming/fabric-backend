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
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { IMAGE_MIME, removeFile, saveUpload } from '../lib/files.js';
import { ENTITY, assertCustomersExist, attachScope, clearScope, parseScope, writeScope } from '../lib/scope.js';
import { pageResult, parsePaging, requireInt, requireNumber, requireText } from '../lib/validate.js';

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
      // 規格書：組織資料 上傳任意檔案，不限制檔案數量和格式
      dataFiles.push(await saveUpload(part, 'weave-specs/data'));
    }
  }
  return { fields, preview, dataFiles };
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
    finishing: row.finishing,
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
      const compositions = readCompositions(fields.compositions);
      const scope = parseScope({
        scopeType: fields.scopeType,
        customerIds: parseJsonField(fields.customerIds, '適用客戶', []),
      });

      if (!preview) throw badRequest('組織預覽圖為必填');
      if (dataFiles.length === 0) throw badRequest('組織資料為必填，請至少上傳一個檔案');
      if (await one('select id from weave_specs where code = $1', [code])) {
        throw conflict(`編號 ${code} 已存在，不得重複`);
      }
      await assertWeaveBelongs(fabricTypeId, weaveId);
      await assertCompositionsExist(compositions);
      await assertCustomersExist(scope.customerIds);

      const created = await tx(async (dbx) => {
        const row = await dbx.query(
          `insert into weave_specs (code, fabric_type_id, weave_id, weight, thickness,
                                    density, finishing, preview_file_id, scope_type)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
          [code, fabricTypeId, weaveId, weight, thickness, density, finishing, preview.id, scope.scopeType],
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

      const existingFiles = await many(
        'select file_id from weave_spec_files where weave_spec_id = $1', [current.id],
      ).then((rows) => rows.map((r) => r.file_id));
      const kept = keepFileIds === null
        ? existingFiles
        : existingFiles.filter((id) => keepFileIds.map(Number).includes(id));
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
                  density = $6, finishing = $7, preview_file_id = $8,
                  scope_type = $9, updated_at = now()
            where id = $1`,
          [current.id, fabricTypeId, weaveId, weight, thickness, density, finishing,
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

  app.delete('/api/admin/weave-specs/:id', async (request, reply) => {
    const current = await one('select * from weave_specs where id = $1', [request.params.id]);
    if (!current) throw notFound('組織規格不存在');

    const fileIds = await many(
      'select file_id from weave_spec_files where weave_spec_id = $1', [current.id],
    ).then((rows) => rows.map((r) => r.file_id));

    await tx(async (dbx) => {
      await clearScope(dbx, ENTITY.weaveSpec, current.id);
      await dbx.query('delete from weave_specs where id = $1', [current.id]);
    });
    for (const id of fileIds) await removeFile(id).catch(() => {});
    await removeFile(current.preview_file_id).catch(() => {});
    reply.code(204);
  });
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
