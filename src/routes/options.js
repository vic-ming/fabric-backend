// 規格書 6-(3) 選項參數管理 — 四個頁籤：布樣種類 / 組織 / 成分 / 彈性
//
// 四者共通：
//   ・適用對象：全域 或 指定客戶（至少一位）
// 布樣種類與組織改以「編號」為識別鍵：
//   ・編號建立後不可變更，且「同公司不可重複、跨公司可重複」
//     （不同公司會各自有同名的布樣種類／組織，見 scope.js 的 assertScopedCodeUnique）
//   ・名稱純顯示用，可重複、可修改
//   ・適用對象：全域 或 指定客戶（至少一位）
// 差異：
//   ・組織 多一個「對應布樣」，前台依此篩選可選組織清單
//   ・成分 以「編號」為識別鍵，另有英文/中文名稱與分類

import { many, one, query, tx } from '../db/index.js';
import { requireAdmin } from '../lib/auth.js';
import { registerBatchDelete } from '../lib/batch-delete.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { ENTITY, assertCustomersExist, assertScopedCodeUnique, attachScope, clearScope, parseScope, writeScope } from '../lib/scope.js';
import { requireInt, requireText } from '../lib/validate.js';

const scopeView = (row) => ({
  scopeType: row.scope_type,
  customers: row.customers ?? [],
});

async function assertUnique(table, column, value, label, excludeId = null) {
  const row = excludeId
    ? await one(`select id from ${table} where ${column} = $1 and id <> $2`, [value, excludeId])
    : await one(`select id from ${table} where ${column} = $1`, [value]);
  if (row) throw conflict(`${label} ${value} 已存在，不得重複`);
}

