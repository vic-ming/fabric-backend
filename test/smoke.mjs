// 端對端煙霧測試：對每個後台模組跑一輪 建立 → 讀取 → 更新 → 刪除，
// 並驗證規格書寫明的限制條件（不得重複、不可修改、至少選一位客戶…）。
// 執行前會清空資料庫，請勿對正式環境執行。

import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

process.env.DB_DATA_DIR = resolve('.data/test-pglite');
process.env.UPLOAD_DIR = resolve('.data/test-uploads');
process.env.PORT = '0';
process.env.SEED_ON_BOOT = 'true';

// 假的紡織所 API：記下收到的請求，回傳與正式環境相同格式的資料
const ttriCalls = [];
const ttriServer = createServer((req, res) => {
  const url = new URL(req.url, 'http://ttri');
  ttriCalls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization });
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== 'Bearer fake-ttri-token') return send(401, { detail: 'Account is inactive or no longer exists.' });
  if (url.pathname === '/Specs2VS') {
    return send(200, {
      SampleCode: '2-0000437', Name: '2-0000437-2', MachineType: 'Matched', Thickness: 0.6, MassDensity: 330,
      BendRigidityWeft: 121.2, BendRigidityWarp: 154.5, StretchRigidityWeft: 97.2, StretchRigidityWarp: 169.4,
      StretchRigidityShear: 38.1, StretchLinearityWeft: 50, StretchLinearityWarp: 50, StretchLinearityShear: 20,
    });
  }
  const id = url.searchParams.get('id');
  if (url.pathname === '/buildU3M') return send(200, { '.': [`${id}.json`, `${id}.u3m`] });
  if (url.pathname === '/downloadFILE') {
    const file = url.searchParams.get('filename');
    if (file.endsWith('.json')) return send(200, { custom: { browzwear: { mass: 330 } } });
    return send(200, { material: { name: file, front: { basecolor: { texture: { image: { path: 'textures/x_BASE.jpg' } } } } } });
  }
  return send(404, { detail: 'Not Found' });
});
await new Promise((resolve) => ttriServer.listen(0, '127.0.0.1', resolve));
process.env.TTRI_API_BASE_URL = `http://127.0.0.1:${ttriServer.address().port}`;
process.env.TTRI_API_TOKEN = 'fake-ttri-token';
process.env.TTRI_MIN_INTERVAL_MS = '0';

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
  ok('統一編號可修改', edited.body?.taxId === '87654321', edited.body?.taxId);

  const taxClash = await call('PUT', `/api/admin/customers/${customerA}`, {
    name: '小易股份有限公司（改）', taxId: '23456789',
  });
  ok('統編改成別家公司的被擋 409', taxClash.status === 409, JSON.stringify(taxClash.body));

  const off = await call('PUT', `/api/admin/customers/${customerA}/active`, { isActive: false });
  ok('公司可停用', off.status === 200 && off.body?.isActive === false, JSON.stringify(off.body));
  const on = await call('PUT', `/api/admin/customers/${customerA}/active`, { isActive: true });
  ok('公司可重新啟用', on.body?.isActive === true, JSON.stringify(on.body));

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
  const wo = await call('POST', '/api/admin/fabric-types', { code: 'WO', name: '梭織', scopeType: 'global' });
  ok('新增布樣種類（全域）', wo.status === 201, JSON.stringify(wo.body));
  fabricTypeWO = wo.body.id;

  const cw = await call('POST', '/api/admin/fabric-types', {
    code: 'SP', name: '特殊緹花', scopeType: 'customers', customerIds: [customerA, customerB],
  });
  ok('新增布樣種類（指定客戶）', cw.status === 201 && cw.body.customers.length === 2, JSON.stringify(cw.body));
  fabricTypeCW = cw.body.id;

  const noPick = await call('POST', '/api/admin/fabric-types', { code: 'CW', name: '圓編', scopeType: 'customers', customerIds: [] });
  ok('指定客戶但未選任何客戶被擋', noPick.status === 400, JSON.stringify(noPick.body));

  const sameName = await call('POST', '/api/admin/fabric-types', { code: 'WO2', name: '梭織', scopeType: 'global' });
  ok('名稱可重複', sameName.status === 201, JSON.stringify(sameName.body));

  const dup = await call('POST', '/api/admin/fabric-types', { code: 'WO', name: '別的名字' });
  ok('全域編碼重複被擋', dup.status === 409, JSON.stringify(dup.body));

  // 編碼「同公司不可重複、跨公司可重複」
  const onlyA = await call('POST', '/api/admin/fabric-types', {
    code: 'LOCAL', name: '甲公司專用', scopeType: 'customers', customerIds: [customerA],
  });
  ok('指定甲公司可建編碼 LOCAL', onlyA.status === 201, JSON.stringify(onlyA.body));
  const alsoA = await call('POST', '/api/admin/fabric-types', {
    code: 'LOCAL', name: '撞號', scopeType: 'customers', customerIds: [customerA],
  });
  ok('同一家公司不得重複編碼', alsoA.status === 409, JSON.stringify(alsoA.body));
  const onlyB = await call('POST', '/api/admin/fabric-types', {
    code: 'LOCAL', name: '乙公司專用', scopeType: 'customers', customerIds: [customerB],
  });
  ok('跨公司可用同一編碼', onlyB.status === 201, JSON.stringify(onlyB.body));
  const globalClash = await call('POST', '/api/admin/fabric-types', {
    code: 'LOCAL', name: '全域撞號', scopeType: 'global',
  });
  ok('全域編碼與任一公司撞號即被擋', globalClash.status === 409, JSON.stringify(globalClash.body));

  const renamed = await call('PUT', `/api/admin/fabric-types/${fabricTypeWO}`, { name: '改名', scopeType: 'global' });
  ok('名稱可修改', renamed.body?.name === '改名', renamed.body?.name);
  ok('編碼不隨編輯改變', renamed.body?.code === 'WO', renamed.body?.code);

  const weave = await call('POST', '/api/admin/weaves', {
    code: 'PLAIN', name: '平紋', fabricTypeId: fabricTypeWO, scopeType: 'global',
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
  ok('成分編號可修改', codeEdit.body?.code === 'ZZ', codeEdit.body?.code);
  const codeEditClash = await call('PUT', `/api/admin/compositions/${compositionCO}`, {
    code: 'PES', nameEn: 'Cotton', nameZh: '棉花', scopeType: 'global',
  });
  ok('改成別筆已用的編號被擋', codeEditClash.status === 409, JSON.stringify(codeEditClash.body));
  ok('中文名稱可修改', codeEdit.body?.nameZh === '棉花');

  for (const [i, name] of ['無彈性', '經向彈性', '緯向彈性', '四向彈性'].entries()) {
    await call('POST', '/api/admin/elasticities', { code: `EL${i}`, name, scopeType: 'global' });
  }
  const elDupName = await call('POST', '/api/admin/elasticities', {
    code: 'EL9', name: '無彈性', scopeType: 'global',
  });
  ok('彈性名稱可重複', elDupName.status === 201, JSON.stringify(elDupName.body));
  const elDupCode = await call('POST', '/api/admin/elasticities', {
    code: 'EL0', name: '撞編碼', scopeType: 'global',
  });
  ok('彈性編碼重複被擋', elDupCode.status === 409, JSON.stringify(elDupCode.body));
  const elasticities = await call('GET', '/api/admin/elasticities');
  ok('新增四種彈性', elasticities.body?.length === 5, JSON.stringify(elasticities.body?.map((e) => e.name)));

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
  ok('未填名稱時以檔名為預設', uploaded.body?.name === 'camo_green_01.png', uploaded.body?.name);
  ok('設計尺寸有存下', uploaded.body?.physicalWidthCm === 9.144);
  patternId = uploaded.body.id;

  // 每張印花都要有自己的設計尺寸，多檔上傳無法逐張指定，因此改為一次一張
  const multi = await call('POST', '/api/admin/patterns',
    form({ kind: 'customer', customerId: customerB },
      [{ field: 'files', data: png, type: 'image/png', name: 'a.png' },
       { field: 'files', data: png, type: 'image/png', name: 'b.png' }]),
    { multipart: true });
  ok('一次只能上傳一張', multi.status === 400, JSON.stringify(multi.body));

  const single = await call('POST', '/api/admin/patterns',
    form({ kind: 'customer', customerId: customerB },
      [{ field: 'files', data: png, type: 'image/png', name: 'a.png' }]),
    { multipart: true });
  ok('客戶圖庫單張上傳成功', single.status === 201, JSON.stringify(single.body));

  const catAdded = await call('POST', '/api/admin/pattern-categories', { name: '手繪風' });
  ok('可新增印花分類', catAdded.status === 201, JSON.stringify(catAdded.body));
  const catRenamed = await call('PUT', `/api/admin/pattern-categories/${catAdded.body.id}`, { name: '手繪' });
  ok('可編輯印花分類', catRenamed.body?.name === '手繪', JSON.stringify(catRenamed.body));
  const catRemoved = await call('DELETE', `/api/admin/pattern-categories/${catAdded.body.id}`);
  ok('可刪除空的印花分類', catRemoved.status === 204, catRemoved.status);

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
  ok('可依客戶篩選圖庫', byCustomer.body?.total === 1, JSON.stringify(byCustomer.body?.total));

  const fileUrl = uploaded.body.file.url;
  const served = await fetch(`${base}${fileUrl}`);
  ok('檔案可正常讀取', served.status === 200 && served.headers.get('content-type') === 'image/png',
    `${served.status} ${served.headers.get('content-type')}`);
}

// ---------------------------------------------------------------- 組織規格


// 最小但結構正確的 .u3m：兩個材質通道，basecolor 記著實際尺寸（公釐）
const u3mDoc = (name, widthMm, heightMm) => Buffer.from(JSON.stringify({
  material: {
    front: {
      basecolor: { texture: { image: { path: `textures/${name}_BASE.jpg`, width: widthMm, height: heightMm } } },
      normal: { texture: { image: { path: `textures/${name}_NRM.jpg`, width: widthMm, height: heightMm } } },
      preview: { path: `${name}.png`, width: 100, height: 100 },
    },
  },
}));

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
      { field: 'files', data: u3mDoc('F-0001', 39.649, 40.339), type: 'application/octet-stream', name: 'F-0001.u3m' },
      { field: 'files', data: png, type: 'image/jpeg', name: 'F-0001_BASE.jpg' },
      { field: 'files', data: png, type: 'image/jpeg', name: 'F-0001_NRM.jpg' },
    ]),
    { multipart: true });
  ok('新增組織規格', created.status === 201, JSON.stringify(created.body));
  ok('成分有兩項', created.body?.compositions?.length === 2);
  ok('組織資料檔案有三個', created.body?.files?.length === 3);
  // 沒填尺寸時，自動以 .u3m 記錄的公釐換算成公分帶入
  ok('u3m 尺寸自動帶入（39.649mm → 3.965cm）',
    created.body?.designWidthCm === 3.965 && created.body?.designHeightCm === 4.034,
    JSON.stringify([created.body?.designWidthCm, created.body?.designHeightCm]));

  const missingTex = await call('POST', '/api/admin/weave-specs',
    form({
      code: 'F-0009', fabricTypeId: fabricTypeWO, weaveId, weight: 100, thickness: 1,
      scopeType: 'global',
      compositions: JSON.stringify([{ compositionId: compositionPES, percent: 100 }]),
    }, [
      { field: 'preview', data: png, type: 'image/png', name: 'preview.png' },
      { field: 'files', data: u3mDoc('F-0009', 30, 30), type: 'application/octet-stream', name: 'F-0009.u3m' },
      { field: 'files', data: png, type: 'image/jpeg', name: 'F-0009_BASE.jpg' },
    ]),
    { multipart: true });
  ok('u3m 缺貼圖被擋並列出檔名',
    missingTex.status === 400 && String(missingTex.body?.error).includes('F-0009_NRM.jpg'),
    JSON.stringify(missingTex.body));

  const badU3m = await call('POST', '/api/admin/weave-specs',
    form({
      code: 'F-0008', fabricTypeId: fabricTypeWO, weaveId, weight: 100, thickness: 1,
      scopeType: 'global',
      compositions: JSON.stringify([{ compositionId: compositionPES, percent: 100 }]),
    }, [
      { field: 'preview', data: png, type: 'image/png', name: 'preview.png' },
      { field: 'files', data: Buffer.from('not json'), type: 'application/octet-stream', name: 'F-0008.u3m' },
    ]),
    { multipart: true });
  ok('壞掉的 u3m 被擋', badU3m.status === 400, JSON.stringify(badU3m.body));
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
  ok('編輯沒帶尺寸時保留原本的設計尺寸', edited.body?.designWidthCm === 3.965,
    JSON.stringify(edited.body?.designWidthCm));
  ok('成分已替換為一項', edited.body?.compositions?.length === 1);
  ok('保留舊檔並新增一個', edited.body?.files?.length === 4, JSON.stringify(edited.body?.files?.map((f) => f.name)));
  ok('適用對象改為指定客戶', edited.body?.scopeType === 'customers' && edited.body.customers.length === 1);

  const usedWeave = await call('DELETE', `/api/admin/weaves/${weaveId}`);
  ok('已被組織規格使用的組織不得刪除', usedWeave.status === 400, JSON.stringify(usedWeave.body));

  const usedComp = await call('DELETE', `/api/admin/compositions/${compositionPES}`);
  ok('已被組織規格使用的成分不得刪除', usedComp.status === 400, JSON.stringify(usedComp.body));
}

