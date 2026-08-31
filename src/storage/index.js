// 檔案儲存抽象層。
// 開發走本機磁碟，正式環境把 STORAGE_DRIVER 換成 gcs 即可，
// 呼叫端（routes）只認得 put / get / remove / publicUrl 這四個方法。

import { config } from '../config.js';

let driver = null;

export async function initStorage() {
  if (driver) return driver;
  driver = config.storageDriver === 'gcs'
    ? (await import('./gcs.js')).createGcsStorage()
    : (await import('./local.js')).createLocalStorage();
  await driver.init?.();
  return driver;
}

export function storage() {
  if (!driver) throw new Error('儲存層尚未初始化，請先呼叫 initStorage()');
  return driver;
}

/** 產生不會碰撞的儲存路徑，保留原副檔名方便人工檢視。 */
export function buildStorageKey(folder, originalName) {
  const dot = originalName.lastIndexOf('.');
  const ext = dot > 0 ? originalName.slice(dot).toLowerCase() : '';
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${folder}/${stamp}-${rand}${ext}`;
}