export default async function optionRoutes(app) {
  app.addHook('preHandler', requireAdmin);

  // ------------------------------------------------------------ 布樣種類

  app.get('/api/admin/fabric-types', async () => {
    const rows = await many('select * from fabric_types order by sort_order, code');
    await attachScope(ENTITY.fabricType, rows);
    return rows.map((row) => ({ id: row.id, code: row.code, name: row.name, ...scopeView(row) }));
  });

  app.post('/api/admin/fabric-types', async (request, reply) => {
    const code = requireText(request.body?.code, '編號', 50);
    const name = requireText(request.body?.name, '名稱', 50);
    const scope = parseScope(request.body);
    await assertCustomersExist(scope.customerIds);
    await assertScopedCodeUnique({
      table: 'fabric_types', entityType: ENTITY.fabricType, code, scope, label: '布樣種類編號',
    });

    const row = await tx(async (dbx) => {
      const created = await dbx.query(
        'insert into fabric_types (code, name, scope_type) values ($1, $2, $3) returning *',
        [code, name, scope.scopeType],
      ).then((r) => r.rows[0]);
      await writeScope(dbx, ENTITY.fabricType, created.id, scope);
      return created;
    });
    await attachScope(ENTITY.fabricType, [row]);
    reply.code(201);
    return { id: row.id, code: row.code, name: row.name, ...scopeView(row) };
  });

  app.put('/api/admin/fabric-types/:id', async (request) => {
    const current = await one('select * from fabric_types where id = $1', [request.params.id]);
    if (!current) throw notFound('布樣種類不存在');
    const name = requireText(request.body?.name, '名稱', 50);
    const scope = parseScope(request.body);
    await assertCustomersExist(scope.customerIds);
    // 適用對象改了，編號的可見範圍跟著變，要重新檢查有沒有撞號
    await assertScopedCodeUnique({
      table: 'fabric_types', entityType: ENTITY.fabricType, code: current.code,
      scope, excludeId: current.id, label: '布樣種類編號',
    });

    // 編輯時不得修改編號，名稱可改
    const row = await tx(async (dbx) => {
      const updated = await dbx.query(
        'update fabric_types set name = $2, scope_type = $3, updated_at = now() where id = $1 returning *',
        [current.id, name, scope.scopeType],
      ).then((r) => r.rows[0]);
      await writeScope(dbx, ENTITY.fabricType, current.id, scope);
      return updated;
    });
    await attachScope(ENTITY.fabricType, [row]);
    return { id: row.id, code: row.code, name: row.name, ...scopeView(row) };
  });

  async function deleteFabricType(id) {
    const current = await one('select * from fabric_types where id = $1', [id]);
    if (!current) throw notFound('布樣種類不存在');

    // 規格書：已被組織選中的布樣不得刪除
    const { count } = await one('select count(*)::int as count from weaves where fabric_type_id = $1', [id]);
    if (count > 0) throw badRequest(`「${current.name}」已被 ${count} 筆組織選用，不得刪除`);
    const inSpec = await one('select count(*)::int as count from weave_specs where fabric_type_id = $1', [id]);
    if (inSpec.count > 0) throw badRequest(`「${current.name}」已被 ${inSpec.count} 筆組織規格選用，不得刪除`);

    await tx(async (dbx) => {
      await clearScope(dbx, ENTITY.fabricType, id);
      await dbx.query('delete from fabric_types where id = $1', [id]);
    });
  }

  app.delete('/api/admin/fabric-types/:id', async (request, reply) => {
    await deleteFabricType(Number(request.params.id));
    reply.code(204);
  });

  registerBatchDelete(app, '/api/admin/fabric-types', deleteFabricType);

  // ------------------------------------------------------------ 組織

  app.get('/api/admin/weaves', async (request) => {
    const fabricTypeId = request.query?.fabricTypeId;
    const rows = await many(
      `select w.*, ft.name as fabric_type_name
         from weaves w
         join fabric_types ft on ft.id = w.fabric_type_id
        ${fabricTypeId ? 'where w.fabric_type_id = $1' : ''}
        order by ft.sort_order, ft.code, w.sort_order, w.code`,
      fabricTypeId ? [Number(fabricTypeId)] : [],
    );
    await attachScope(ENTITY.weave, rows);
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      fabricTypeId: row.fabric_type_id,
      fabricTypeName: row.fabric_type_name,
      ...scopeView(row),
    }));
  });

  app.post('/api/admin/weaves', async (request, reply) => {
    const code = requireText(request.body?.code, '編號', 50);
    const name = requireText(request.body?.name, '名稱', 50);
    const fabricTypeId = requireInt(request.body?.fabricTypeId, '對應布樣');
    const scope = parseScope(request.body);
    if (!(await one('select id from fabric_types where id = $1', [fabricTypeId]))) {
      throw badRequest('對應布樣不存在');
    }
    await assertCustomersExist(scope.customerIds);
    await assertScopedCodeUnique({
      table: 'weaves', entityType: ENTITY.weave, code, scope, label: '組織編號',
    });

    const created = await tx(async (dbx) => {
      const row = await dbx.query(
        'insert into weaves (code, name, fabric_type_id, scope_type) values ($1, $2, $3, $4) returning id',
        [code, name, fabricTypeId, scope.scopeType],
      ).then((r) => r.rows[0]);
      await writeScope(dbx, ENTITY.weave, row.id, scope);
      return row;
    });
    reply.code(201);
    return loadWeave(created.id);
  });

  app.put('/api/admin/weaves/:id', async (request) => {
    const current = await one('select * from weaves where id = $1', [request.params.id]);
    if (!current) throw notFound('組織不存在');
    const name = requireText(request.body?.name, '名稱', 50);
    const fabricTypeId = requireInt(request.body?.fabricTypeId, '對應布樣');
    const scope = parseScope(request.body);
    if (!(await one('select id from fabric_types where id = $1', [fabricTypeId]))) {
      throw badRequest('對應布樣不存在');
    }
    await assertCustomersExist(scope.customerIds);
    await assertScopedCodeUnique({
      table: 'weaves', entityType: ENTITY.weave, code: current.code,
      scope, excludeId: current.id, label: '組織編號',
    });

    // 編輯時不得修改編號，名稱可改
    await tx(async (dbx) => {
      await dbx.query(
        'update weaves set name = $2, fabric_type_id = $3, scope_type = $4, updated_at = now() where id = $1',
        [current.id, name, fabricTypeId, scope.scopeType],
      );
      await writeScope(dbx, ENTITY.weave, current.id, scope);
    });
    return loadWeave(current.id);
  });

  async function deleteWeave(id) {
    const current = await one('select * from weaves where id = $1', [id]);
    if (!current) throw notFound('組織不存在');

    const { count } = await one('select count(*)::int as count from weave_specs where weave_id = $1', [id]);
    if (count > 0) throw badRequest(`「${current.name}」已被 ${count} 筆組織規格選用，不得刪除`);

    await tx(async (dbx) => {
      await clearScope(dbx, ENTITY.weave, id);
      await dbx.query('delete from weaves where id = $1', [id]);
    });
  }

  app.delete('/api/admin/weaves/:id', async (request, reply) => {
    await deleteWeave(Number(request.params.id));
    reply.code(204);
  });

  registerBatchDelete(app, '/api/admin/weaves', deleteWeave);

  async function loadWeave(id) {
    const row = await one(
      `select w.*, ft.name as fabric_type_name
         from weaves w join fabric_types ft on ft.id = w.fabric_type_id
        where w.id = $1`,
      [id],
    );
    await attachScope(ENTITY.weave, [row]);
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      fabricTypeId: row.fabric_type_id,
      fabricTypeName: row.fabric_type_name,
      ...scopeView(row),
    };
  }

  // ------------------------------------------------------------ 成分

  const compositionView = (row) => ({
    id: row.id,
    code: row.code,
    nameEn: row.name_en,
    nameZh: row.name_zh,
    category: row.category,
    ...scopeView(row),
  });

  app.get('/api/admin/compositions', async () => {
    const rows = await many('select * from compositions order by sort_order, code');
    await attachScope(ENTITY.composition, rows);
    return rows.map(compositionView);
  });

  app.post('/api/admin/compositions', async (request, reply) => {
    const code = requireText(request.body?.code, '編號', 50);
    const nameEn = requireText(request.body?.nameEn, '英文名稱', 50);
    const nameZh = requireText(request.body?.nameZh, '中文名稱', 50);
    const category = requireText(request.body?.category, '分類', 50, { required: false });
    const scope = parseScope(request.body);
    await assertUnique('compositions', 'code', code, '成分編號');
    await assertCustomersExist(scope.customerIds);

    const row = await tx(async (dbx) => {
      const created = await dbx.query(
        `insert into compositions (code, name_en, name_zh, category, scope_type)
         values ($1, $2, $3, $4, $5) returning *`,
        [code, nameEn, nameZh, category, scope.scopeType],
      ).then((r) => r.rows[0]);
      await writeScope(dbx, ENTITY.composition, created.id, scope);
      return created;
    });
    await attachScope(ENTITY.composition, [row]);
    reply.code(201);
    return compositionView(row);
  });

  app.put('/api/admin/compositions/:id', async (request) => {
    const current = await one('select * from compositions where id = $1', [request.params.id]);
    if (!current) throw notFound('成分不存在');
    const code = requireText(request.body?.code, '編號', 50);
    const nameEn = requireText(request.body?.nameEn, '英文名稱', 50);
    const nameZh = requireText(request.body?.nameZh, '中文名稱', 50);
    const category = requireText(request.body?.category, '分類', 50, { required: false });
    const scope = parseScope(request.body);
    await assertCustomersExist(scope.customerIds);
    // 編號改為可修改，但仍不得與其他成分重複
    await assertUnique('compositions', 'code', code, '成分編號', current.id);

    const row = await tx(async (dbx) => {
      const updated = await dbx.query(
        `update compositions set code = $2, name_en = $3, name_zh = $4, category = $5,
                scope_type = $6, updated_at = now()
          where id = $1 returning *`,
        [current.id, code, nameEn, nameZh, category, scope.scopeType],
      ).then((r) => r.rows[0]);
      await writeScope(dbx, ENTITY.composition, current.id, scope);
      return updated;
    });
    await attachScope(ENTITY.composition, [row]);
    return compositionView(row);
  });

  async function deleteComposition(id) {
    const current = await one('select * from compositions where id = $1', [id]);
    if (!current) throw notFound('成分不存在');

    const { count } = await one(
      'select count(*)::int as count from weave_spec_compositions where composition_id = $1', [id],
    );
    if (count > 0) throw badRequest(`「${current.name_zh}」已被 ${count} 筆組織規格使用，不得刪除`);

    await tx(async (dbx) => {
      await clearScope(dbx, ENTITY.composition, id);
      await dbx.query('delete from compositions where id = $1', [id]);
    });
  }

  app.delete('/api/admin/compositions/:id', async (request, reply) => {
    await deleteComposition(Number(request.params.id));
    reply.code(204);
  });

  registerBatchDelete(app, '/api/admin/compositions', deleteComposition);

  // ------------------------------------------------------------ 彈性

  app.get('/api/admin/elasticities', async () => {
    const rows = await many('select * from elasticities order by sort_order, code');
    await attachScope(ENTITY.elasticity, rows);
    return rows.map((row) => ({ id: row.id, code: row.code, name: row.name, ...scopeView(row) }));
  });

  app.post('/api/admin/elasticities', async (request, reply) => {
    const code = requireText(request.body?.code, '編號', 50);
    const name = requireText(request.body?.name, '名稱', 50);
    const scope = parseScope(request.body);
    await assertCustomersExist(scope.customerIds);
    await assertScopedCodeUnique({
      table: 'elasticities', entityType: ENTITY.elasticity, code, scope, label: '彈性編號',
    });

    const row = await tx(async (dbx) => {
      const created = await dbx.query(
        'insert into elasticities (code, name, scope_type) values ($1, $2, $3) returning *',
        [code, name, scope.scopeType],
      ).then((r) => r.rows[0]);
      await writeScope(dbx, ENTITY.elasticity, created.id, scope);
      return created;
    });
    await attachScope(ENTITY.elasticity, [row]);
    reply.code(201);
    return { id: row.id, code: row.code, name: row.name, ...scopeView(row) };
  });

  app.put('/api/admin/elasticities/:id', async (request) => {
    const current = await one('select * from elasticities where id = $1', [request.params.id]);
    if (!current) throw notFound('彈性不存在');
    const name = requireText(request.body?.name, '名稱', 50);
    const scope = parseScope(request.body);
    await assertCustomersExist(scope.customerIds);
    await assertScopedCodeUnique({
      table: 'elasticities', entityType: ENTITY.elasticity, code: current.code,
      scope, excludeId: current.id, label: '彈性編號',
    });

    // 編輯時不得修改編號，名稱可改
    const row = await tx(async (dbx) => {
      const updated = await dbx.query(
        'update elasticities set name = $2, scope_type = $3, updated_at = now() where id = $1 returning *',
        [current.id, name, scope.scopeType],
      ).then((r) => r.rows[0]);
      await writeScope(dbx, ENTITY.elasticity, current.id, scope);
      return updated;
    });
    await attachScope(ENTITY.elasticity, [row]);
    return { id: row.id, code: row.code, name: row.name, ...scopeView(row) };
  });

  async function deleteElasticity(id) {
    if (!(await one('select id from elasticities where id = $1', [id]))) throw notFound('彈性不存在');
    await tx(async (dbx) => {
      await clearScope(dbx, ENTITY.elasticity, id);
      await dbx.query('delete from elasticities where id = $1', [id]);
    });
  }

  app.delete('/api/admin/elasticities/:id', async (request, reply) => {
    await deleteElasticity(Number(request.params.id));
    reply.code(204);
  });

  registerBatchDelete(app, '/api/admin/elasticities', deleteElasticity);
}