// ---------------------------------------------------------------- 背景 / 3D 模型

section('背景管理 / 3D 模型管理');
let modelAId;
{
  const bg = await call('POST', '/api/admin/backgrounds',
    form({ code: 'BG-WHITE', name: '純白攝影棚', scopeType: 'global' },
      [{ field: 'file', data: Buffer.from('hdr'), type: 'application/octet-stream', name: 'studio.hdr' }]),
    { multipart: true });
  ok('上傳背景', bg.status === 201, JSON.stringify(bg.body));

  const bgBadExt = await call('POST', '/api/admin/backgrounds',
    form({ code: 'BG-PNG', name: '非 hdr', scopeType: 'global' },
      [{ field: 'file', data: Buffer.from('png'), type: 'image/png', name: 'studio.png' }]),
    { multipart: true });
  ok('背景只收 .hdr', bgBadExt.status === 400, JSON.stringify(bgBadExt.body));

  const bgDup = await call('POST', '/api/admin/backgrounds',
    form({ code: 'BG-WHITE', name: '不同名字', scopeType: 'global' },
      [{ field: 'file', data: Buffer.from('hdr'), type: 'application/octet-stream', name: 'x.hdr' }]),
    { multipart: true });
  ok('背景編碼不得重複', bgDup.status === 409, JSON.stringify(bgDup.body));

  const model = await call('POST', '/api/admin/models-3d',
    form({ code: 'M-BALL', name: '球體', sizeWidthCm: 50, sizeHeightCm: 50.5,
           scopeType: 'customers', customerIds: JSON.stringify([customerA]) },
      [{ field: 'file', data: Buffer.from('obj'), type: 'application/octet-stream', name: 'sphere.obj' }]),
    { multipart: true });
  ok('上傳 3D 模型（指定客戶）', model.status === 201 && model.body.customers.length === 1, JSON.stringify(model.body));
  modelAId = model.body.id;
  ok('模型尺寸可含小數', model.body?.sizeHeightCm === 50.5, JSON.stringify(model.body?.sizeHeightCm));

  // A 公司與 B 公司可以各有一個叫「衣服」的模型
  const sameNameB = await call('POST', '/api/admin/models-3d',
    form({ code: 'M-BALL', name: '球體', scopeType: 'customers', customerIds: JSON.stringify([customerB]) },
      [{ field: 'file', data: Buffer.from('obj'), type: 'application/octet-stream', name: 'sphere2.obj' }]),
    { multipart: true });
  ok('模型名稱與編碼可跨公司重複', sameNameB.status === 201, JSON.stringify(sameNameB.body));

  const tshirt = await call('POST', '/api/admin/models-3d',
    form({ code: 'M-TSHIRT', name: 'T恤', scopeType: 'global' },
      [{ field: 'file', data: Buffer.from('obj'), type: 'application/octet-stream', name: 'tshirt.obj' }]),
    { multipart: true });
  ok('上傳全域 3D 模型', tshirt.status === 201);

  const filtered = await call('GET', `/api/admin/models-3d?customerId=${customerA}`);
  ok('可依適用對象篩選', filtered.body?.total === 1, JSON.stringify(filtered.body?.total));

  const renamed = await call('PUT', `/api/admin/backgrounds/${bg.body.id}`, {
    name: '戶外草地', scopeType: 'global',
  });
  ok('可只改名稱不重傳檔案', renamed.body?.name === '戶外草地', JSON.stringify(renamed.body));

  const off = await call('PUT', `/api/admin/models-3d/${tshirt.body.id}/active`, { isActive: false });
  ok('模型可停用', off.status === 200 && off.body?.isActive === false, JSON.stringify(off.body));
  const backOn = await call('PUT', `/api/admin/models-3d/${tshirt.body.id}/active`, { isActive: true });
  ok('模型可重新啟用', backOn.body?.isActive === true, JSON.stringify(backOn.body));
}

