# Changelog

All notable changes to **ScpCraft** will be documented in this file.

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
