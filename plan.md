# ScpCraft 跨平台重構開發計畫書 (Master Plan)

> **當前進度摘要 (Current Status)**
> - **最新完成**：**Phase 0 ~ Phase 6 全部完成（含 6.1, 6.2 & 6.3）**（統一協定抽象層 `src-tauri/src/fs_trait.rs` (`RemoteFileSystem` Trait 與 `AnyRemoteFs`)、`src-tauri/src/protocols/ftp.rs` (FTP / MLSD / Unix & DOS LIST / PASV & EPSV / STOR / RETR / SITE CHMOD) 與 `src-tauri/src/protocols/opendal_fs.rs` (Amazon S3 / MinIO AWS4-HMAC-SHA256 SigV4 & `ListObjectsV2` XML + WebDAV `PROPFIND`/CRUD)，透過 `SftpSessionManager::get_remote_fs` 串通瀏覽、CRUD、F4 編輯器、多工作緒傳輸佇列、目錄同步、Keep Up to Date 與 `Alt+F7` 搜尋；跨平台原生選單與工具后端 `src-tauri/src/menu.rs`（`app_preferences_*`、`app_cleanup_*`、`site_generate_url_bundle`）、繁中/英文雙語系切換 `src/i18n/index.ts`、`PreferencesModal.tsx`、`CleanupModal.tsx`、`GenerateUrlModal.tsx` 與 Retina/High-DPI 字體微調；`tauri.conf.json` 三平台打包設定與 `.github/workflows/release.yml` Windows/macOS Universal/Linux GitHub Actions 流水線；`cargo test` 31 passed、`pnpm build` 通過）。
> - **下一步**：可視需要執行 `pnpm tauri dev` 或 `pnpm tauri build`（或推送 Git Tag `v*` 觸發三平台 Release Workflow）進行實機端點整合與安裝檔驗證。
> - **環境**：Rust 1.100.0、Node 26.13.1、pnpm 12.21.0、Tauri CLI 2.12.4、WebView2 157；專案位於 E:\Workspace\ScpCraft。
> - **已驗證項目**：Phase 0–6 全部 31 項 Rust 單元與 Loopback 整合測試（含 FTP PASV/EPSV/MLSD/LIST 解析與 Loopback CRUD、AWS SigV4 簽章與 S3 ListObjectsV2 XML、WebDAV PROPFIND XML 與 Loopback CRUD、Preferences 讀寫與清理檢查、Session URL/Batch/PowerShell/C#/Rust 產生器）全數通過 `cargo test --manifest-path src-tauri/Cargo.toml`（31 passed, 0 failed）；前端 `pnpm build`（`tsc && vite build`）通過。
---

## 1. 專案概述與核心目標 (Project Overview)

* **專案名稱**：`ScpCraft`
* **核心目標**：以乾淨室／逆向分析方式，將 Windows 專屬的經典開源工具 **WinSCP 6.7.1** 重新打造為現代化、輕量且高效能的原生跨平台檔案傳輸客戶端。
* **目標平台**：
  * **Windows** (`x64` / `ARM64` — `.msi` / `.exe`)
  * **macOS** (`Apple Silicon` + `Intel` Universal — `.dmg` / `.app`)
  * **Linux** (`x64` / `ARM64` — `.deb` / `.AppImage`)
* **參考標的**：
  * 主程式：`E:\Workspace\ScpCraft\WinSCP-6.7.1\WinSCP.exe`
  * 命令列介面：`E:\Workspace\ScpCraft\WinSCP-6.7.1\WinSCP.com`
* **CraftAnything 調查記憶庫**：`E:\Workspace\ScpCraft\scpcraft.cany`
  * 已記錄證據 ID：`ev_9fec332783757bdaac7a209a0e5e6bcb5f82740c34f6e9e4eb723dd48abedc6d` (`core_target_triage`)、`ev_d7c1ceb4978053fc690f338e47ed1dd6561f55108cb37477c02c7ff352b6225b` (`native_pe_resources_list`)、`ev_7017de7b59a8739c66ed4528870ee062b54706a9e3f1a9819a7921bd685e1dc9` (`runtime_ui_read`)、`ev_c43e2bdc19c596fe94b94de8f1f8230cf139b04fd702ae9ea65139456533d7e2` (`native_window_capture` Main)、`ev_9da29546833dffa05adc20b348a1985c2c637ed17ccf226ff7ac9b824a1491b1` (`native_window_capture` Login)

