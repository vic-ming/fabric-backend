// 紡織所（TTRI）TandemTex API 連線。
//
// token 綁定單一帳號、API 只有 http，所以只能由本服務補上 token 後轉發，
// 瀏覽器永遠拿不到 token。文件規定請求間隔 1 秒、每分鐘最多 30 次（超過會被暫停），
// 這裡把所有呼叫排成一列依序送出，同一時間只會有一個請求在路上。

import { config } from '../config.js';
import { HttpError } from './errors.js';

const TIMEOUT_MS = 60_000;
// 排隊太長就直接拒絕，免得使用者等好幾分鐘才失敗
const MAX_QUEUE = 20;

let queue = Promise.resolve();
let waiting = 0;
let lastSentAt = 0;
const sentAt = [];   // 最近一分鐘內送出的時間

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForSlot() {
  const { minIntervalMs, rateLimitPerMin } = config.ttri;
  for (;;) {
    const now = Date.now();
    while (sentAt.length && now - sentAt[0] >= 60_000) sentAt.shift();
    const byInterval = lastSentAt + minIntervalMs - now;
    const byWindow = sentAt.length >= rateLimitPerMin ? sentAt[0] + 60_000 - now : 0;
    const wait = Math.max(byInterval, byWindow);
    if (wait <= 0) break;
    await sleep(wait);
  }
  lastSentAt = Date.now();
  sentAt.push(lastSentAt);
}

function upstreamError(message, details) {
  // 一律回 502：前台把 401/403 當成「自己的登入失效」，不能混用
  return new HttpError(502, message, details);
}

async function send(path, params) {
  const { baseUrl, token } = config.ttri;
  if (!baseUrl || !token) throw new HttpError(503, '尚未設定紡織所 API（TTRI_API_BASE_URL / TTRI_API_TOKEN）');

  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  let response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? '逾時' : '連線失敗';
    // 底層原因（ECONNREFUSED、EHOSTUNREACH…）一併帶出，才分得出是主機擋對外連線還是對方沒開
    const cause = error.cause?.code ?? error.cause?.message ?? error.message;
    throw upstreamError(`紡織所 API ${reason}（${path}）`, { cause });
  }

  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 300);
    try { detail = JSON.parse(text).detail ?? detail; } catch { /* 不是 JSON 就照原文 */ }
    const message = response.status === 401 || response.status === 403
      ? '紡織所 API 授權失敗，請確認 token'
      : `紡織所 API 回應錯誤（${path}，${response.status}）`;
    throw upstreamError(message, { status: response.status, detail });
  }
  return text;
}

/** 排隊送出一個 GET，回傳原始文字。 */
export function ttriGet(path, params = {}) {
  if (waiting >= MAX_QUEUE) {
    return Promise.reject(new HttpError(429, '紡織所 API 目前排隊的請求太多，請稍後再試'));
  }
  waiting += 1;
  const run = queue.then(async () => {
    await waitForSlot();
    return send(path, params);
  });
  // 前一個失敗不能卡住後面的人
  queue = run.catch(() => {});
  return run.finally(() => { waiting -= 1; });
}

export async function ttriGetJson(path, params) {
  const text = await ttriGet(path, params);
  try {
    return JSON.parse(text);
  } catch {
    throw upstreamError(`紡織所 API 回傳的不是 JSON（${path}）`);
  }
}
