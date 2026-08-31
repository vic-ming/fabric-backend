// 端對端煙霧測試：對每個後台模組跑一輪 建立 → 讀取 → 更新 → 刪除，
// 並驗證規格書寫明的限制條件（不得重複、不可修改、至少選一位客戶…）。
// 執行前會清空資料庫，請勿對正式環境執行。

import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

process.env.DB_DATA_DIR = resolve('.data/test-pglite');
process.env.UPLOAD_DIR = resolve('.data/test-uploads');
process.env.PORT = '0';
process.env.SEED_ON_BOOT = 'true';

await rm(process.env.DB_DATA_DIR, { recursive: true, force: true });
await rm(process.env.UPLOAD_DIR, { recursive: true, force: true });

const { start } = await import('../src/server.js');
const app = await start();
const base = `http://127.0.0.1:${app.server.address().port}`;

let passed = 0;
let failed = 0;
let token = '';

function ok(label, condition, extra = '') {
  if (condition) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.log(`  ✗ ${label} ${extra}`); }
}

async function call(method, path, body, { multipart = false } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (multipart) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }

  const response = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, body: json };
}

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
function form(fields, files = []) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) fd.append(key, String(value));
  }
  for (const file of files) {
    fd.append(file.field, new Blob([file.data], { type: file.type }), file.name);
  }
  return fd;
}

const section = (title) => console.log(`\n${title}`);

// ---------------------------------------------------------------- 登入

