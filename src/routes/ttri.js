// 前台呼叫紡織所 API 的轉發端點（登入即可使用）。
//
// 流程依《TandemTex API Document_20261001_for VJINC.xlsx》：
//   1. Specs2VS     — 送布料規格，取得相近的 FAB 物性與建議布樣編號
//   2. buildU3M     — 送物性，紡織所在 u3ma/{id}/ 產生 {id}.json（physics）與 {id}.u3m（模板）
//   3. downloadFILE — 一次只能取一個檔，json 與 u3m 各打一次
// 貼圖由我們自己維護（withTextures=false），前台再把 u3m 裡的貼圖路徑換成後台的 VIZOO 素材。
//
// 組織、成分都由前台傳 id／編號，在這裡轉成紡織所的代碼，並確認登入者看得到。

import { one, many } from '../db/index.js';
import { authenticate } from '../lib/auth.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { ENTITY } from '../lib/scope.js';
import { ttriGetJson } from '../lib/ttri.js';
import { visible } from './public.js';

// Specs2VS 的輸入範圍（Schema_Specs2VS），超出紡織所會拒絕
const LIMITS = {
  weight: [10, 1000, '布重'],
  thickness: [0.01, 10, '布厚'],
  opPercentage: [0, 100, 'OP 含量'],
};

// buildU3M 必填的物性欄位，值直接取自 Specs2VS 的輸出
const PHYSICS_FIELDS = [
  'MassDensity', 'Thickness',
  'BendRigidityWarp', 'BendRigidityWeft',
  'StretchRigidityWarp', 'StretchRigidityWeft', 'StretchRigidityShear',
  'StretchLinearityWarp', 'StretchLinearityWeft', 'StretchLinearityShear',
];

// Product_StretchDirection 只接受這四個值；後台彈性選項是客戶自訂的，認得出來才送
const STRETCH_DIRECTIONS = [
  [/non|無彈|不彈/i, 'Non-stretch'],
  [/4\s*way|四向|四面/i, '4 way stretch'],
  [/2\s*way|雙向|二向|兩向/i, '2 way stretch'],
  [/1\s*way|單向|一向/i, '1 way stretch'],
];

function number(value, [min, max, label]) {
  const n = Number(value);
  if (value === '' || value === null || !Number.isFinite(n) || n < min || n > max) {
    throw badRequest(`${label}需介於 ${min} ~ ${max}`);
  }
  return n;
}

function scopeParams(request) {
  const cid = request.user.customerId;
  return cid === null ? { cid, params: [], p: 0 } : { cid, params: [cid], p: 1 };
}

async function weaveCode(request, weaveId) {
  const { cid, params, p } = scopeParams(request);
  const row = await one(
    `select w.code from weaves w where w.id = $${p + 1} and ${visible(ENTITY.weave, 'w', cid, p)}`,
    [...params, Number(weaveId)],
  );
  if (!row?.code) throw badRequest('找不到此組織');
  return row.code;
}

/** 成分依比例由高到低，附上英文名稱（buildU3M 的 Composition 用英文）。 */
async function resolveCompositions(request, list) {
  const rows = (Array.isArray(list) ? list : [])
    .map((c) => ({ code: String(c?.code ?? '').trim(), percent: Number(c?.percent) }))
    .filter((c) => c.code && c.percent > 0);
  if (!rows.length) return [];

  const { cid, params, p } = scopeParams(request);
  const known = await many(
    `select c.code, c.name_en from compositions c
      where c.code = any($${p + 1}) and ${visible(ENTITY.composition, 'c', cid, p)}`,
    [...params, rows.map((r) => r.code)],
  );
  const names = new Map(known.map((k) => [k.code, k.name_en]));
  const missing = rows.filter((r) => !names.has(r.code)).map((r) => r.code);
  if (missing.length) throw badRequest(`找不到成分：${missing.join('、')}`);

  return rows
    .map((r) => ({ ...r, nameEn: names.get(r.code) }))
    .sort((a, b) => b.percent - a.percent);
}

async function stretchDirection(request, elasticityId) {
  if (!elasticityId) return undefined;
  const { cid, params, p } = scopeParams(request);
  const row = await one(
    `select e.code, e.name from elasticities e where e.id = $${p + 1} and ${visible(ENTITY.elasticity, 'e', cid, p)}`,
    [...params, Number(elasticityId)],
  );
  if (!row) return undefined;
  const text = `${row.code} ${row.name}`;
  return STRETCH_DIRECTIONS.find(([pattern]) => pattern.test(text))?.[1];
}

// 同一個 id 再 buildU3M 會蓋掉紡織所那邊的檔案，所以每次都產生新的
function buildId(user) {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 17);
  return `VJINC${user.id}T${stamp}`;
}

export default async function ttriRoutes(app) {
  app.addHook('preHandler', authenticate);

  /** 送規格，取得物性與建議布樣編號。 */
  app.post('/api/ttri/specs2vs', async (request) => {
    const body = request.body ?? {};
    const construction = await weaveCode(request, body.weaveId);
    const compositions = await resolveCompositions(request, body.compositions);
    const yarn = compositions[0];

    const params = {
      Product_ConstructionCode: construction,
      Product_OP_Percentage: number(body.opPercentage ?? 0, LIMITS.opPercentage),
      Product_WeightGSM: number(body.weight, LIMITS.weight),
      Product_T: number(body.thickness, LIMITS.thickness),
      Product_StretchDirection: await stretchDirection(request, body.elasticityId),
      Product_YarnMaterial_1: yarn?.code,
      Product_YarnMaterial_1_Value: yarn?.percent,
      algorithm: 'Matched',
    };
    const result = await ttriGetJson('Specs2VS', params);

    const physics = {};
    for (const field of PHYSICS_FIELDS) physics[field] = result[field];
    return {
      sampleCode: result.SampleCode ?? null,
      name: result.Name ?? null,
      construction,
      compositionText: compositions.map((c) => `${c.percent}%${c.nameEn}`).join(', '),
      physics,
    };
  });

  /** 依 Specs2VS 的物性產生 u3m 模板與 physics json。 */
  app.post('/api/ttri/u3m', async (request) => {
    const body = request.body ?? {};
    const construction = await weaveCode(request, body.weaveId);
    const physics = body.physics ?? {};
    const values = {};
    for (const field of PHYSICS_FIELDS) {
      const n = Number(physics[field]);
      if (physics[field] === null || physics[field] === '' || !Number.isFinite(n)) {
        throw badRequest(`物性欄位 ${field} 缺少或不是數字`);
      }
      values[field] = n;
    }
    const composition = String(body.compositionText ?? '').slice(0, 200);

    const id = buildId(request.user);
    const listing = await ttriGetJson('buildU3M', {
      id, withTextures: false, Construction: construction, Composition: composition, ...values,
    });
    const built = Object.values(listing ?? {}).flat();
    for (const name of [`${id}.json`, `${id}.u3m`]) {
      if (!built.includes(name)) throw new HttpError(502, `紡織所未產生 ${name}`, listing);
    }

    // downloadFILE 一次一個檔
    const dirname = `u3ma/${id}`;
    const physicsFile = await ttriGetJson('downloadFILE', { dirname, filename: `${id}.json` });
    const u3mFile = await ttriGetJson('downloadFILE', { dirname, filename: `${id}.u3m` });
    return { id, physics: physicsFile, u3m: u3mFile };
  });
}