// ---------------------------------------------------------------- Pantone

section('Pantone 色票管理');
{
  const color = { code: 'TEST-01', name: '測試色', colorType: 'TPX', r: 170, g: 187, b: 204, c: 12.5, labL: 75.123 };
  const added = await call('POST', '/api/admin/pantone', color);
  ok('可新增色票，hex 由 RGB 換算', added.status === 201 && added.body?.hex === '#aabbcc'
    && added.body?.c === 12.5 && added.body?.labL === 75.123, JSON.stringify(added.body));

  const search = await call('GET', '/api/admin/pantone?keyword=TEST-01');
  ok('可依色號搜尋', search.body?.items?.[0]?.id === added.body?.id, JSON.stringify(search.body?.items?.[0]));

  const badRgb = await call('POST', '/api/admin/pantone', { code: 'TEST-02', r: 256, g: 0, b: 0 });
  ok('RGB 超出範圍被擋', badRgb.status === 400, JSON.stringify(badRgb.body));

  const dupCode = await call('POST', '/api/admin/pantone', { code: 'TEST-01', colorType: 'TPX', r: 0, g: 0, b: 0 });
  ok('同系列色號重複被擋', dupCode.status === 409, JSON.stringify(dupCode.body));

  // 10/22：不同系列會有相同色號
  const otherSeries = await call('POST', '/api/admin/pantone', { code: 'TEST-01', colorType: 'TPG', r: 0, g: 0, b: 0 });
  ok('不同系列可有相同色號', otherSeries.status === 201, JSON.stringify(otherSeries.body));

  const moveSeries = await call('PUT', `/api/admin/pantone/${otherSeries.body?.id}`, { colorType: 'TPX', r: 0, g: 0, b: 0 });
  ok('改系列後與同系列撞號被擋', moveSeries.status === 409, JSON.stringify(moveSeries.body));

  const batch = await call('POST', '/api/admin/pantone/batch-delete', { ids: [otherSeries.body?.id, 999999] });
  ok('批次刪除：能刪的刪、不存在的逐筆回報',
    batch.body?.deleted === 1 && batch.body?.failed?.[0]?.id === 999999, JSON.stringify(batch.body));

  const edited = await call('PUT', `/api/admin/pantone/${added.body.id}`, {
    code: 'CHANGED', name: '改過的名字', colorType: 'TPX', r: 17, g: 34, b: 51,
  });
  ok('可編輯色票，色號不可變更', edited.body?.hex === '#112233' && edited.body?.name === '改過的名字'
    && edited.body?.code === 'TEST-01', JSON.stringify(edited.body));

  const scoped = await call('PUT', `/api/admin/pantone/${added.body.id}`, { ...color, scopeType: 'customers', customerIds: [] });
  ok('指定客戶未選任何客戶被擋', scoped.status === 400, JSON.stringify(scoped.body));

  const removed = await call('DELETE', `/api/admin/pantone/${added.body.id}`);
  ok('可刪除色票', removed.status === 204, removed.status);
}