---

## 2. 技術堆疊設計 (Tech Stack Architecture — Tauri 2.0)

採用 **Tauri 2.0 (Rust + React/TypeScript)** 架構，兼具十餘 MB 極致輕量體積、低記憶體佔用與跨平台原生執行效率：

### 2.1 Core Shell
* **Tauri 2.0**：Rust 後端處理所有網路 I/O、安全認證與檔案系統操作；前端直接使用作業系統原生 WebView（Windows WebView2 / macOS WKWebView / Linux WebKitGTK）。

### 2.2 Frontend (Web UI)
* **核心框架**：`React 19` + `TypeScript` + `Vite`
* **UI 與樣式**：`TailwindCSS` + `Shadcn UI`（高密度桌面工具風格、支援亮色／暗色模式與縮放）
* **狀態管理**：`Zustand`（管理多分頁 Session、左右面板狀態、傳輸佇列與使用者偏好）
* **高效能列表**：`@tanstack/react-virtual`（虛擬捲動渲染，即使單一目錄有上萬個檔案也能保持 60fps 順暢捲動與選取）
* **內建編輯器與終端機**：`CodeMirror 6`（或 `Monaco`）作為遠端文字編輯器；`xterm.js` 作為互動式 SSH 終端機面板

### 2.3 Backend (Rust Crates)
* **非同步執行時與基礎庫**：`tokio`, `futures`, `serde`, `serde_json`, `tracing`
* **SSH / SFTP / SCP 引擎**：`russh`, `russh-sftp`, `russh-keys`
  * 純 Rust 非同步實作，徹底免除跨平台編譯 OpenSSL/libssh2 的環境痛點。
  * 支援密碼認證、OpenSSH Key、PuTTY `.ppk` 私鑰解析、SSH Agent / Pageant、Keyboard-Interactive (2FA)、SSH Tunnel 跳板機。
* **FTP / FTPS 引擎**：`suppaftp`（支援 Async Rustls TLS 加密連線）
* **S3 / WebDAV 引擎**：`opendal`（Apache OpenDAL 統一物件儲存與 WebDAV 抽象介面）
* **系統安全金鑰圈**：`keyring`（自動對接 Windows Credential Manager、macOS Keychain、Linux Secret Service）
* **檔案監控與同步**：`notify`（實作遠端編輯存檔自動上傳與 Keep Remote Directory Up to Date 即時同步）
* **設定相容層**：自訂 `WinSCP.ini` 雙向解析器（支援一鍵匯入 WinSCP 站台樹狀結構與密碼混淆解碼）

---

## 3. CraftAnything 逆向實證對照表 (WinSCP 6.7.1 Resource & Form Mapping)

經 `craft-anything-cli` 解析 `WinSCP.exe`（32-bit x86 Delphi/C++Builder VCL 執行檔），已清點出共 333 項 PE 資源，其中包含 **76 個 `RT_RCDATA` 表單與資源模組**。以下為核心功能在 `ScpCraft` 的模組對應：