section('認證');
{
  const bad = await call('POST', '/api/auth/login', { username: 'admin', password: 'wrong' });
  ok('密碼錯誤回 401', bad.status === 401, JSON.stringify(bad.body));

  const res = await call('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  ok('管理員登入成功', res.status === 200 && !!res.body.token, JSON.stringify(res.body));
  ok('角色為 admin', res.body?.user?.role === 'admin');
  token = res.body.token;

  const guard = await fetch(`${base}/api/admin/customers`).then((r) => r.status);
  ok('未帶 token 存取後台回 401', guard === 401, String(guard));
}

// ---------------------------------------------------------------- 客戶管理

section('客戶管理');
let customerA;
let customerB;
{
  const created = await call('POST', '/api/admin/customers', {
    name: '小易股份有限公司', taxId: '12345678',
    contactName: '王小明', contactPhone: '02-1234-5678',
    contactAddress: '台北市內湖區新明路143巷', contactEmail: 'contact@company.com',
  });
  ok('新增客戶', created.status === 201, JSON.stringify(created.body));
  customerA = created.body.id;

  const dup = await call('POST', '/api/admin/customers', { name: '另一家', taxId: '12345678' });
  ok('統編重複被擋 409', dup.status === 409, JSON.stringify(dup.body));

  const missing = await call('POST', '/api/admin/customers', { name: '缺統編' });
  ok('缺必填回 400', missing.status === 400, JSON.stringify(missing.body));

  const tooLong = await call('POST', '/api/admin/customers', { name: 'x'.repeat(51), taxId: '99999999' });
  ok('名稱超過 50 字被擋', tooLong.status === 400, JSON.stringify(tooLong.body));

  const second = await call('POST', '/api/admin/customers', { name: '安欣國際貿易有限公司', taxId: '23456789' });
  customerB = second.body.id;

  const edited = await call('PUT', `/api/admin/customers/${customerA}`, {
    name: '小易股份有限公司（改）', taxId: '87654321', contactName: '陳曉華',
  });
  ok('編輯客戶成功', edited.status === 200, JSON.stringify(edited.body));
  ok('統一編號不可修改', edited.body?.taxId === '12345678', edited.body?.taxId);

  const list = await call('GET', '/api/admin/customers?keyword=安欣');
  ok('關鍵字搜尋', list.body?.items?.length === 1 && list.body.items[0].name.includes('安欣'), JSON.stringify(list.body));
}

// ---------------------------------------------------------------- 帳號管理

section('帳號管理');
let accountId;
{
  const created = await call('POST', '/api/admin/accounts', {
    customerId: customerA, username: 'wang.min@xiaoyi.com', displayName: '王小明',
    password: 'pass1234', validFrom: '2026-07-01', validTo: '2099-09-30',
  });
  ok('新增帳號', created.status === 201, JSON.stringify(created.body));
  ok('角色為 user', created.body?.role === 'user');
  ok('狀態為啟用', created.body?.status === 'active', created.body?.status);
  accountId = created.body.id;

  const badRange = await call('POST', '/api/admin/accounts', {
    customerId: customerA, username: 'x@y.com', displayName: 'X',
    password: 'p', validFrom: '2026-09-01', validTo: '2026-08-01',
  });
  ok('迄日早於起日被擋', badRange.status === 400, JSON.stringify(badRange.body));

  const dup = await call('POST', '/api/admin/accounts', {
    customerId: customerA, username: 'wang.min@xiaoyi.com', displayName: '重複',
    password: 'p', validFrom: '2026-01-01', validTo: '2026-12-31',
  });
  ok('帳號重複被擋 409', dup.status === 409, JSON.stringify(dup.body));

  const expired = await call('POST', '/api/admin/accounts', {
    customerId: customerB, username: 'lin.wei@anxin.com', displayName: '林偉倫',
    password: 'pass1234', validFrom: '2020-01-01', validTo: '2020-12-31',
  });
  ok('過期帳號狀態為停用', expired.body?.status === 'inactive', expired.body?.status);

  const edited = await call('PUT', `/api/admin/accounts/${accountId}`, {
    customerId: customerB, username: 'changed@x.com', displayName: '王小明二',
    validFrom: '2026-07-01', validTo: '2099-09-30',
  });
  ok('編輯時公司不可修改', edited.body?.customerId === customerA, String(edited.body?.customerId));
  ok('編輯時帳號不可修改', edited.body?.username === 'wang.min@xiaoyi.com', edited.body?.username);
  ok('姓名可修改', edited.body?.displayName === '王小明二');

  const filtered = await call('GET', '/api/admin/accounts?status=inactive');
  ok('依狀態篩選', filtered.body?.items?.length === 1, JSON.stringify(filtered.body?.items?.map((i) => i.username)));

  // 一般使用者不得進後台
  const userLogin = await call('POST', '/api/auth/login', { username: 'wang.min@xiaoyi.com', password: 'pass1234' });
  const userToken = userLogin.body.token;
  const denied = await fetch(`${base}/api/admin/customers`, { headers: { authorization: `Bearer ${userToken}` } });
  ok('一般使用者存取後台回 403', denied.status === 403, String(denied.status));

  const expiredLogin = await call('POST', '/api/auth/login', { username: 'lin.wei@anxin.com', password: 'pass1234' });
  ok('逾期帳號無法登入', expiredLogin.status === 403, JSON.stringify(expiredLogin.body));
}

// ---------------------------------------------------------------- 選項參數

section('選項參數管理');
let fabricTypeWO;
let fabricTypeCW;
let weaveId;
let compositionCO;
let compositionPES;
{
  const wo = await call('POST', '/api/admin/fabric-types', { name: '梭織', scopeType: 'global' });
  ok('新增布樣種類（全域）', wo.status === 201, JSON.stringify(wo.body));
  fabricTypeWO = wo.body.id;

  const cw = await call('POST', '/api/admin/fabric-types', {
    name: '特殊緹花', scopeType: 'customers', customerIds: [customerA, customerB],
  });
  ok('新增布樣種類（指定客戶）', cw.status === 201 && cw.body.customers.length === 2, JSON.stringify(cw.body));
  fabricTypeCW = cw.body.id;

  const noPick = await call('POST', '/api/admin/fabric-types', { name: '圓編', scopeType: 'customers', customerIds: [] });
  ok('指定客戶但未選任何客戶被擋', noPick.status === 400, JSON.stringify(noPick.body));

  const dup = await call('POST', '/api/admin/fabric-types', { name: '梭織' });
  ok('布樣種類名稱重複被擋', dup.status === 409, JSON.stringify(dup.body));

  const renamed = await call('PUT', `/api/admin/fabric-types/${fabricTypeWO}`, { name: '改名', scopeType: 'global' });
  ok('編輯時名稱不可修改', renamed.body?.name === '梭織', renamed.body?.name);

  const weave = await call('POST', '/api/admin/weaves', {
    name: '平紋', fabricTypeId: fabricTypeWO, scopeType: 'global',
  });
  ok('新增組織', weave.status === 201, JSON.stringify(weave.body));
  weaveId = weave.body.id;

  const delUsed = await call('DELETE', `/api/admin/fabric-types/${fabricTypeWO}`);
  ok('已被組織選中的布樣不得刪除', delUsed.status === 400, JSON.stringify(delUsed.body));

  const byType = await call('GET', `/api/admin/weaves?fabricTypeId=${fabricTypeWO}`);
  ok('組織可依布樣種類篩選', byType.body?.length === 1, JSON.stringify(byType.body));

  const co = await call('POST', '/api/admin/compositions', {
    code: 'CO', nameEn: 'Cotton', nameZh: '棉', category: '天然纖維', scopeType: 'global',
  });
  ok('新增成分', co.status === 201, JSON.stringify(co.body));
  compositionCO = co.body.id;

  const pes = await call('POST', '/api/admin/compositions', {
    code: 'PES', nameEn: 'Polyester', nameZh: '聚酯纖維', category: '合成纖維', scopeType: 'global',
  });
  compositionPES = pes.body.id;

  const codeDup = await call('POST', '/api/admin/compositions', { code: 'CO', nameEn: 'X', nameZh: 'Y' });
  ok('成分編號重複被擋', codeDup.status === 409, JSON.stringify(codeDup.body));

  const codeEdit = await call('PUT', `/api/admin/compositions/${compositionCO}`, {
    code: 'ZZ', nameEn: 'Cotton', nameZh: '棉花', scopeType: 'global',
  });
  ok('編輯時編號不可修改', codeEdit.body?.code === 'CO', codeEdit.body?.code);
  ok('中文名稱可修改', codeEdit.body?.nameZh === '棉花');

  for (const name of ['無彈性', '經向彈性', '緯向彈性', '四向彈性']) {
    await call('POST', '/api/admin/elasticities', { name, scopeType: 'global' });
  }
  const elasticities = await call('GET', '/api/admin/elasticities');
  ok('新增四種彈性', elasticities.body?.length === 4, JSON.stringify(elasticities.body?.map((e) => e.name)));

  void fabricTypeCW;
}

// ---------------------------------------------------------------- 布厚布重

section('布厚布重範圍設定');
{
  const initial = await call('GET', '/api/admin/spec-ranges');
  ok('全域預設 43~527 / 0.01~3.4',
    initial.body?.global?.weightMin === 43 && initial.body.global.weightMax === 527
    && initial.body.global.thicknessMin === 0.01 && initial.body.global.thicknessMax === 3.4,
    JSON.stringify(initial.body?.global));

  const updated = await call('PUT', '/api/admin/spec-ranges/global', {
    weightMin: 50, weightMax: 400, weightUnit: 'g/m2',
    thicknessMin: 0.05, thicknessMax: 1.5, thicknessUnit: 'mm',
  });
  ok('可更新全域預設', updated.body?.weightMin === 50, JSON.stringify(updated.body));

  const inverted = await call('PUT', '/api/admin/spec-ranges/global', {
    weightMin: 500, weightMax: 100, weightUnit: 'g/m2',
    thicknessMin: 0.05, thicknessMax: 1.5, thicknessUnit: 'mm',
  });
  ok('最大值小於最小值被擋', inverted.status === 400, JSON.stringify(inverted.body));

  const perCustomer = await call('POST', '/api/admin/spec-ranges', {
    customerId: customerA, weightMin: 50, weightMax: 400, weightUnit: 'g/m2',
    thicknessMin: 0.05, thicknessMax: 2.8, thicknessUnit: 'mm',
  });
  ok('新增客戶專屬範圍', perCustomer.status === 201, JSON.stringify(perCustomer.body));

  const dup = await call('POST', '/api/admin/spec-ranges', {
    customerId: customerA, weightMin: 1, weightMax: 2, weightUnit: 'g/m2',
    thicknessMin: 1, thicknessMax: 2, thicknessUnit: 'mm',
  });
  ok('同一客戶只能有一組被擋', dup.status === 409, JSON.stringify(dup.body));
}

// ---------------------------------------------------------------- 印花

section('印花管理');
let patternId;
{
  const categories = await call('GET', '/api/admin/pattern-categories');
  ok('7 個預設分類已建立', categories.body?.length === 7, JSON.stringify(categories.body?.map((c) => c.name)));
  const camoId = categories.body.find((c) => c.name === '迷彩').id;

  const uploaded = await call('POST', '/api/admin/patterns',
    form({ kind: 'general', categoryId: camoId, physicalWidthCm: 9.144, physicalHeightCm: 9.144 },
      [{ field: 'files', data: png, type: 'image/png', name: 'camo_green_01.png' }]),
    { multipart: true });
  ok('上傳一般分類印花', uploaded.status === 201, JSON.stringify(uploaded.body));
  ok('未填名稱時以檔名為預設', uploaded.body?.[0]?.name === 'camo_green_01.png', uploaded.body?.[0]?.name);
  ok('公分尺寸有存下', uploaded.body?.[0]?.physicalWidthCm === 9.144);
  patternId = uploaded.body[0].id;

  const multi = await call('POST', '/api/admin/patterns',
    form({ kind: 'customer', customerId: customerB },
      [{ field: 'files', data: png, type: 'image/png', name: 'a.png' },
       { field: 'files', data: png, type: 'image/png', name: 'b.png' }]),
    { multipart: true });
  ok('客戶圖庫可一次多檔', multi.status === 201 && multi.body.length === 2, JSON.stringify(multi.body));

  const noTarget = await call('POST', '/api/admin/patterns',
    form({ kind: 'general' }, [{ field: 'files', data: png, type: 'image/png', name: 'x.png' }]),
    { multipart: true });
  ok('一般分類未選分類被擋', noTarget.status === 400, JSON.stringify(noTarget.body));

  const badType = await call('POST', '/api/admin/patterns',
    form({ kind: 'general', categoryId: camoId },
      [{ field: 'files', data: Buffer.from('hi'), type: 'text/plain', name: 'x.txt' }]),
    { multipart: true });
  ok('非圖片格式被擋', badType.status === 400, JSON.stringify(badType.body));

  const renamed = await call('PUT', `/api/admin/patterns/${patternId}`, {
    kind: 'general', categoryId: camoId, name: '迷彩綠 01',
  });
  ok('可修改名稱', renamed.body?.name === '迷彩綠 01', JSON.stringify(renamed.body));

  const catDel = await call('DELETE', `/api/admin/pattern-categories/${camoId}`);
  ok('分類底下有圖片時不得刪除', catDel.status === 400, JSON.stringify(catDel.body));

  const byCustomer = await call('GET', `/api/admin/patterns?kind=customer&customerId=${customerB}`);
  ok('可依客戶篩選圖庫', byCustomer.body?.total === 2, JSON.stringify(byCustomer.body?.total));

  const fileUrl = uploaded.body[0].file.url;
  const served = await fetch(`${base}${fileUrl}`);
  ok('檔案可正常讀取', served.status === 200 && served.headers.get('content-type') === 'image/png',
    `${served.status} ${served.headers.get('content-type')}`);
}

// ---------------------------------------------------------------- 組織規格

section('組織規格管理');
let weaveSpecId;
{
  const created = await call('POST', '/api/admin/weave-specs',
    form({
      code: 'F-0001', fabricTypeId: fabricTypeWO, weaveId, weight: 205, thickness: 0.5,
      density: '123', finishing: '456', scopeType: 'global',
      compositions: JSON.stringify([
        { compositionId: compositionCO, percent: 20 },
        { compositionId: compositionPES, percent: 80 },
      ]),
    }, [
      { field: 'preview', data: png, type: 'image/png', name: 'preview.png' },
      { field: 'files', data: Buffer.from('u3m content'), type: 'application/octet-stream', name: 'F-0001.u3m' },
    ]),
    { multipart: true });
  ok('新增組織規格', created.status === 201, JSON.stringify(created.body));
  ok('成分有兩項', created.body?.compositions?.length === 2);
  ok('組織資料檔案有一個', created.body?.files?.length === 1);
  weaveSpecId = created.body.id;

  const badSum = await call('POST', '/api/admin/weave-specs',
    form({
      code: 'F-0002', fabricTypeId: fabricTypeWO, weaveId, weight: 100, thickness: 1,
      scopeType: 'global',
      compositions: JSON.stringify([{ compositionId: compositionCO, percent: 60 }]),
    }, [
      { field: 'preview', data: png, type: 'image/png', name: 'p.png' },
      { field: 'files', data: Buffer.from('x'), type: 'application/octet-stream', name: 'x.bin' },
    ]),
    { multipart: true });
  ok('成分合計非 100% 被擋', badSum.status === 400, JSON.stringify(badSum.body));

  const mismatch = await call('POST', '/api/admin/weave-specs',
    form({
      code: 'F-0003', fabricTypeId: fabricTypeCW, weaveId, weight: 100, thickness: 1,
      scopeType: 'global',
      compositions: JSON.stringify([{ compositionId: compositionCO, percent: 100 }]),
    }, [
      { field: 'preview', data: png, type: 'image/png', name: 'p.png' },
      { field: 'files', data: Buffer.from('x'), type: 'application/octet-stream', name: 'x.bin' },
    ]),
    { multipart: true });
  ok('織物細項不屬於所選織物被擋', mismatch.status === 400, JSON.stringify(mismatch.body));

  const noPreview = await call('POST', '/api/admin/weave-specs',
    form({
      code: 'F-0004', fabricTypeId: fabricTypeWO, weaveId, weight: 100, thickness: 1,
      scopeType: 'global',
      compositions: JSON.stringify([{ compositionId: compositionCO, percent: 100 }]),
    }, [{ field: 'files', data: Buffer.from('x'), type: 'application/octet-stream', name: 'x.bin' }]),
    { multipart: true });
  ok('缺組織預覽圖被擋', noPreview.status === 400, JSON.stringify(noPreview.body));

  const edited = await call('PUT', `/api/admin/weave-specs/${weaveSpecId}`,
    form({
      code: 'CHANGED', fabricTypeId: fabricTypeWO, weaveId, weight: 210, thickness: 0.6,
      density: '789', scopeType: 'customers', customerIds: JSON.stringify([customerA]),
      compositions: JSON.stringify([{ compositionId: compositionPES, percent: 100 }]),
      keepFileIds: JSON.stringify(created.body.files.map((f) => f.id)),
    }, [{ field: 'files', data: Buffer.from('extra'), type: 'application/octet-stream', name: 'extra.obj' }]),
    { multipart: true });
  ok('編輯時編號不可修改', edited.body?.code === 'F-0001', edited.body?.code);
  ok('布重已更新', edited.body?.weight === 210);
  ok('成分已替換為一項', edited.body?.compositions?.length === 1);
  ok('保留舊檔並新增一個', edited.body?.files?.length === 2, JSON.stringify(edited.body?.files?.map((f) => f.name)));
  ok('適用對象改為指定客戶', edited.body?.scopeType === 'customers' && edited.body.customers.length === 1);

  const usedWeave = await call('DELETE', `/api/admin/weaves/${weaveId}`);
  ok('已被組織規格使用的組織不得刪除', usedWeave.status === 400, JSON.stringify(usedWeave.body));

  const usedComp = await call('DELETE', `/api/admin/compositions/${compositionPES}`);
  ok('已被組織規格使用的成分不得刪除', usedComp.status === 400, JSON.stringify(usedComp.body));
}

// ---------------------------------------------------------------- 背景 / 3D 模型

section('背景管理 / 3D 模型管理');
{
  const bg = await call('POST', '/api/admin/backgrounds',
    form({ name: '純白攝影棚', scopeType: 'global' },
      [{ field: 'file', data: Buffer.from('hdr'), type: 'application/octet-stream', name: 'studio.hdr' }]),
    { multipart: true });
  ok('上傳背景', bg.status === 201, JSON.stringify(bg.body));

  const bgDup = await call('POST', '/api/admin/backgrounds',
    form({ name: '純白攝影棚', scopeType: 'global' },
      [{ field: 'file', data: Buffer.from('hdr'), type: 'application/octet-stream', name: 'x.hdr' }]),
    { multipart: true });
  ok('背景名稱不得重複', bgDup.status === 409, JSON.stringify(bgDup.body));

  const model = await call('POST', '/api/admin/models-3d',
    form({ name: '球體', scopeType: 'customers', customerIds: JSON.stringify([customerA]) },
      [{ field: 'file', data: Buffer.from('obj'), type: 'application/octet-stream', name: 'sphere.obj' }]),
    { multipart: true });
  ok('上傳 3D 模型（指定客戶）', model.status === 201 && model.body.customers.length === 1, JSON.stringify(model.body));

  const tshirt = await call('POST', '/api/admin/models-3d',
    form({ name: 'T恤', scopeType: 'global' },
      [{ field: 'file', data: Buffer.from('obj'), type: 'application/octet-stream', name: 'tshirt.obj' }]),
    { multipart: true });
  ok('上傳全域 3D 模型', tshirt.status === 201);

  const filtered = await call('GET', `/api/admin/models-3d?customerId=${customerA}`);
  ok('可依適用對象篩選', filtered.body?.total === 1, JSON.stringify(filtered.body?.total));

  const renamed = await call('PUT', `/api/admin/backgrounds/${bg.body.id}`, {
    name: '戶外草地', scopeType: 'global',
  });
  ok('可只改名稱不重傳檔案', renamed.body?.name === '戶外草地', JSON.stringify(renamed.body));
}

// ---------------------------------------------------------------- 前台可見性

section('前台取用（適用對象過濾）');
{
  const adminToken = token;

  const loginA = await call('POST', '/api/auth/login', { username: 'wang.min@xiaoyi.com', password: 'pass1234' });
  token = loginA.body.token;

  const options = await call('GET', '/api/options');
  ok('客戶 A 看得到全域布樣種類', options.body?.fabricTypes?.some((t) => t.name === '梭織'),
    JSON.stringify(options.body?.fabricTypes));
  ok('客戶 A 看得到指定給自己的布樣種類', options.body?.fabricTypes?.some((t) => t.name === '特殊緹花'));
  ok('組織已依布樣種類分組', Array.isArray(options.body?.weavesByFabricType?.[fabricTypeWO]));
  ok('取得客戶 A 的專屬範圍 50~400 / 0.05~2.8',
    options.body?.specRange?.weightMin === 50 && options.body.specRange.thicknessMax === 2.8,
    JSON.stringify(options.body?.specRange));

  const models = await call('GET', '/api/models-3d');
  ok('客戶 A 看得到指定給自己的模型與全域模型', models.body?.length === 2,
    JSON.stringify(models.body?.map((m) => m.name)));

  const specs = await call('GET', '/api/weave-specs');
  ok('客戶 A 看得到指定給自己的組織規格', specs.body?.length === 1, JSON.stringify(specs.body?.length));

  const patterns = await call('GET', '/api/patterns');
  ok('客戶 A 看不到別家客戶圖庫',
    patterns.body?.items?.every((p) => p.kind === 'general'),
    JSON.stringify(patterns.body?.items?.map((p) => `${p.kind}:${p.name}`)));

  // 換成客戶 B 的帳號比對
  token = adminToken;
  await call('POST', '/api/admin/accounts', {
    customerId: customerB, username: 'huang@anxin.com', displayName: '黃思婷',
    password: 'pass1234', validFrom: '2020-01-01', validTo: '2099-12-31',
  });
  const loginB = await call('POST', '/api/auth/login', { username: 'huang@anxin.com', password: 'pass1234' });
  token = loginB.body.token;

  const modelsB = await call('GET', '/api/models-3d');
  ok('客戶 B 看不到客戶 A 專屬的模型', modelsB.body?.length === 1 && modelsB.body[0].name === 'T恤',
    JSON.stringify(modelsB.body?.map((m) => m.name)));

  const specsB = await call('GET', '/api/weave-specs');
  ok('客戶 B 看不到客戶 A 專屬的組織規格', specsB.body?.length === 0, JSON.stringify(specsB.body?.length));

  const patternsB = await call('GET', '/api/patterns');
  ok('客戶 B 看得到自己的圖庫',
    patternsB.body?.items?.filter((p) => p.kind === 'customer').length === 2,
    JSON.stringify(patternsB.body?.items?.map((p) => p.kind)));

  const rangeB = await call('GET', '/api/options');
  ok('客戶 B 落回全域預設 50~400 / 0.05~1.5',
    rangeB.body?.specRange?.thicknessMax === 1.5, JSON.stringify(rangeB.body?.specRange));

  token = adminToken;
}

// ---------------------------------------------------------------- 刪除

section('刪除');
{
  const del = await call('DELETE', `/api/admin/weave-specs/${weaveSpecId}`);
  ok('刪除組織規格', del.status === 204, String(del.status));

  const nowDeletable = await call('DELETE', `/api/admin/weaves/${weaveId}`);
  ok('組織不再被引用後可刪除', nowDeletable.status === 204, JSON.stringify(nowDeletable.body));

  const gone = await call('GET', `/api/admin/weave-specs/${weaveSpecId}`);
  ok('已刪除的組織規格查不到', gone.status === 404);

  const delPattern = await call('DELETE', `/api/admin/patterns/${patternId}`);
  ok('刪除印花', delPattern.status === 204, String(delPattern.status));
}

console.log(`\n${'-'.repeat(48)}`);
console.log(`通過 ${passed}　失敗 ${failed}`);
await app.close();
process.exit(failed === 0 ? 0 : 1);