// ---------------------------------------------------------------- 前台可見性

section('前台取用（適用對象過濾）');
{
  const adminToken = token;

  const allSpecs = await call('GET', '/api/weave-specs');
  const f0001 = allSpecs.body?.find((s) => s.code === 'F-0001');
  ok('前台組織規格帶出設計尺寸與編碼',
    f0001?.designWidthCm === 3.965 && f0001?.fabricTypeCode && f0001?.weaveCode,
    JSON.stringify([f0001?.designWidthCm, f0001?.fabricTypeCode, f0001?.weaveCode]));
  ok('前台組織規格依 .u3m 對應出貼圖通道',
    f0001?.u3m?.textures?.base?.startsWith('/api/files/') && f0001?.u3m?.textures?.nrm
      && f0001.u3m.packageEntries.some((e) => e.path === 'textures/F-0001_BASE.jpg'),
    JSON.stringify(f0001?.u3m));

  const privateColor = await call('POST', '/api/admin/pantone', {
    code: 'ONLY-B', colorType: 'TPX', r: 1, g: 2, b: 3, scopeType: 'customers', customerIds: [customerB],
  });
  ok('新增客戶 B 專屬色票', privateColor.status === 201, JSON.stringify(privateColor.body));

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
  const colorsA = await call('GET', '/api/pantone');
  ok('客戶 A 看不到客戶 B 專屬色票', colorsA.status === 200 && !colorsA.body.some((c) => c.code === 'ONLY-B'));
  ok('OP 含量範圍一併回傳', options.body?.specRange?.opMax === 60, JSON.stringify(options.body?.specRange));

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
  // B 自己也有一個同名的「球體」，所以不能用名稱判斷，要看 id
  ok('客戶 B 看不到客戶 A 專屬的模型',
    modelsB.body?.every((m) => m.id !== modelAId),
    JSON.stringify(modelsB.body?.map((m) => `${m.id}:${m.name}`)));
  ok('客戶 B 看得到自己的同名模型與全域模型',
    modelsB.body?.length === 2 && modelsB.body.some((m) => m.name === '球體'),
    JSON.stringify(modelsB.body?.map((m) => m.name)));

  const specsB = await call('GET', '/api/weave-specs');
  ok('客戶 B 看不到客戶 A 專屬的組織規格', specsB.body?.length === 0, JSON.stringify(specsB.body?.length));

  const colorsB = await call('GET', '/api/pantone');
  ok('客戶 B 看得到自己的專屬色票', colorsB.body?.some((c) => c.code === 'ONLY-B'));

  const patternsB = await call('GET', '/api/patterns');
  ok('客戶 B 看得到自己的圖庫',
    patternsB.body?.items?.filter((p) => p.kind === 'customer').length === 1,
    JSON.stringify(patternsB.body?.items?.map((p) => p.kind)));

  const rangeB = await call('GET', '/api/options');
  ok('客戶 B 落回全域預設 50~400 / 0.05~1.5',
    rangeB.body?.specRange?.thicknessMax === 1.5, JSON.stringify(rangeB.body?.specRange));

  token = adminToken;
}

