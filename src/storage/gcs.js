// Google Cloud Storage driver。
// 正式環境啟用時需 npm i @google-cloud/storage，並設定 GCS_BUCKET 與服務帳號憑證
// （GCP 上跑在 Cloud Run / GCE 時可直接用預設憑證，不必掛金鑰檔）。

import { config } from '../config.js';

export function createGcsStorage() {
  let bucket = null;

  return {
    kind: 'gcs',
    async init() {
      if (!config.gcsBucket) throw new Error('STORAGE_DRIVER=gcs 需同時設定 GCS_BUCKET');
      const { Storage } = await import('@google-cloud/storage');
      bucket = new Storage().bucket(config.gcsBucket);
    },
    async put(key, buffer) {
      await bucket.file(key).save(buffer, { resumable: false });
      return { key, size: buffer.length };
    },
    async stream(key) {
      return bucket.file(key).createReadStream();
    },
    async remove(key) {
      await bucket.file(key).delete({ ignoreNotFound: true });
    },
    publicUrl(key) {
      return `/api/files/${key}`;
    },
  };
}
