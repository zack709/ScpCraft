# Changelog

All notable changes to **ScpCraft** will be documented in this file.

## [0.1.10] - 2026-11-18

### Fixed
- **Linux Dark Theme Dropdowns & Native Form Controls**:
  - Synced `data-theme` and CSS `color-scheme` (`dark` / `light`) on `<html>` (`src/main.tsx`, `src/App.tsx`, `src/App.css`) so WebKitGTK on Linux renders native dropdown popups and number input spinbuttons in the active theme.
  - Styled `<select>` elements with `appearance: none`, custom theme-aware SVG chevron icons, and explicit `<option>` / `<optgroup>` colors in `src/App.css` so dropdown controls no longer render with white GTK native backgrounds in Dark Theme.

## [0.1.9] - 2026-11-17

### Added
- **Site Manager Folder Drag & Drop, Visual Hierarchy, and Context Menu**:
  - Added pointer-based drag-and-drop (`moveSiteToFolder` in `src/stores/useSiteStore.ts`) so saved sites can be dragged into folders or back to root without modifying or clearing OS Keyring credentials.
  - Added a right-click context menu on sites (Login, Edit, Save As, Rename, Clone, Generate Session URL, Move to Folder / Root, Delete), folders (New Site Here, Remove Folder), and empty tree area (New Site, New Folder).
  - Added a prominent `New Folder` (`FolderPlus`) button next to `New Site`, folder item counts, tree indent guide lines for folder children, and a `Folder / Group` dropdown + quick-create button in the Session panel.
- **External Editor File Picker & macOS `.app` Support**:
  - Added `pick_external_editor_file` (`src-tauri/src/local_fs.rs`, exposed via `preferencesApi.pickExternalEditorFile`) and a `Browse...` button next to the External Editor command field in `PreferencesModal.tsx`.
  - Updated `launch_external_process` (`src-tauri/src/editor_watch.rs`) to launch macOS `.app` bundles via `open -a`.
- **Split Built-In & External Editor Double-Click Actions**:
  - Split `doubleClickAction` in `PreferencesModal.tsx` into `Edit - Built-In Editor (F4)` (`edit_builtin`) and `Edit - External Editor` (`edit_external`), and wired `handleRowDoubleClick` in `FilePane.tsx` and `openFileInEditor` in `useWorkspaceStore.ts` to launch the external editor directly when `edit_external` is selected.

### Changed
- **Disabled Browser Default `Reload` Context Menu**: Intercepted global `contextmenu` events in `src/App.tsx` outside editable inputs (`INPUT`, `TEXTAREA`, `contentEditable`) so right-clicking UI elements no longer shows the default WebView `Reload` menu.

### Fixed
- **macOS Auto-Capitalization on Login & Editor Inputs**: Added `autoCapitalize="none"`, `autoCorrect="off"`, and `spellCheck={false}` to username, hostname, search, password, SSH tunnel, and external editor command input fields in `SiteManagerModal.tsx`, `AdvancedSiteModal.tsx`, and `PreferencesModal.tsx`.
- **Preferences "Save & Apply" Button Stuck Disabled**: Reset `saving` state in `PreferencesModal.tsx` (`finally` block in `handleSave` and on modal open) so reopening Preferences after saving no longer leaves the Save button spinning and disabled.

## [0.1.8] - 2026-11-16

### Added
- **Windows & Linux Portable Builds with Local `config/` Directory**:
  - Added a `portable` Cargo feature (`src-tauri/Cargo.toml`) and centralized config directory resolution (`app_config_dir` in `src-tauri/src/config/mod.rs`).
  - When running in portable mode (built with `--features portable`, or when a `config/` directory exists alongside the executable), ScpCraft creates and stores `preferences.json`, `sites.json`, `bookmarks.json`, and `custom_commands.json` inside `<exe_dir>/config/`.
  - Updated GitHub Actions (`.github/workflows/release.yml`) to build and upload `ScpCraft_<version>_x64-portable.zip` (Windows) and `ScpCraft_<version>_x64-linux-portable.tar.gz` (Linux) using `pnpm tauri build --no-bundle --features portable`.
- **Private Key File Picker (`Browse...`)**: Added a native file picker button (`pick_private_key_file` using `rfd` in `src-tauri/src/local_fs.rs`, exposed via `siteApi.pickPrivateKeyFile`) next to both the main Private Key and SSH Tunnel Private Key fields in `AdvancedSiteModal.tsx`.
- **Site Shell Setting & Elevated SFTP (`sudo su -`)**: Added `advanced.shell` (`預設`, `/bin/bash`, `/bin/ksh`, `/bin/sh`, `sudo su -`, or custom command) under `Environment -> SCP / Shell` in `AdvancedSiteModal.tsx`, persisted in `sites.json`. When configured with `sudo` (e.g. `sudo su -`), ScpCraft elevates both the SFTP file-pane session (`open_elevated_sftp_channel` in `src-tauri/src/sftp/session.rs`, supporting `sudo -n`, `sudo -n su` / `sudo -n su -` bootstrap, and `sudo -S` via keyring password) and the interactive SSH PTY terminal (`sftp_pty_open` in `src-tauri/src/sftp/shell.rs`).