// ---------------------------------------------------------------- 紡織所 API

section('紡織所 API 轉發');
{
  const adminToken = token;
  const loginA = await call('POST', '/api/auth/login', { username: 'wang.min@xiaoyi.com', password: 'pass1234' });
  token = loginA.body.token;
  const els = (await call('GET', '/api/options')).body.elasticities;
  const fourWay = els.find((e) => e.name === '四向彈性');

  const spec = {
    weaveId, weight: 330, thickness: 0.6, opPercentage: 8, elasticityId: fourWay.id,
    compositions: [{ code: 'ZZ', percent: 30 }, { code: 'PES', percent: 70 }],
  };
  ttriCalls.length = 0;
  const vs = await call('POST', '/api/ttri/specs2vs', spec);
  ok('Specs2VS 回傳物性與建議布樣', vs.status === 200 && vs.body.sampleCode === '2-0000437'
    && vs.body.physics.BendRigidityWarp === 154.5, JSON.stringify(vs.body));
  const q = ttriCalls[0]?.query ?? {};
  ok('組織 id 轉成組織代碼、主成分取比例最高者',
    q.Product_ConstructionCode === 'PLAIN' && q.Product_YarnMaterial_1 === 'PES' && q.Product_YarnMaterial_1_Value === '70',
    JSON.stringify(q));
  ok('彈性名稱對應到 StretchDirection', q.Product_StretchDirection === '4 way stretch', JSON.stringify(q));
  ok('token 由後端補上', ttriCalls[0]?.auth === 'Bearer fake-ttri-token');
  ok('成分轉成英文組成描述', vs.body.compositionText === '70%Polyester, 30%Cotton', vs.body.compositionText);

  const outOfRange = await call('POST', '/api/ttri/specs2vs', { ...spec, weight: 5 });
  ok('超出紡織所輸入範圍被擋', outOfRange.status === 400, JSON.stringify(outOfRange.body));
  const badComp = await call('POST', '/api/ttri/specs2vs', { ...spec, compositions: [{ code: 'NOPE', percent: 100 }] });
  ok('不存在的成分被擋', badComp.status === 400, JSON.stringify(badComp.body));

  ttriCalls.length = 0;
  const built = await call('POST', '/api/ttri/u3m', {
    weaveId, compositionText: vs.body.compositionText, physics: vs.body.physics,
  });
  ok('buildU3M 後取回 physics 與 u3m', built.status === 200 && built.body.physics?.custom && built.body.u3m?.material,
    JSON.stringify(built.body));
  ok('依序打 buildU3M、downloadFILE ×2',
    ttriCalls.map((c) => `${c.path}:${c.query.filename ?? ''}`).join() === `/buildU3M:,/downloadFILE:${built.body.id}.json,/downloadFILE:${built.body.id}.u3m`,
    JSON.stringify(ttriCalls.map((c) => c.path)));
  ok('buildU3M 不封裝貼圖、帶入物性', ttriCalls[0]?.query.withTextures === 'false'
    && ttriCalls[0]?.query.MassDensity === '330' && ttriCalls[0]?.query.Construction === 'PLAIN', JSON.stringify(ttriCalls[0]?.query));

  const missing = await call('POST', '/api/ttri/u3m', { weaveId, physics: { MassDensity: 330 } });
  ok('物性欄位不齊被擋', missing.status === 400, JSON.stringify(missing.body));

  const { config } = await import('../src/config.js');
  config.ttri.token = 'wrong-token';
  const denied = await call('POST', '/api/ttri/specs2vs', spec);
  ok('紡織所拒絕時回 502（不能回 401，否則前台會被登出）', denied.status === 502, JSON.stringify(denied.body));
  config.ttri.token = 'fake-ttri-token';

  token = adminToken;
}

