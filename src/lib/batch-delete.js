// 批次刪除（10/22 客戶要求：所有可刪除的獨立項目列表都要能多選刪除）。
//
// 各模組的單筆刪除都有自己的檢查（被引用就不得刪、全域預設不可刪…），
// 批次刪除不另寫一套，而是逐筆呼叫同一支 deleteOne，規則自然一致。
//
// 與批次匯入同一個原則：能刪的照刪，刪不掉的逐筆回報原因，不整批回滾
// （客戶 10/22 確認）。

import { badRequest } from './errors.js';
import { requireIdArray } from './validate.js';

const MAX_BATCH = 500;

/**
 * 註冊 POST {basePath}/batch-delete，body 為 { ids: number[] }。
 * @param deleteOne async (id, request) => void；不得刪除時丟出例外，訊息會原樣回報
 * @returns {{ deleted: number, failed: { id, error }[] }}
 */
export function registerBatchDelete(app, basePath, deleteOne) {
  app.post(`${basePath}/batch-delete`, async (request) => {
    const ids = requireIdArray(request.body?.ids, '刪除項目');
    if (ids.length === 0) throw badRequest('請至少選擇一筆要刪除的資料');
    if (ids.length > MAX_BATCH) throw badRequest(`一次最多刪除 ${MAX_BATCH} 筆`);

    const result = { deleted: 0, failed: [] };
    for (const id of ids) {
      try {
        await deleteOne(id, request);
        result.deleted += 1;
      } catch (error) {
        result.failed.push({ id, error: error.message ?? String(error) });
      }
    }
    return result;
  });
}
