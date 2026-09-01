// cPanel（Phusion Passenger）的啟動檔。
//
// Passenger 以 require() 載入啟動檔，而本專案是 ESM（package.json 的 type: module），
// 因此這裡用 CommonJS 包一層，再以動態 import 進入 src/server.js。
//
// Passenger 會自行決定監聽位址，PORT 由它以環境變數傳入；
// HOST 預設的 127.0.0.1 在容器內會擋掉外部連線，故在此覆寫。

process.env.HOST = process.env.HOST || '0.0.0.0';

import('./src/server.js')
  .then((mod) => mod.start())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
