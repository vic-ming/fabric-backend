-- 織物智慧生成系統 — 後台資料表
-- 依 TTRI-織物智慧生成系統規格書 v1.2 (VJ260601) 第六章【管理者後台】
--
-- 「適用對象」在規格書中重複出現於七個模組（布樣種類、組織、成分、彈性、
-- 組織規格、背景、3D 模型），語意完全一致：全域 或 指定一至多個客戶。
-- 因此以 scope_type 欄位 + scope_customers 這張共用關聯表表達，
-- 而不是每個模組各長一張 junction table。

-- ---------------------------------------------------------------- 檔案

-- 所有上傳檔案的統一登錄處。實體檔案由 storage driver 依 storage_key 存取
-- （開發為本機 uploads/，正式為 GCS），資料庫只留 metadata。
create table if not exists files (
  id            serial primary key,
  storage_key   text        not null unique,
  original_name text        not null,
  mime_type     text        not null default 'application/octet-stream',
  byte_size     bigint      not null default 0,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------- 客戶 / 帳號

-- 規格書 6-(1) 客戶管理 / 圖表 8
create table if not exists customers (
  id              serial primary key,
  name            varchar(50)  not null,
  tax_id          varchar(50)  not null unique,   -- 統一編號，新增時不可重複、編輯時不可修改
  contact_name    varchar(50),
  contact_phone   varchar(50),
  contact_address varchar(100),
  contact_email   varchar(50),
  created_at      timestamptz  not null default now(),
  updated_at      timestamptz  not null default now()
);

-- 規格書 6-(2) 帳號管理 / 圖表 10
-- customer_id 為 NULL 代表「系統管理者」，即後台管理員帳號。
create table if not exists accounts (
  id            serial primary key,
  customer_id   integer     references customers(id) on delete restrict,
  username      varchar(50) not null unique,      -- 建立後不可變更
  display_name  varchar(50) not null,
  password_hash text        not null,
  valid_from    date        not null,
  valid_to      date        not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint accounts_valid_range check (valid_to >= valid_from)
);

create index if not exists accounts_customer_idx on accounts (customer_id);

-- ---------------------------------------------------------------- 適用對象

-- 供所有「適用對象 = 指定客戶」的模組共用。
-- entity_type 對應下方各資料表的邏輯名稱；刪除主體時由 app 層一併清除。
create table if not exists scope_customers (
  entity_type text    not null,
  entity_id   integer not null,
  customer_id integer not null references customers(id) on delete cascade,
  primary key (entity_type, entity_id, customer_id)
);

create index if not exists scope_customers_lookup_idx
  on scope_customers (entity_type, customer_id);

-- ---------------------------------------------------------------- 選項參數管理

-- 規格書 6-(3) 選項參數管理 — 布樣種類 / 圖表 12
create table if not exists fabric_types (
  id         serial primary key,
  name       varchar(50) not null unique,          -- 建立後不可變更、不得重複
  scope_type text        not null default 'global'
             check (scope_type in ('global', 'customers')),
  sort_order integer     not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 選項參數管理 — 組織 / 圖表 14
-- 組織隸屬於一個布樣種類；前台「布樣種類會影響可選組織清單」即依此欄位篩選。
create table if not exists weaves (
  id             serial primary key,
  name           varchar(50) not null unique,
  fabric_type_id integer     not null references fabric_types(id) on delete restrict,
  scope_type     text        not null default 'global'
                 check (scope_type in ('global', 'customers')),
  sort_order     integer     not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists weaves_fabric_type_idx on weaves (fabric_type_id);

-- 選項參數管理 — 成分 / 圖表 16
-- category 為圖表 15 清單所顯示的「分類」（天然纖維／合成纖維…）。
-- 圖表 16 的欄位表未列出此欄，已在 docs 中列為待客戶確認項。
create table if not exists compositions (
  id         serial primary key,
  code       varchar(50) not null unique,          -- 編號，建立後不可變更
  name_en    varchar(50) not null,
  name_zh    varchar(50) not null,
  category   varchar(50),
  scope_type text        not null default 'global'
             check (scope_type in ('global', 'customers')),
  sort_order integer     not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 選項參數管理 — 彈性 / 圖表 18
create table if not exists elasticities (
  id         serial primary key,
  name       varchar(50) not null unique,
  scope_type text        not null default 'global'
             check (scope_type in ('global', 'customers')),
  sort_order integer     not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- 布厚布重範圍

-- 規格書 6-(4) / 圖表 19-21
-- customer_id 為 NULL 的那一列即「全域預設」，全表僅能有一列；
-- 其餘每個客戶至多一列（規格書：唯每個客戶只能被獨立設定一組）。
create table if not exists spec_ranges (
  id             serial primary key,
  customer_id    integer references customers(id) on delete cascade,
  weight_min     numeric(6,2) not null default 43.00,
  weight_max     numeric(6,2) not null default 527.00,
  weight_unit    varchar(50)  not null default 'g/m2',
  thickness_min  numeric(6,2) not null default 0.01,
  thickness_max  numeric(6,2) not null default 3.40,
  thickness_unit varchar(50)  not null default 'mm',
  created_at     timestamptz  not null default now(),
  updated_at     timestamptz  not null default now(),
  constraint spec_ranges_weight_range    check (weight_max    >= weight_min),
  constraint spec_ranges_thickness_range check (thickness_max >= thickness_min),
  constraint spec_ranges_weight_bounds    check (weight_min    >= 0.01 and weight_max    <= 999),
  constraint spec_ranges_thickness_bounds check (thickness_min >= 0.01 and thickness_max <= 999)
);

create unique index if not exists spec_ranges_customer_uniq
  on spec_ranges (customer_id) where customer_id is not null;
create unique index if not exists spec_ranges_global_uniq
  on spec_ranges ((customer_id is null)) where customer_id is null;

-- ---------------------------------------------------------------- 印花管理

-- 規格書 6-(5) / 圖表 22-23
-- 印花的歸屬方式與其他模組不同：不是「全域／指定客戶」，
-- 而是二選一的 kind — 一般分類（歸在某個預設分類下，所有人可見）
-- 或 客戶圖庫（歸屬單一客戶，一次僅能單選一個客戶）。
create table if not exists pattern_categories (
  id         serial primary key,
  name       varchar(50) not null unique,
  sort_order integer     not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists patterns (
  id          serial primary key,
  kind        text        not null check (kind in ('general', 'customer')),
  category_id integer     references pattern_categories(id) on delete restrict,
  customer_id integer     references customers(id) on delete cascade,
  name        varchar(255) not null,               -- 未填寫則以上傳檔名為預設；允許重複
  file_id     integer     not null references files(id) on delete restrict,
  -- 實際公分尺寸：3D 貼圖重複次數 = 模型公分尺寸 ÷ 圖案實際公分尺寸。
  -- 客戶交付的 15 張內建圖案未附此資訊，於後台補登。
  physical_width_cm  numeric(8,3),
  physical_height_cm numeric(8,3),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint patterns_kind_target check (
    (kind = 'general'  and category_id is not null and customer_id is null) or
    (kind = 'customer' and customer_id is not null and category_id is null)
  )
);

create index if not exists patterns_general_idx  on patterns (kind, category_id);
create index if not exists patterns_customer_idx on patterns (kind, customer_id);

-- ---------------------------------------------------------------- 組織規格管理

-- 規格書 6-(6) / 圖表 24-25
create table if not exists weave_specs (
  id                serial primary key,
  code              varchar(50)  not null unique,  -- 編號，建立後不可變更
  fabric_type_id    integer      not null references fabric_types(id) on delete restrict,
  weave_id          integer      not null references weaves(id)       on delete restrict,
  weight            numeric(6,2) not null,         -- 布重 0~999.99
  thickness         numeric(6,2) not null,         -- 布厚 0~999.99
  density           varchar(100),                  -- 經緯密度
  finishing         varchar(100),                  -- 後整理
  preview_file_id   integer      not null references files(id) on delete restrict,
  scope_type        text         not null default 'global'
                    check (scope_type in ('global', 'customers')),
  created_at        timestamptz  not null default now(),
  updated_at        timestamptz  not null default now(),
  constraint weave_specs_weight_bounds    check (weight    >= 0 and weight    <= 999.99),
  constraint weave_specs_thickness_bounds check (thickness >= 0 and thickness <= 999.99)
);

-- 成分組成，合計須為 100%
create table if not exists weave_spec_compositions (
  weave_spec_id  integer      not null references weave_specs(id)  on delete cascade,
  composition_id integer      not null references compositions(id) on delete restrict,
  percent        numeric(6,2) not null check (percent > 0 and percent <= 100),
  primary key (weave_spec_id, composition_id)
);

-- 組織資料（3D 建模檔案），可上傳多個、不限格式
create table if not exists weave_spec_files (
  weave_spec_id integer not null references weave_specs(id) on delete cascade,
  file_id       integer not null references files(id)       on delete restrict,
  sort_order    integer not null default 0,
  primary key (weave_spec_id, file_id)
);

-- ---------------------------------------------------------------- 背景 / 3D 模型

-- 規格書 6-(7) / 圖表 26-27
create table if not exists backgrounds (
  id         serial primary key,
  name       varchar(50) not null unique,          -- 不得重複
  file_id    integer     not null references files(id) on delete restrict,
  scope_type text        not null default 'global'
             check (scope_type in ('global', 'customers')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 規格書 6-(8) / 圖表 28-29
create table if not exists models_3d (
  id         serial primary key,
  name       varchar(50) not null unique,          -- 不得重複
  file_id    integer     not null references files(id) on delete restrict,
  scope_type text        not null default 'global'
             check (scope_type in ('global', 'customers')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