| 功能分類 | WinSCP 6.7.1 VCL Form (`RT_RCDATA`) | ScpCraft 對應前端頁面／後端模組 |
| :--- | :--- | :--- |
| **主視窗與雙面板架構** | `TSCPCOMMANDERFORM` (雙面板 Commander)、`TSCPEXPLORERFORM` (單面板 Explorer)、`TCUSTOMSCPEXPLORERFORM` | `MainLayout` + `DualPaneView` / `ExplorerView`（支援快捷鍵切換雙模式） |
| **站台與認證管理** | `TLOGINDIALOG` (站台管理員)、`TSITEADVANCEDDIALOG` (進階站台設定)、`TAUTHENTICATEFORM` (Host Key / 2FA)、`TIMPORTSESSIONSDIALOG` | `SiteManagerModal` + `AdvancedSiteTabs` + `AuthPromptModal` + `ImportSessionsModal` / `config/winscp_ini.rs` |
| **傳輸參數與佇列進度** | `TCOPYDIALOG`、`TCOPYPARAMSFRAME`、`TCOPYPARAMCUSTOMDIALOG`、`TPROGRESSFORM`、`TREMOTETRANSFERDIALOG` | `TransferOptionsModal` + `TransferQueueDrawer` + `transfer/engine.rs` |
| **檔案屬性與權限編輯** | `TPROPERTIESDIALOG`、`TRIGHTSFRAME` (POSIX `rwxrwxrwx` / Octal)、`TCREATEDIRECTORYDIALOG`、`TSYMLINKDIALOG` | `PropertiesModal` + `PermissionsGrid` + `CreateDirModal` + `SymlinkModal` |
| **導航與路徑書籤** | `TOPENDIRECTORYDIALOG`、`TLOCATIONPROFILESDIALOG` | `OpenDirectoryModal` + `LocationBookmarks` |
| **目錄比對與自動同步** | `TSYNCHRONIZEDIALOG`、`TFULLSYNCHRONIZEDIALOG` (Keep Up to Date)、`TSYNCHRONIZECHECKLISTDIALOG`、`TSYNCHRONIZEPROGRESSFORM` | `SyncConfigModal` + `SyncChecklistModal` + `KeepUpToDateWatcher` (`sync/watcher.rs`) |
| **編輯器、終端與工具** | `TEDITORFORM`、`TEDITORPREFERENCESDIALOG`、`TCONSOLEDIALOG`、`TCUSTOMCOMMANDDIALOG`、`TFILEFINDDIALOG`、`TFILESYSTEMINFODIALOG`、`TGENERATEURLDIALOG` | `RemoteEditorModal` + `TerminalDrawer` (`xterm.js`) + `CustomCommands` + `RemoteFindModal` + `GenerateUrlModal` |
| **全域偏好與清理** | `TPREFERENCESDIALOG`、`TCLEANUPDIALOG`、`TEDITMASKDIALOG`、`TSELECTMASKDIALOG` | `PreferencesModal` + `CleanupModal` + `FileMaskSelector` |

---

## 4. 省 Token 開發規範與斷點續傳機制 (Token-Saving Workflow)

為確保大型跨平台專案在多輪對話開發下不超額消耗 Token 也不遺失上下文，開發全程嚴格遵守以下協作規範：

1. **單次推進粒度**：每次對話僅推進 **1 個子階段（Sub-phase）**，專注完成該階段的檔案撰寫與驗證。
2. **雙軌同步記憶**：每個子階段結束前，AI 必須依序完成三件事：
   * **編譯／測試驗證**：執行對應的檢查指令（`cargo check`、`pnpm build`、`cargo test` 等）確保零錯誤。
   * **更新本檔案 `plan.md`**：將完成的 Checkbox 改為 `[x]`，並更新檔頭的「當前進度摘要」。
   * **更新 CraftAnything 記憶庫 `scpcraft.cany`**：呼叫 `core-finding-record` 記錄新分析結論與 `core-handoff-write` 寫入最新交接摘要。
3. **新對話快速接續**：當開啟新對話視窗或執行 `/compact` 後，您只需要對 AI 輸入：
   > **「請讀取 `plan.md` 繼續下一個未完成的階段」**
   AI 即可直接讀取當前進度與 `.cany` Handoff，無須重頭解釋專案背景。

---

## 5. 分階段執行計畫 (Phased Implementation Roadmap)

### Phase 0：環境整備與 WinSCP 深度規格提取 (Environment & Deep Spec Extraction)
* **目標**：確認 WinSCP 6.7.1 介面與設定檔格式規格，備齊開發編譯環境，並建立可編譯執行的 Tauri 2.0 空白專案骨架。

- [x] **0.1 提取 WinSCP DFM 表單與 `WinSCP.ini` 規格**
  * **CraftAnything 工具**：`craft-anything-cli --deep --project scpcraft.cany native-strings-find` / `core-feature-find` / `native-pe-resources-list`
  * **產出檔案**：`docs/winscp-spec.md`（記錄核心表單欄位、預設值、快捷鍵對照、`WinSCP.ini` 區段與密碼混淆演算法規格）。
  * **驗收標準**：`docs/winscp-spec.md` 建立完成，並將提取結果以 `core-finding-record` 寫入 `scpcraft.cany`。