// ---------------------------------------------------------------- 10/22 調整

section('停用（組織規格／背景）、客戶停用與刪除');
{
  const adminToken = token;
  const asCustomerA = async (path) => {
    const login = await call('POST', '/api/auth/login', { username: 'wang.min@xiaoyi.com', password: 'pass1234' });
    token = login.body?.token ?? '';
    const res = await call('GET', path);
    token = adminToken;
    return res;
  };

  const specOff = await call('PUT', `/api/admin/weave-specs/${weaveSpecId}/active`, { isActive: false });
  ok('組織規格可停用', specOff.body?.isActive === false, JSON.stringify(specOff.body?.isActive));
  ok('停用的組織規格前台看不到', (await asCustomerA('/api/weave-specs')).body?.length === 0);
  const listed = await call('GET', '/api/admin/weave-specs');
  ok('停用的組織規格後台仍看得到', listed.body?.items?.some((s) => s.id === weaveSpecId && s.isActive === false));
  await call('PUT', `/api/admin/weave-specs/${weaveSpecId}/active`, { isActive: true });

  const bgs = await call('GET', '/api/admin/backgrounds');
  const bgId = bgs.body?.items?.[0]?.id;
  const bgOff = await call('PUT', `/api/admin/backgrounds/${bgId}/active`, { isActive: false });
  ok('背景可停用', bgOff.body?.isActive === false, JSON.stringify(bgOff.body));
  ok('停用的背景前台看不到', (await asCustomerA('/api/backgrounds')).body?.length === 0);
  await call('PUT', `/api/admin/backgrounds/${bgId}/active`, { isActive: true });

  // 已登入的使用者先拿好 token，驗證停用後舊 token 也會被擋
  const login = await call('POST', '/api/auth/login', { username: 'wang.min@xiaoyi.com', password: 'pass1234' });
  const userToken = login.body.token;
  await call('PUT', `/api/admin/customers/${customerA}/active`, { isActive: false });
  const blockedLogin = await call('POST', '/api/auth/login', { username: 'wang.min@xiaoyi.com', password: 'pass1234' });
  ok('公司停用後底下帳號無法登入', blockedLogin.status === 403, JSON.stringify(blockedLogin.body));
  token = userToken;
  const blockedToken = await call('GET', '/api/options');
  token = adminToken;
  ok('公司停用後已登入的 token 也被擋', blockedToken.status === 403, JSON.stringify(blockedToken.body));
  await call('PUT', `/api/admin/customers/${customerA}/active`, { isActive: true });

  const blocked = await call('DELETE', `/api/admin/customers/${customerA}`);
  ok('有帳號等關聯資料的公司不得刪除', blocked.status === 400 && /帳號/.test(blocked.body?.error),
    JSON.stringify(blocked.body));

  const empty = await call('POST', '/api/admin/customers', { name: '建錯的公司', taxId: '99999999' });
  const batch = await call('POST', '/api/admin/customers/batch-delete', { ids: [empty.body.id, customerA] });
  ok('批次刪除公司：無關聯的刪除、有關聯的回報原因',
    batch.body?.deleted === 1 && batch.body?.failed?.length === 1 && batch.body.failed[0].id === customerA,
    JSON.stringify(batch.body));

  const badBatch = await call('POST', '/api/admin/customers/batch-delete', { ids: [] });
  ok('批次刪除未選任何資料被擋', badBatch.status === 400, JSON.stringify(badBatch.body));
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
ttriServer.close();
process.exit(failed === 0 ? 0 : 1);