### Changed
- **Windows & Linux Typography Readability**: Applied the comfortable `15px` base font size and micro-typography scaling (`.text-[10px]`, `.text-[11px]`, `.text-xs`, `.text-sm`) in `src/App.css` across all platforms instead of macOS only.
- **Expanded Traditional Chinese (`zh-TW`) Localization**: Localized the Login / Site Manager dialog (`SiteManagerModal.tsx`), Advanced Site Settings (`AdvancedSiteModal.tsx`), file panes (`FilePane.tsx`), function key bar (`FunctionKeyBar.tsx`), transfer queue dock (`TransferQueueDock.tsx`), host key / interactive auth modals (`HostKeyModal.tsx`, `InteractiveAuthModal.tsx`), overwrite confirmation (`OverwriteModal.tsx`), and create directory modal (`CreateDirModal.tsx`) via `src/i18n/index.ts`.

## [0.1.7] - 2026-11-16

### Changed
- **YAML (`.yml`) Site Import & Export (Password-Free)**: Replaced WinSCP INI / Registry import & export in the Site Manager (`SiteManagerModal.tsx`, `useSiteStore.ts`, `site_repo.rs`) with `scpcraft-sites.yml` YAML import/export using `serde_yaml`. Passwords and secret keys are never exported or imported.
- **Copyright & Reference Cleanup**: Removed third-party reference screenshots from `docs/screenshots/` and cleaned up third-party name references in UI copy (`HeaderTabs.tsx`, `FilePane.tsx`).

## [0.1.6] - 2026-11-16

### Fixed
- **macOS Window Dragging**: Added `core:window:allow-start-dragging` and `core:window:allow-toggle-maximize` permissions to `src-tauri/capabilities/default.json` so the macOS overlay titlebar (`data-tauri-drag-region`) can drag and double-click-maximize the window.

### Packaging
- Built macOS Universal (`aarch64` + `x86_64`) `.dmg` installer.

## [0.1.5] - 2026-11-16

### Added
- **Cancel Directory Loading**: Added a `Cancel` button during directory loading (`FilePane.tsx` / `useWorkspaceStore.ts`) with per-pane request sequence tokens (`navSeq`) so cancelling immediately restores the previous file list and ignores stale responses.

### Changed
- **Longer S3 / WebDAV Timeouts**: Increased TCP/TLS connect timeout floor to `30s` and HTTP response read timeout floor to `120s` in `opendal_fs.rs` to prevent premature timeouts on large S3 directory listings.

### Fixed
- **Protocol Badge & S3 Key Redaction**: Fixed the remote pane header badge always showing `SFTP` instead of the active protocol (`S3`, `FTP`, `WebDAV`, etc.), and omitted the S3 Access Key from the pane location bar and placeholder URL (`FilePane.tsx`).

## [0.1.4] - 2026-11-16

### Added
- **Directory Loading Progress State**: When navigating into a directory or refreshing a pane (`pane.loading === true`), the previous file list is immediately cleared and replaced with a centered spinning progress indicator until the new directory listing arrives (`FilePane.tsx`).

## [0.1.3] - 2026-11-16

### Fixed
- **Per-Tab Right Pane State Isolation**: Fixed an issue where switching back to a `Local / Workspace` tab after connecting to S3/SFTP/FTP/WebDAV left the remote directory listing in the right pane (`useWorkspaceStore.ts`). Each tab now preserves and restores its own right-pane state and mode.

## [0.1.2] - 2026-11-16

### Added
- **Pure-Rust HTTPS / TLS for S3 & WebDAV**: Added `rustls`, `tokio-rustls`, and `webpki-roots` support in `opendal_fs.rs`, enabling direct SSL/TLS connections (e.g. HiCloud S3 `s3.hicloud.net.tw:443`) without external OpenSSL/CMake dependencies.
- **macOS Login Modal Sizing**: Enlarged the macOS Login / Site Manager modal (`840px` wide, `470px` body height) and prevented button text wrapping (`Save As...`, `Save`, `Cancel`, `Advanced...`).

### Fixed
- **Remote Placeholder UI & Multi-Protocol Tab Switching**:
  - Wrapped long S3/WebDAV/SFTP URLs cleanly inside the remote placeholder card (`break-all`) and enabled `Connect <PROTOCOL> Now` for all supported protocols (`S3`, `FTP`, `WebDAV`, `SFTP`, `SCP`).
  - Fixed `setActiveTab` and `closeTab` dropping connection state for non-SFTP protocols (`S3`, `FTP`, `WebDAV`) when switching tabs.

## [0.1.1] - 2026-11-16

### Added
- **macOS Native UI & Typography**:
  - Added `tauri.macos.conf.json` with `titleBarStyle: "Overlay"`, `hiddenTitle: true`, and `1380×860` default window size.
  - Added macOS Unified Titlebar integrating traffic lights, segmented `Commander / Explorer` switch, Safari/Finder-style rounded session tabs, rounded toolbar/action pills, and larger readable macOS system fonts (`SF Pro Text` / `PingFang TC`).
- **macOS HiDPI & Error Recovery**:
  - Added explicit `src-tauri/Info.plist` (`NSHighResolutionCapable`, `NSSupportsAutomaticGraphicsSwitching`) and `zoomHotkeysEnabled: true`.
  - Added `ErrorBoundary` around the React root to display diagnostics instead of a blank screen on unexpected render errors.

### Fixed
- **Login White Screen**: Fixed a React Rules of Hooks violation in `FilePane.tsx` where `useMemo` hooks were called after an early return when switching to `remote_placeholder` on Login.

## [0.1.0] - 2026-11-16

### Added
- Initial release of ScpCraft: cross-platform dual-pane SFTP, SCP, FTP, WebDAV & S3 file transfer client built with Tauri 2.0 (Rust + React/TypeScript).