- [x] **0.2 安裝與驗證跨平台開發環境**
  * **執行項目**：安裝 `rustup` (Rust 1.85+) 與 Node.js LTS + `pnpm`（本機已具備 MSVC Build Tools 與 WebView2）；安裝 Tauri CLI (`cargo install tauri-cli` 或專案局部 `@tauri-apps/cli`)。
  * **驗收標準**：`rustc --version`、`cargo --version`、`node -v`、`pnpm -v` 皆正常回傳版本號。

- [x] **0.3 初始化 `ScpCraft` Tauri 2.0 + React/TypeScript 專案骨架**
  * **產出檔案**：`package.json`, `vite.config.ts`, `tsconfig.json`, `src/`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`（App identifier: `com.scpcraft.app`，視窗標題: `ScpCraft`）。
  * **驗收標準**：`cargo check --manifest-path src-tauri/Cargo.toml` 與 `pnpm build` 均通過無錯誤。

---

### Phase 1：Commander 雙面板 UI 骨架與本地檔案管理 (Dual-Pane UI & Local File System)
* **目標**：完成高還原度的 WinSCP Commander 雙面板（與 Explorer 單面板切換）UI 框架，並實作完整的本機檔案系統操作。

- [x] **1.1 主視窗佈局與高密度桌面 UI 骨架**
  * **產出檔案**：`src/App.tsx`, `src/stores/useWorkspaceStore.ts`, `src/components/Layout/HeaderTabs.tsx`, `src/components/Layout/Toolbar.tsx`, `src/components/Pane/FilePane.tsx`, `src/components/Layout/FunctionKeyBar.tsx`, `src/components/Queue/TransferQueueDock.tsx`
  * **功能細節**：頂部多連線分頁列、常用操作工具列、可拖曳調整比例的左右雙面板（支援切換 Commander／Explorer 模式）、底部 `F2~F9` 功能鍵提示列、可折疊傳輸佇列抽屜、支援亮色／暗色主題與 `@tanstack/react-virtual` 虛擬列表。
  * **驗收標準**：`pnpm build` 通過，啟動 Tauri 視窗可流暢切換分頁、調整左右分割比例與檢視模式。

- [x] **1.2 Rust 本地檔案系統讀取模組**
  * **產出檔案**：`src-tauri/src/local_fs.rs`
  * **功能細節**：跨平台磁碟區／掛載點列舉（Windows `C:\`, `D:\`；macOS/Linux `/`, `~`, `/Volumes`）、高速目錄列舉（檔名、大小、修改時間、權限屬性、是否為隱藏檔／符號連結）、路徑麵包屑解析與欄位排序。
  * **驗收標準**：`cargo test` 驗證目錄列舉與路徑解析，前端左側本地面板可即時瀏覽本機所有資料夾與上萬檔案目錄。

- [x] **1.3 本地檔案操作與鍵盤快速鍵導航**
  * **產出檔案**：`src/hooks/usePaneNavigation.ts`, `src-tauri/src/local_fs.rs`（擴充寫入指令）
  * **功能細節**：支援方向鍵／Enter／Backspace 瀏覽、多選（Shift / Ctrl+Click / Space）、`F2` 重新命名、`F7` 新增資料夾、`F8` 刪除（支援移至資源回收桶或永久刪除）、`F9` 屬性檢視、顯示／隱藏隱藏檔 (`Ctrl+Alt+H`)。
  * **驗收標準**：可透過鍵盤或右鍵選單完成本機檔案的建立、改名與刪除並即時刷新面板。

---

### Phase 2：站台管理員與 `WinSCP.ini` 無痛相容層 (Site Manager & `WinSCP.ini` Parser)
* **目標**：對照 `TLOGINDIALOG` 與 `TSITEADVANCEDDIALOG` 完成站台管理介面，並實作安全的本機連線設定與 `WinSCP.ini` 匯入相容層。

- [x] **2.1 站台管理員 UI (`TLOGINDIALOG` / `TSITEADVANCEDDIALOG`)**
  * **產出檔案**：`src/components/SiteManager/SiteManagerModal.tsx`, `src/components/SiteManager/AdvancedSiteModal.tsx`, `src/stores/useSiteStore.ts`, `src/types/site.ts`, `src/services/siteApi.ts`
  * **功能細節**：左側站台資料夾樹狀分類與三模式搜尋過濾；右側連線協定切換（SFTP / SCP / FTP / FTPS / WebDAV / S3）、主機/Port/帳號/密碼/私鑰路徑、站台識別色標（Tab Color）、進階選項（初始遠端／本機目錄、SSH Tunnel 跳板機、被動模式、Keepalive）；`Tools` 與 `Manage` 下拉功能表（從 Registry / `WinSCP.ini` 匯入、匯出 `WinSCP.ini`、貼上/產生 Session URL）。
  * **驗收標準**：`pnpm build` 通過，可建立、編輯、群組分類與複製站台設定。

- [x] **2.2 `WinSCP.ini` 雙向解析器與 OS 安全金鑰圈整合**
  * **產出檔案**：`src-tauri/src/config/mod.rs`, `src-tauri/src/config/winscp_ini.rs`, `src-tauri/src/config/keyring_store.rs`, `src-tauri/src/config/site_repo.rs`
  * **功能細節**：實作 `WinSCP.ini` `[Sessions\...]` 區段完整解析與匯出（包含 WinSCP 經典 `0xA3` 密碼混淆加解密演算法與 Windows `HKCU` 登錄檔讀取）、一般站台設定以 JSON 儲存於應用設定目錄、敏感密碼與 Passphrase 透過 `keyring` crate 安全寫入 Windows Credential Manager / macOS Keychain / Linux Secret Service。
  * **驗收標準**：`cargo test` 通過 `WinSCP.ini` 匯入／密碼解碼單元測試（7 passed）；能正確匯入真實 WinSCP 站台檔案且不在明文 JSON 中洩漏密碼。

---

### Phase 3：SFTP / SSH 核心連線引擎與遠端檔案操作 (SFTP / SSH Engine & Remote FS)
* **目標**：建立純 Rust 非同步 SSH / SFTP 連線核心，並打通遠端右側面板的瀏覽、權限編輯與操作能力。

- [x] **3.1 Rust `russh` + `russh-sftp` 連線核心與認證對話框**
  * **產出檔案**：`src-tauri/src/sftp/session.rs`, `src-tauri/src/sftp/ppk.rs`, `src-tauri/src/sftp/manager.rs`, `src/components/Auth/HostKeyModal.tsx`, `src/components/Auth/InteractiveAuthModal.tsx`
  * **功能細節**：多連線 Session 池管理、密碼登入、OpenSSH 私鑰與 PuTTY `.ppk` (v2/v3) 私鑰解析、SSH Agent 支援、首次連線 Host Key 指紋驗證與儲存 (`known_hosts`)、Keyboard-Interactive (2FA/OTP) 互動提示 (`TAUTHENTICATEFORM`) 與斷線自動重連。
  * **驗收標準**：可透過密碼與私鑰實際連上 SFTP 測試伺服器，正確觸發並記住 Host Key 指紋。

- [x] **3.2 遠端面板目錄瀏覽與基本操作**
  * **產出檔案**：`src-tauri/src/sftp/ops.rs`, `src/components/Modals/CreateDirModal.tsx`, `src/components/Modals/SymlinkModal.tsx`
  * **功能細節**：實作遠端目錄讀取、路徑快取與快速導航、建立資料夾 (`TCREATEDIRECTORYDIALOG`)、重新命名、遞迴刪除、建立／修改符號連結 (`TSYMLINKDIALOG`) 與書籤記錄 (`TLOCATIONPROFILESDIALOG`)。
  * **驗收標準**：右側遠端面板可完整瀏覽伺服器目錄並執行增刪改與軟連結建立。

- [x] **3.3 遠端檔案屬性與 POSIX 權限編輯器 (`TPROPERTIESDIALOG` / `TRIGHTSFRAME`)**
  * **產出檔案**：`src/components/Modals/PropertiesModal.tsx`, `src/components/Modals/PermissionsGrid.tsx`
  * **功能細節**：對照 `TRIGHTSFRAME` 實作 Owner / Group / Others 讀取・寫入・執行與 SetUID/SetGID/Sticky 位元九宮格勾選，與八進位權限碼（如 `0755`、`0644`）即時雙向連動；支援檢視/修改 UID/GID 與遞迴套用至子目錄 (`chmod -R`)。
  * **驗收標準**：修改單一檔案與遞迴修改資料夾權限後重新讀取，伺服器端權限數值與預期完全一致。

---

### Phase 4：多執行緒傳輸引擎與佇列控制系統 (Transfer Engine & Queue Manager)
* **目標**：打造支援背景多執行緒、斷點續傳、即時進度監控與同名衝突處理的高可靠傳輸系統。

- [x] **4.1 非同步多工作緒傳輸引擎與拖放傳輸**
  * **產出檔案**：`src-tauri/src/transfer/engine.rs`, `src-tauri/src/transfer/queue.rs`, `src/hooks/useDragDropTransfer.ts`
  * **功能細節**：支援上傳 (`F5` / 拖放)、下載、資料夾遞迴展開排程、可設定最大並行傳輸數量（預設 2~4 條背景連線）、跨面板拖放與從作業系統桌面拖入檔案上傳。
  * **驗收標準**：同時排入上百個大小檔案時 UI 零卡頓，背景通道能穩定並行完成所有傳輸任務。

- [x] **4.2 傳輸確認視窗與即時進度監控 (`TCOPYDIALOG` / `TPROGRESSFORM`)**
  * **產出檔案**：`src/components/Transfer/CopyConfirmModal.tsx`, `src/components/Queue/TransferQueueDock.tsx`
  * **功能細節**：傳輸前確認視窗（可調整目標路徑、檔案遮罩過濾、背景傳輸選項）；Tauri Event 串流回報即時速率 (KB/s, MB/s)、總進度百分比、預估剩餘時間 (ETA)；支援單筆／全部暫停、繼續、重試、取消與頻寬限速。
  * **驗收標準**：大檔案傳輸期間進度條與速率平滑更新，暫停與取消能即時中斷底層串流而不殘留死鎖。

- [x] **4.3 `.filepart` 斷點續傳與同名衝突策略**
  * **產出檔案**：`src-tauri/src/transfer/resume.rs`, `src/components/Transfer/OverwriteModal.tsx`
  * **功能細節**：支援上傳／下載先寫入 `.filepart` 暫存檔、完成後原子改名；中斷後支援 Offset 斷點續傳；遇到同名檔案跳出衝突對話框（覆寫、全部覆寫、跳過、僅覆寫較舊檔案、自動重新命名、續傳）；保留遠端／本地 `mtime` 時間戳記及 Text/Binary 換行模式切換。
  * **驗收標準**：模擬傳輸中斷後重新連線續傳，檔案 SHA-256 校驗與原始檔案完全一致。

---

### Phase 5：內建編輯器、遠端終端機與目錄同步 (Editor, Terminal & Synchronization)
* **目標**：補齊 WinSCP 最受工程師喜愛的進階生產力工具（即時編輯回傳、內嵌終端機、目錄比對與自動同步）。

- [x] **5.1 內建與外部編輯器即時回傳 (`TEDITORFORM`)**
  * **產出檔案**：`src/components/Editor/RemoteEditorModal.tsx`, `src-tauri/src/editor_watch.rs`
  * **功能細節**：按 `F4` 或雙擊開啟遠端檔案：提供內建語法高亮編輯器 (`CodeMirror 6`)，同時支援指定外部編輯器（如 VS Code）開啟本地暫存檔；後端透過 `notify` 監聽檔案儲存事件，一存檔立即背景加密上傳回遠端伺服器。
  * **驗收標準**：在遠端編輯設定檔並按下 `Ctrl+S` / `Cmd+S` 後，遠端檔案內容即時更新且狀態欄顯示上傳成功。

- [x] **5.2 遠端互動終端機與自訂命令 (`TCONSOLEDIALOG` / `TCUSTOMCOMMANDDIALOG`)**
  * **產出檔案**：`src/components/Terminal/TerminalDrawer.tsx`, `src-tauri/src/sftp/shell.rs`, `src/components/Modals/CustomCommandModal.tsx`
  * **功能細節**：按 `Ctrl+T` 複用當前 SSH Session 開啟 `xterm.js` PTY 互動終端機（自動 `cd` 至右側面板當前目錄）；支援預設定義或使用者自訂快捷遠端命令（如解壓/打包 `.tar.gz`、計算 `sha256sum`、`du -sh`）。
  * **驗收標準**：終端機可正常執行 `vim`/`htop`/彩色輸出並隨視窗縮放 PTY 大小。

- [x] **5.3 目錄同步、保持最新與遠端搜尋 (`TSYNCHRONIZEDIALOG` / `TFULLSYNCHRONIZEDIALOG` / `TFILEFINDDIALOG`)**
  * **產出檔案**：`src-tauri/src/sync/diff.rs`, `src-tauri/src/sync/watcher.rs`, `src/components/Sync/SynchronizeModal.tsx`, `src/components/Sync/SyncChecklistModal.tsx`, `src/components/Modals/RemoteFindModal.tsx`
  * **功能細節**：本地與遠端目錄差異掃描與預覽勾選清單 (`TSYNCHRONIZECHECKLISTDIALOG`)；支援單向上傳／下載與雙向同步；支援「保持遠端目錄最新 (Keep Remote Directory up to Date)」即時監控自動同步；實作 `Alt+F7` 遠端檔名與內容關鍵字搜尋。
  * **驗收標準**：修改本地開發目錄檔案後，「保持最新」功能於 1 秒內偵測變更並自動同步至遠端測試機。

---

### Phase 6：多協定擴充與 Windows / macOS / Linux 跨平台打包 (Multi-Protocol & Packaging)
* **目標**：擴展支援 FTP / S3 / WebDAV 協定，打磨三平台原生系統體驗，並建立自動化打包發布與最終驗收。

- [x] **6.1 統一協定抽象層與 FTP / FTPS / S3 / WebDAV 實作**
  * **產出檔案**：`src-tauri/src/fs_trait.rs`, `src-tauri/src/protocols/ftp.rs`, `src-tauri/src/protocols/opendal_fs.rs`
  * **功能細節**：將 Phase 3~5 的遠端操作抽離為統一的非同步 `RemoteFileSystem` Trait，接入 `suppaftp` (FTP/FTPS) 與 `opendal` (Amazon S3 / Cloudflare R2 / MinIO / WebDAV)，讓同一套雙面板介面無縫支援所有協定。
  * **驗收標準**：可透過相同操作邏輯連線並傳輸檔案至 FTP、FTPS、S3/MinIO 與 WebDAV 測試端點。

- [x] **6.2 跨平台原生體驗打磨、雙語系與工具列功能補齊**
  * **產出檔案**：`src/i18n/`, `src/components/Modals/PreferencesModal.tsx`, `src/components/Modals/CleanupModal.tsx`, `src/components/Modals/GenerateUrlModal.tsx`, `src-tauri/src/menu.rs`
  * **功能細節**：適配 macOS 原生頂部選單列與 `Cmd` 鍵盤快捷鍵映射、Windows/Linux 系統整合、繁體中文／英文雙語系切換、隱私與暫存檔清理 (`TCLEANUPDIALOG`)、以及一鍵產生標準 `sftp://` / `scp://` Session URL (`TGENERATEURLDIALOG`)。
  * **驗收標準**：三平台皆具備正確的視窗選單、快捷鍵與字體渲染（含 macOS Retina 與 Windows High-DPI）。

- [x] **6.3 跨平台 CI/CD 自動打包與 CraftAnything 最終驗收**
  * **產出檔案**：`.github/workflows/release.yml`, `src-tauri/tauri.conf.json`（補齊圖示與簽章設定）
  * **功能細節**：建立 GitHub Actions 三平台建置流水線（Windows `.msi`/`.exe`、macOS Universal `.dmg`/`.app`、Linux `.deb`/`.AppImage`），並使用 CraftAnything 進行功能覆蓋率檢查。
  * **CraftAnything 工具**：`craft-anything-cli --project scpcraft.cany rebuild-check`
  * **驗收標準**：本機打包成功並通過 `rebuild_check` 核心功能對照清單，且 GitHub Actions workflow 語法與步驟驗證無誤。
