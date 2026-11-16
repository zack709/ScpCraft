import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bookmark,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerLeftUp,
  File,
  FileEdit,
  FilePlus,
  Filter,
  Folder,
  FolderPlus,
  FolderUp,
  HardDrive,
  Home,
  Info,
  Link2,
  Loader2,
  Minus,
  MoveRight,
  PanelLeft,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Unplug,
} from 'lucide-react';
import { translate, type TranslationKey } from '../../i18n';
import {
  getTargetPathsForPane,
  useWorkspaceStore,
} from '../../stores/useWorkspaceStore';
import { useSiteStore } from '../../stores/useSiteStore';
import type { FileEntry, PaneId, SortField } from '../../types/fs';
import {
  formatBytes,
  formatDateTime,
  formatSizeKB,
  getFileTypeDescription,
  getVisibleSortedEntries,
  isDirEntry,
  isEntryDimmed,
} from '../../utils/formatters';
import { beginPointerDrag, useDragDropStore } from '../../hooks/useDragDropTransfer';
import { isMacOS } from '../../utils/platform';

interface FilePaneProps {
  paneId: PaneId;
  title?: string;
}

type VirtualRow =
  | { kind: 'parent'; key: '__PARENT__' }
  | { kind: 'entry'; key: string; entry: FileEntry };

const TABLE_GRID_COLS =
  'grid-cols-[minmax(160px,1.4fr)_100px_130px_155px_56px_60px]';

const REMOTE_QUICK_PATHS = [
  { label: 'Home (~)', path: '~' },
  { label: 'Root (/)', path: '/' },
  { label: '/etc', path: '/etc' },
  { label: '/var/log', path: '/var/log' },
  { label: '/var/www', path: '/var/www' },
  { label: '/tmp', path: '/tmp' },
] as const;

export function FilePane({ paneId, title }: FilePaneProps) {
  const {
    theme,
    locale,
    activePane,
    rightPaneMode,
    setRightPaneMode,
    drives,
    leftPane,
    rightPane,
    tabs,
    activeTabId,
    connectingSession,
    connectionError,
    bookmarks,
    disconnectActiveSession,
    reconnectSiteOnTab,
    loadBookmarks,
    setActivePane,
    navigateTo,
    cancelNavigation,
    refreshPane,
    goBack,
    goForward,
    goUp,
    goRoot,
    goHome,
    toggleShowHidden,
    toggleTreeSidebar,
    setSort,
    selectSingle,
    toggleSelect,
    selectRange,
    selectAll,
    clearSelection,
    openModal,
    openFileInEditor,
  } = useWorkspaceStore();
  const t = (key: TranslationKey) => translate(locale, key);

  const pane = paneId === 'left' ? leftPane : rightPane;
  const isActive = activePane === paneId;
  const isDark = theme === 'dark';
  const isMac = isMacOS();
  const internalDrag = useDragDropStore((s) => s.internalDrag);
  const osDropHoverPane = useDragDropStore((s) => s.osDropHoverPane);
  const isDropHover =
    (Boolean(internalDrag?.active) && internalDrag?.dropTargetPane === paneId) ||
    osDropHoverPane === paneId;

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const connectedSite = activeTab?.site;
  const isRemoteSftp = paneId === 'right' && rightPaneMode === 'remote_sftp';

  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: FileEntry | null;
  } | null>(null);

  const scrollParentRef = useRef<HTMLDivElement>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isRemoteSftp) {
      void loadBookmarks(connectedSite?.id ?? null);
    }
  }, [isRemoteSftp, connectedSite?.id, loadBookmarks]);

  const sortedEntries = useMemo(
    () =>
      getVisibleSortedEntries(
        pane.entries,
        pane.filterMask,
        pane.sortField,
        pane.sortDir,
        isRemoteSftp ? pane.showHidden : true
      ),
    [pane.entries, pane.filterMask, pane.sortField, pane.sortDir, isRemoteSftp, pane.showHidden]
  );

  const rows: VirtualRow[] = useMemo(() => {
    const out: VirtualRow[] = [];
    if (pane.parentPath) {
      out.push({ kind: 'parent', key: '__PARENT__' });
    }
    for (const entry of sortedEntries) {
      out.push({ kind: 'entry', key: entry.path, entry });
    }
    return out;
  }, [pane.parentPath, sortedEntries]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => (isMac ? 27 : 21),
    overscan: 15,
  });

  useEffect(() => {
    if (!pane.focusedPath) return;
    const idx = rows.findIndex((r) => r.key === pane.focusedPath);
    if (idx >= 0) {
      rowVirtualizer.scrollToIndex(idx, { align: 'auto' });
    }
  }, [pane.focusedPath, rows, rowVirtualizer]);

  useEffect(() => {
    const handleGlobalClick = (e: MouseEvent) => {
      setContextMenu(null);
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
        setNewMenuOpen(false);
      }
    };
    window.addEventListener('click', handleGlobalClick);
    return () => window.removeEventListener('click', handleGlobalClick);
  }, []);

  // Match the longest drive/place prefix matching currentPath for the WinSCP ComboBox display
  const activeDriveValue = useMemo(() => {
    const cur = pane.currentPath.toLowerCase();
    let best = '';
    for (const d of drives) {
      const dp = d.path.toLowerCase();
      if (cur === dp || cur.startsWith(dp)) {
        if (dp.length > best.length) best = d.path;
      }
    }
    return best;
  }, [drives, pane.currentPath]);

  const activeRemoteQuickValue = useMemo(() => {
    if (!isRemoteSftp) return '';
    const bmMatch = bookmarks.find((bm) => bm.remotePath === pane.currentPath);
    if (bmMatch) return bmMatch.remotePath;
    const qpMatch = REMOTE_QUICK_PATHS.find((qp) => qp.path === pane.currentPath);
    return qpMatch ? qpMatch.path : '';
  }, [isRemoteSftp, bookmarks, pane.currentPath]);

  if (paneId === 'right' && rightPaneMode === 'remote_placeholder') {
    return (
      <div
        data-pane-drop-target={paneId}
        onMouseDown={() => setActivePane('right')}
        className={`h-full w-full flex flex-col items-center justify-center p-6 text-center border-l ${
          isDark
            ? 'bg-[#1e1e1e] border-[#333333] text-[#dcdcdc]'
            : 'bg-slate-50 border-slate-300 text-slate-700'
        } ${isActive ? 'ring-1 ring-inset ring-[#1e4b85]' : ''}`}
      >
        <div
          className={`max-w-md w-full p-6 border ${
            isMac ? 'rounded-xl ' : ''
          }${
            isDark
              ? 'bg-[#252526] border-[#3f3f3f]'
              : 'bg-white border-slate-300 shadow-sm'
          }`}
        >
          <Server className="w-10 h-10 text-[#4da3ff] mx-auto mb-3" />
          <h3 className="text-sm font-semibold mb-1.5 break-words">
            {connectedSite
              ? `${connectedSite.name} (${connectedSite.protocol.toUpperCase()})`
              : 'Remote Panel (SFTP / SCP / FTP / WebDAV / S3)'}
          </h3>
          {connectedSite ? (
            <div
              className={`text-xs mb-4 space-y-1 leading-relaxed ${
                isDark ? 'text-[#b5b5b5]' : 'text-slate-600'
              }`}
            >
              <div className="font-mono text-[11px] text-[#4da3ff] break-all">
                {connectedSite.protocol}://
                {connectedSite.protocol === 's3'
                  ? ''
                  : `${connectedSite.userName || 'anonymous'}@`}
                {connectedSite.hostName}:{connectedSite.portNumber}
                {connectedSite.advanced.remoteDirectory || '/'}
              </div>
              {connectedSite.advanced.tunnel.enabled && (
                <div className="text-[11px] text-amber-400 break-all">
                  SSH Tunnel via {connectedSite.advanced.tunnel.userName}@
                  {connectedSite.advanced.tunnel.hostName}:{connectedSite.advanced.tunnel.portNumber}
                </div>
              )}
              {connectingSession && (
                <div className="flex items-center justify-center gap-1.5 pt-2 text-[#4da3ff] font-medium">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>{t('pane.connectingTo')} {connectedSite.protocol.toUpperCase()} {t('pane.server')}</span>
                </div>
              )}
              {connectionError && (
                <div
                  className={`mt-2 p-2 border text-left text-[11px] flex items-start gap-1.5 ${
                    isDark
                      ? 'bg-red-950/50 border-red-700/70 text-red-300'
                      : 'bg-red-50 border-red-300 text-red-700'
                  }`}
                >
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-red-400" />
                  <span className="break-all font-mono">{connectionError}</span>
                </div>
              )}
              {!connectingSession && !connectionError && (
                <p className="opacity-80 pt-1">
                  {t('pane.profileReady')}
                </p>
              )}
            </div>
          ) : (
            <p
              className={`text-xs mb-4 leading-relaxed ${
                isDark ? 'text-[#a0a0a0]' : 'text-slate-500'
              }`}
            >
              {t('pane.placeholderDesc')}
            </p>
          )}
          <div className="flex items-center justify-center gap-2 flex-wrap">
            {connectedSite && activeTab && (
              <button
                type="button"
                disabled={connectingSession}
                onClick={() => void reconnectSiteOnTab(activeTab.id, connectedSite)}
                className={`px-3 py-1.5 ${
                  isMac ? 'rounded-md ' : ''
                }bg-[#0284c7] hover:bg-[#0369a1] disabled:opacity-50 text-white text-xs font-medium inline-flex items-center gap-1.5`}
              >
                {connectingSession ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Plug className="w-3.5 h-3.5" />
                )}
                {t('pane.connectNow')} ({connectedSite.protocol.toUpperCase()})
              </button>
            )}
            <button
              type="button"
              onClick={() => useSiteStore.getState().openLoginDialog()}
              className="px-3 py-1.5 bg-[#10b981] hover:bg-[#059669] text-white text-xs font-medium inline-flex items-center gap-1.5"
            >
              <Server className="w-3.5 h-3.5" />
              {t('pane.openSiteManager')}
            </button>
            <button
              type="button"
              onClick={() => setRightPaneMode('local_secondary')}
              className="px-3 py-1.5 bg-[#1e4b85] hover:bg-[#255da3] text-white text-xs font-medium inline-flex items-center gap-1.5"
            >
              <HardDrive className="w-3.5 h-3.5" />
              {t('pane.switchLocalMode')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const selectedSet = new Set(pane.selectedPaths);
  const selectedEntries = pane.entries.filter((e) => selectedSet.has(e.path));
  const selectedBytes = selectedEntries.reduce(
    (acc, e) => acc + (isDirEntry(e) ? 0 : e.size),
    0
  );
  const targetPaths = getTargetPathsForPane(pane);
  const hasTargets = targetPaths.length > 0;
  const hasExplicitSelection = pane.selectedPaths.length > 0;

  const canBack = pane.historyIndex > 0;
  const canForward = pane.historyIndex < pane.history.length - 1;

  const renderSortIcon = (field: SortField) => {
    if (pane.sortField !== field) return null;
    return pane.sortDir === 'asc' ? (
      <ArrowUp className="w-3 h-3 inline ml-0.5 text-[#4da3ff]" />
    ) : (
      <ArrowDown className="w-3 h-3 inline ml-0.5 text-[#4da3ff]" />
    );
  };

  const iconBtnCls = (disabled = false, active = false) =>
    `p-1 ${isMac ? 'rounded-md' : 'border border-transparent'} transition-colors ${
      disabled
        ? isDark
          ? 'text-[#555555] cursor-not-allowed'
          : 'text-slate-300 cursor-not-allowed'
        : active
        ? isMac
          ? isDark
            ? 'bg-[#0a84ff]/25 text-[#64d2ff]'
            : 'bg-[#007aff]/12 text-[#0066cc]'
          : isDark
          ? 'bg-[#1e4b85]/60 border-[#3b82f6]/60 text-white'
          : 'bg-[#cce4f7] border-[#99c9ef] text-[#003366]'
        : isMac
        ? isDark
          ? 'text-[#e5e5ea] hover:bg-white/10'
          : 'text-[#1d1d1f] hover:bg-black/6'
        : isDark
        ? 'text-[#dcdcdc] hover:bg-[#333333] hover:border-[#454545] hover:text-white'
        : 'text-slate-700 hover:bg-[#e1e1e1] hover:border-[#c8c8c8]'
    }`;

  const labeledActionCls = (disabled = false) =>
    `flex items-center gap-1 ${
      isMac ? 'px-2 py-1 rounded-md' : 'px-1.5 py-0.5 border border-transparent'
    } text-[11px] transition-colors ${
      disabled
        ? isDark
          ? 'text-[#555555] cursor-not-allowed'
          : 'text-slate-400 cursor-not-allowed'
        : isMac
        ? isDark
          ? 'text-[#e5e5ea] hover:bg-white/10 hover:text-white'
          : 'text-[#1d1d1f] hover:bg-black/6'
        : isDark
        ? 'text-[#dcdcdc] hover:bg-[#333333] hover:border-[#454545] hover:text-white'
        : 'text-slate-800 hover:bg-[#e1e1e1] hover:border-[#c8c8c8]'
    }`;

  const handleRowClick = (e: React.MouseEvent, row: VirtualRow) => {
    setActivePane(paneId);
    if (row.kind === 'parent') {
      selectSingle(paneId, '__PARENT__');
      return;
    }
    if (e.shiftKey) {
      selectRange(paneId, row.entry.path);
    } else if (e.ctrlKey || e.metaKey) {
      toggleSelect(paneId, row.entry.path);
    } else {
      selectSingle(paneId, row.entry.path);
    }
  };

  const handleRowDoubleClick = (row: VirtualRow) => {
    setActivePane(paneId);
    if (row.kind === 'parent') {
      void goUp(paneId);
      return;
    }
    if (isDirEntry(row.entry)) {
      void navigateTo(paneId, row.entry.path, true);
    } else {
      void openFileInEditor(paneId, row.entry.path);
    }
  };

  const colDividerCls = isDark
    ? 'border-r border-[#2d2d2d]'
    : 'border-r border-[#e5e5e5]';

  const totalItemsCount = pane.totalFiles + pane.totalDirs;

  return (
    <div
      data-pane-drop-target={paneId}
      onMouseDown={() => setActivePane(paneId)}
      className={`h-full w-full flex flex-col min-w-0 overflow-hidden select-none ${
        isDark ? 'bg-[#1e1e1e] text-[#e0e0e0]' : 'bg-white text-[#1e1e1e]'
      } ${isDropHover ? 'ring-2 ring-inset ring-emerald-400' : ''}`}
    >
      {/* Row 1: Pane Location ComboBox + Open/Filter + Navigation + History */}
      <div
        className={`shrink-0 px-1.5 py-0.5 border-b flex items-center gap-1 flex-wrap ${
          isDark
            ? 'bg-[#252526] border-[#333333]'
            : 'bg-[#f5f5f5] border-[#d0d0d0]'
        }`}
      >
        <span
          className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 shrink-0 ${
            isRemoteSftp
              ? isActive
                ? 'bg-emerald-700 text-white'
                : 'bg-emerald-900/50 text-emerald-300 border border-emerald-700/60'
              : isActive
              ? 'bg-[#1e4b85] text-white'
              : isDark
              ? 'bg-[#333333] text-[#a0a0a0]'
              : 'bg-[#dcdcdc] text-[#555555]'
          }`}
        >
          {isRemoteSftp
            ? connectedSite?.protocol.toUpperCase() || t('pane.remote')
            : title ?? (paneId === 'left' ? t('pane.local') : t('pane.local2'))}
        </span>
        {isRemoteSftp && connectedSite && (
          <span
            title={
              connectedSite.protocol === 's3'
                ? `${connectedSite.hostName}:${connectedSite.portNumber}`
                : `${connectedSite.userName || 'user'}@${connectedSite.hostName}:${connectedSite.portNumber}`
            }
            className={`text-[10px] font-mono truncate max-w-[180px] px-1 shrink-0 ${
              isDark ? 'text-emerald-300' : 'text-emerald-700'
            }`}
          >
            {connectedSite.protocol !== 's3' && connectedSite.userName
              ? `${connectedSite.userName}@`
              : ''}
            {connectedSite.hostName}:{connectedSite.portNumber}
          </span>
        )}

        {/* Path / Drive / Remote Places ComboBox */}
        {isRemoteSftp ? (
          <select
            aria-label="Select remote path or bookmark"
            value={activeRemoteQuickValue}
            onChange={(e) => {
              if (e.target.value) {
                void navigateTo(paneId, e.target.value, true);
              }
            }}
            className={`h-[22px] px-1.5 border text-[11px] outline-none min-w-[110px] max-w-[180px] ${
              isDark
                ? 'bg-[#1e1e1e] border-[#3f3f3f] text-[#e0e0e0]'
                : 'bg-white border-[#c0c0c0] text-[#1e1e1e]'
            }`}
          >
            <option value="" disabled>
              {t('pane.remotePlaces')}
            </option>
            {REMOTE_QUICK_PATHS.map((qp) => (
              <option key={qp.path} value={qp.path}>
                {qp.label}
              </option>
            ))}
            {bookmarks.map((bm) => (
              <option key={bm.id} value={bm.remotePath}>
                ★ {bm.name} ({bm.remotePath})
              </option>
            ))}
          </select>
        ) : (
          <select
            aria-label="Select drive or location"
            value={activeDriveValue}
            onChange={(e) => {
              if (e.target.value) {
                void navigateTo(paneId, e.target.value, true);
              }
            }}
            className={`h-[22px] px-1.5 border text-[11px] outline-none min-w-[110px] max-w-[180px] ${
              isDark
                ? 'bg-[#1e1e1e] border-[#3f3f3f] text-[#e0e0e0]'
                : 'bg-white border-[#c0c0c0] text-[#1e1e1e]'
            }`}
          >
            <option value="" disabled>
              {t('pane.drivesPlaces')}
            </option>
            {drives.map((d) => (
              <option key={`${d.kind}-${d.path}`} value={d.path}>
                {d.name} ({d.path})
              </option>
            ))}
          </select>
        )}

        {isRemoteSftp && (
          <>
            <button
              type="button"
              onClick={() => openModal('bookmarks', 'right')}
              className={iconBtnCls(false)}
              title={t('pane.bookmarksTip')}
            >
              <Bookmark className="w-3.5 h-3.5 text-amber-400" />
            </button>
            <button
              type="button"
              onClick={() => void disconnectActiveSession()}
              className={iconBtnCls(false)}
              title={t('pane.disconnectTip')}
            >
              <Unplug className="w-3.5 h-3.5 text-red-400" />
            </button>
          </>
        )}

        <button
          type="button"
          onClick={() => openModal('opendir', paneId)}
          className={iconBtnCls(false)}
          title={t('pane.openDirTip')}
        >
          <FolderUp className="w-3.5 h-3.5 text-[#4da3ff]" />
        </button>
        <button
          type="button"
          onClick={() => openModal('filter', paneId)}
          className={iconBtnCls(false, pane.filterMask !== '*')}
          title="Filter Files (Ctrl+F)"
        >
          <Filter className="w-3.5 h-3.5 text-sky-400" />
        </button>

        <div className={`w-px h-4 mx-0.5 ${isDark ? 'bg-[#3f3f3f]' : 'bg-[#c8c8c8]'}`} />

        {/* Navigation group */}
        <button
          type="button"
          disabled={!pane.parentPath}
          onClick={() => void goUp(paneId)}
          className={iconBtnCls(!pane.parentPath)}
          title="Parent Directory (Backspace)"
        >
          <CornerLeftUp className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void goRoot(paneId)}
          className={iconBtnCls(false)}
          title="Root Directory"
        >
          <HardDrive className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void goHome(paneId)}
          className={iconBtnCls(false)}
          title="Home Directory"
        >
          <Home className="w-3.5 h-3.5 text-emerald-400" />
        </button>
        <button
          type="button"
          onClick={() => void refreshPane(paneId)}
          className={iconBtnCls(false)}
          title="Refresh (Ctrl+R)"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${
              pane.loading ? 'animate-spin text-[#4da3ff]' : 'text-emerald-400'
            }`}
          />
        </button>
        <button
          type="button"
          onClick={() => toggleTreeSidebar(paneId)}
          className={iconBtnCls(false, pane.showTree)}
          title="Directory Tree / Quick Places"
        >
          <PanelLeft className="w-3.5 h-3.5 text-amber-300" />
        </button>

        <div className={`w-px h-4 mx-0.5 ${isDark ? 'bg-[#3f3f3f]' : 'bg-[#c8c8c8]'}`} />

        {/* History Back / Forward */}
        <button
          type="button"
          disabled={!canBack}
          onClick={() => void goBack(paneId)}
          className={iconBtnCls(!canBack)}
          title="Back"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          disabled={!canForward}
          onClick={() => void goForward(paneId)}
          className={iconBtnCls(!canForward)}
          title="Forward"
        >
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Row 2: WinSCP Local/Remote Files + Selection Action Toolbars */}
      <div
        className={`shrink-0 px-1.5 py-0.5 border-b flex items-center justify-between gap-1 flex-wrap ${
          isDark
            ? 'bg-[#252526] border-[#333333]'
            : 'bg-[#f5f5f5] border-[#d0d0d0]'
        }`}
      >
        <div className="flex items-center gap-0.5 flex-wrap">
          <button
            type="button"
            disabled={!hasTargets}
            onClick={() => openModal('copy', paneId)}
            className={labeledActionCls(!hasTargets)}
            title={`${t('pane.copy')} (F5)`}
          >
            <Copy className="w-3.5 h-3.5 text-[#4da3ff]" />
            {t('pane.copy')}
          </button>
          <button
            type="button"
            disabled={!hasTargets}
            onClick={() => openModal('move', paneId)}
            className={labeledActionCls(!hasTargets)}
            title={`${t('pane.move')} (F6)`}
          >
            <MoveRight className="w-3.5 h-3.5 text-emerald-400" />
            {t('pane.move')}
          </button>
          <button
            type="button"
            disabled={!hasTargets}
            onClick={() => void openFileInEditor(paneId)}
            className={labeledActionCls(!hasTargets)}
            title={`${t('pane.edit')} (F4)`}
          >
            <FileEdit className="w-3.5 h-3.5 text-amber-300" />
            {t('pane.edit')}
          </button>
          <button
            type="button"
            disabled={!hasTargets}
            onClick={() => openModal('delete', paneId)}
            className={iconBtnCls(!hasTargets)}
            title={`${t('pane.ctxDelete')} (F8)`}
          >
            <Trash2 className="w-3.5 h-3.5 text-red-400" />
          </button>
          <button
            type="button"
            disabled={!hasTargets}
            onClick={() => openModal('rename', paneId)}
            className={iconBtnCls(!hasTargets)}
            title={`${t('pane.ctxRename')} (F2)`}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            disabled={!hasTargets}
            onClick={() => openModal('properties', paneId)}
            className={labeledActionCls(!hasTargets)}
            title={`${t('pane.properties')} (F9)`}
          >
            <Info className="w-3.5 h-3.5 text-sky-400" />
            {t('pane.properties')}
          </button>

          <div className="relative" ref={newMenuRef}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setNewMenuOpen((prev) => !prev);
              }}
              className={labeledActionCls(false)}
              title={`${t('pane.ctxNewDir')} (F7) / ${t('pane.ctxNewFile')} (Shift+F4)`}
            >
              <FolderPlus className="w-3.5 h-3.5 text-amber-400" />
              {t('pane.new')}
              <ChevronDown className="w-3 h-3 opacity-75" />
            </button>
            {newMenuOpen && (
              <div
                className={`absolute left-0 top-full w-44 border shadow-xl z-50 py-1 ${
                  isDark
                    ? 'bg-[#252526] border-[#454545] text-[#e0e0e0]'
                    : 'bg-white border-[#c8c8c8] text-[#1e1e1e]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    setNewMenuOpen(false);
                    openModal('mkdir', paneId);
                  }}
                  className={`w-full px-2.5 py-1 text-left flex items-center justify-between text-[11px] ${
                    isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <FolderPlus className="w-3.5 h-3.5 text-amber-400" />
                    {t('pane.directory')}
                  </span>
                  <span className="text-[10px] opacity-70">F7</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNewMenuOpen(false);
                    openModal('newfile', paneId);
                  }}
                  className={`w-full px-2.5 py-1 text-left flex items-center justify-between text-[11px] ${
                    isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <FilePlus className="w-3.5 h-3.5 text-sky-400" />
                    {t('pane.file')}
                  </span>
                  <span className="text-[10px] opacity-70">Shift+F4</span>
                </button>
                {isRemoteSftp && (
                  <button
                    type="button"
                    onClick={() => {
                      setNewMenuOpen(false);
                      openModal('symlink', paneId);
                    }}
                    className={`w-full px-2.5 py-1 text-left flex items-center justify-between text-[11px] ${
                      isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <Link2 className="w-3.5 h-3.5 text-purple-400" />
                      {t('pane.symlink')}
                    </span>
                    <span className="text-[10px] opacity-70">SFTP</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setNewMenuOpen(false);
                    openModal('bookmarks', paneId);
                  }}
                  className={`w-full px-2.5 py-1 text-left flex items-center justify-between text-[11px] ${
                    isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <Bookmark className="w-3.5 h-3.5 text-amber-400" />
                    Location Bookmarks...
                  </span>
                  <span className="text-[10px] opacity-70">Ctrl+B</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Selection Toolbar Group (Select Files +, Unselect Files -, Select All) */}
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => openModal('filter', paneId)}
            className={iconBtnCls(false)}
            title="Select Files by Mask (+)"
          >
            <Plus className="w-3.5 h-3.5 text-[#4da3ff]" />
          </button>
          <button
            type="button"
            disabled={!hasExplicitSelection}
            onClick={() => clearSelection(paneId)}
            className={iconBtnCls(!hasExplicitSelection)}
            title="Unselect Files (-)"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => selectAll(paneId)}
            className={iconBtnCls(false)}
            title="Select All (Ctrl+A)"
          >
            <CheckSquare className="w-3.5 h-3.5 text-sky-400" />
          </button>
        </div>
      </div>

      {/* WinSCP PathLabel Bar: Royal Blue (#1e4b85) when active, Dark Gray (#2b2b2b) when inactive */}
      <div
        onDoubleClick={() => {
          setPathInput(pane.currentPath);
          setEditingPath(true);
        }}
        title="Click segment to navigate, double-click to edit path"
        className={`shrink-0 ${
          isMac ? 'h-[28px] px-2.5' : 'h-[22px] px-2'
        } border-b flex items-center gap-1 overflow-x-auto text-[11px] transition-colors ${
          isActive
            ? isMac
              ? isDark
                ? 'bg-[#0a84ff]/20 text-white border-[#0a84ff]/40'
                : 'bg-[#007aff]/12 text-[#0051a8] border-[#007aff]/25 font-medium'
              : 'bg-[#1e4b85] text-white border-[#2b6cb0]'
            : isMac
            ? isDark
              ? 'bg-[#242426] text-[#aeaeb2] border-white/10'
              : 'bg-[#ececed] text-[#3a3a3c] border-black/10'
            : isDark
            ? 'bg-[#2b2b2b] text-[#cccccc] border-[#3a3a3a]'
            : 'bg-[#dcdcdc] text-[#1e1e1e] border-[#c8c8c8]'
        }`}
      >
        {editingPath ? (
          <form
            className="w-full flex"
            onSubmit={(e) => {
              e.preventDefault();
              setEditingPath(false);
              if (pathInput.trim()) {
                void navigateTo(paneId, pathInput.trim(), true);
              }
            }}
          >
            <input
              autoFocus
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onBlur={() => setEditingPath(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditingPath(false);
              }}
              className={`w-full px-1.5 py-0 border text-[11px] font-mono outline-none ${
                isDark
                  ? 'bg-[#1e1e1e] border-[#4da3ff] text-white'
                  : 'bg-white border-[#0078d7] text-black'
              }`}
            />
          </form>
        ) : (
          <div className="flex items-center whitespace-nowrap">
            {pane.breadcrumbs.map((seg, i) => (
              <span key={seg.path} className="flex items-center">
                {i > 0 && <ChevronRight className="w-3 h-3 opacity-60 shrink-0 mx-0.5" />}
                <button
                  type="button"
                  onClick={() => void navigateTo(paneId, seg.path, true)}
                  className="hover:underline px-0.5 cursor-pointer"
                >
                  {seg.label}
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Main Pane Area: Optional Places Tree Sidebar + Virtualized File Table */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {pane.showTree && (
          <aside
            className={`w-40 shrink-0 border-r overflow-y-auto scpcraft-scroll p-1 text-[11px] ${
              isDark
                ? 'bg-[#222222] border-[#333333]'
                : 'bg-[#f5f5f5] border-[#d0d0d0]'
            }`}
          >
            <div
              className={`text-[10px] font-semibold uppercase px-1.5 py-1 ${
                isDark ? 'text-[#888888]' : 'text-[#666666]'
              }`}
            >
              Quick Places
            </div>
            {isRemoteSftp ? (
              <>
                {REMOTE_QUICK_PATHS.map((qp) => {
                  const active = pane.currentPath === qp.path;
                  return (
                    <button
                      key={qp.path}
                      type="button"
                      onClick={() => void navigateTo(paneId, qp.path, true)}
                      className={`w-full flex items-center gap-1.5 px-1.5 py-0.5 text-left truncate ${
                        active
                          ? 'bg-[#1e4b85] text-white font-medium'
                          : isDark
                          ? 'hover:bg-[#333333] text-[#dcdcdc]'
                          : 'hover:bg-[#e1e1e1] text-[#1e1e1e]'
                      }`}
                    >
                      <Folder className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
                      <span className="truncate">{qp.label}</span>
                    </button>
                  );
                })}
                <div
                  className={`text-[10px] font-semibold uppercase px-1.5 pt-2 pb-1 flex items-center justify-between ${
                    isDark ? 'text-[#888888]' : 'text-[#666666]'
                  }`}
                >
                  <span>Bookmarks</span>
                  <button
                    type="button"
                    onClick={() => openModal('bookmarks', 'right')}
                    className="text-[10px] text-[#4da3ff] hover:underline normal-case font-normal"
                  >
                    Manage
                  </button>
                </div>
                {bookmarks.map((bm) => {
                  const active = pane.currentPath === bm.remotePath;
                  return (
                    <button
                      key={bm.id}
                      type="button"
                      onClick={() => void navigateTo(paneId, bm.remotePath, true)}
                      className={`w-full flex items-center gap-1.5 px-1.5 py-0.5 text-left truncate ${
                        active
                          ? 'bg-[#1e4b85] text-white font-medium'
                          : isDark
                          ? 'hover:bg-[#333333] text-[#dcdcdc]'
                          : 'hover:bg-[#e1e1e1] text-[#1e1e1e]'
                      }`}
                      title={bm.remotePath}
                    >
                      <Bookmark className="w-3 h-3 shrink-0 text-amber-400" />
                      <span className="truncate">{bm.name}</span>
                    </button>
                  );
                })}
              </>
            ) : (
              drives.map((d) => {
                const active =
                  pane.currentPath.toLowerCase() === d.path.toLowerCase();
                return (
                  <button
                    key={`${d.kind}-${d.path}`}
                    type="button"
                    onClick={() => void navigateTo(paneId, d.path, true)}
                    className={`w-full flex items-center gap-1.5 px-1.5 py-0.5 text-left truncate ${
                      active
                        ? 'bg-[#1e4b85] text-white font-medium'
                        : isDark
                        ? 'hover:bg-[#333333] text-[#dcdcdc]'
                        : 'hover:bg-[#e1e1e1] text-[#1e1e1e]'
                    }`}
                  >
                    {d.kind === 'drive' ||
                    d.kind === 'root' ||
                    d.kind === 'volume' ? (
                      <HardDrive className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                    ) : (
                      <Folder className="w-3.5 h-3.5 shrink-0 text-[#eab308]" />
                    )}
                    <span className="truncate">{d.name}</span>
                  </button>
                );
              })
            )}
          </aside>
        )}

        <div className="flex-1 flex flex-col min-w-0 min-h-0 relative">
          {/* WinSCP TDirView Header: Name | Size | Type | Date modified | Ext | Attr */}
          <div
            className={`shrink-0 grid ${TABLE_GRID_COLS} items-center ${
              isMac ? 'h-[28px] font-medium' : 'h-[22px] font-normal'
            } text-[11px] border-b ${
              isMac
                ? isDark
                  ? 'bg-[#242426] border-white/10 text-[#aeaeb2]'
                  : 'bg-[#f5f5f7] border-black/10 text-[#6e6e73]'
                : isDark
                ? 'bg-[#252526] border-[#383838] text-[#cccccc]'
                : 'bg-[#f0f0f0] border-[#cccccc] text-[#333333]'
            }`}
          >
            <button
              type="button"
              onClick={() => setSort(paneId, 'name')}
              className={`h-full px-1.5 text-left truncate hover:text-[#4da3ff] ${colDividerCls}`}
            >
              {t('pane.colName')}{renderSortIcon('name')}
            </button>
            <button
              type="button"
              onClick={() => setSort(paneId, 'size')}
              className={`h-full px-1.5 text-right truncate hover:text-[#4da3ff] ${colDividerCls}`}
            >
              {t('pane.colSize')}{renderSortIcon('size')}
            </button>
            <button
              type="button"
              onClick={() => setSort(paneId, 'type')}
              className={`h-full px-1.5 text-left truncate hover:text-[#4da3ff] ${colDividerCls}`}
            >
              {t('pane.colType')}{renderSortIcon('type')}
            </button>
            <button
              type="button"
              onClick={() => setSort(paneId, 'modified')}
              className={`h-full px-1.5 text-left truncate hover:text-[#4da3ff] ${colDividerCls}`}
            >
              {t('pane.colModified')}{renderSortIcon('modified')}
            </button>
            <button
              type="button"
              onClick={() => setSort(paneId, 'ext')}
              className={`h-full px-1.5 text-left truncate hover:text-[#4da3ff] ${colDividerCls}`}
            >
              {t('pane.colExt')}{renderSortIcon('ext')}
            </button>
            <button
              type="button"
              onClick={() => setSort(paneId, 'attr')}
              className="h-full px-1.5 text-left truncate hover:text-[#4da3ff]"
            >
              {t('pane.colAttr')}{renderSortIcon('attr')}
            </button>
          </div>

          {/* Error Banner */}
          {pane.error && (
            <div className="px-2 py-1 text-xs bg-red-500/20 border-b border-red-500/40 text-red-300">
              {pane.error}
            </div>
          )}

          {/* Virtualized Rows (21px dense rows with vertical gridlines) */}
          <div
            ref={scrollParentRef}
            onContextMenu={(e) => {
              e.preventDefault();
              setActivePane(paneId);
              setContextMenu({ x: e.clientX, y: e.clientY, entry: null });
            }}
            className="flex-1 overflow-y-auto scpcraft-scroll relative"
          >
            {pane.loading ? (
              <div className="h-full w-full flex flex-col items-center justify-center gap-3 select-none">
                <Loader2 className="w-7 h-7 animate-spin text-[#4da3ff]" />
                <span className={`text-xs ${isDark ? 'text-[#a1a1a6]' : 'text-slate-500'}`}>
                  {t('pane.loadingDir')}
                </span>
                <button
                  type="button"
                  onClick={() => cancelNavigation(paneId)}
                  className={`px-3.5 py-1.5 text-xs font-medium border transition-colors ${
                    isMac
                      ? isDark
                        ? 'rounded-md bg-white/10 border-white/15 text-[#f5f5f7] hover:bg-white/15'
                        : 'rounded-md bg-white border-black/15 text-[#1d1d1f] hover:bg-black/5 shadow-2xs'
                      : isDark
                      ? 'bg-[#2d2d30] border-[#454545] text-[#e0e0e0] hover:bg-[#3a3a3e]'
                      : 'bg-[#e1e1e1] border-[#adadad] text-[#1e1e1e] hover:bg-[#e5f1fb]'
                  }`}
                >
                  {t('site.cancel')}
                </button>
              </div>
            ) : (
            <div
              style={{
                height: `${rowVirtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {rowVirtualizer.getVirtualItems().map((vRow) => {
                const row = rows[vRow.index];
                const isFocused = pane.focusedPath === row.key;

                if (row.kind === 'parent') {
                  return (
                    <div
                      key="__PARENT__"
                      onClick={(e) => handleRowClick(e, row)}
                      onDoubleClick={() => handleRowDoubleClick(row)}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: `${vRow.size}px`,
                        transform: `translateY(${vRow.start}px)`,
                      }}
                      className={`grid ${TABLE_GRID_COLS} items-center text-[11px] cursor-pointer ${
                        isFocused && isActive
                          ? isDark
                            ? 'bg-[#264f78] text-white ring-1 ring-inset ring-[#3b82f6]'
                            : 'bg-[#cce4f7] text-black ring-1 ring-inset ring-[#0078d7]'
                          : isDark
                          ? 'hover:bg-[#2a2d2e]'
                          : 'hover:bg-[#f0f6fc]'
                      }`}
                    >
                      <div className={`h-full px-1.5 flex items-center gap-1.5 truncate ${colDividerCls}`}>
                        <FolderUp className="w-3.5 h-3.5 text-[#eab308] shrink-0" />
                        <span>..</span>
                      </div>
                      <span className={`h-full px-1.5 ${colDividerCls}`} />
                      <span
                        className={`h-full px-1.5 flex items-center truncate ${
                          isDark ? 'text-[#9e9e9e]' : 'text-[#555555]'
                        } ${colDividerCls}`}
                      >
                        {t('pane.parentDirRow')}
                      </span>
                      <span className={`h-full px-1.5 ${colDividerCls}`} />
                      <span className={`h-full px-1.5 ${colDividerCls}`} />
                      <span className="h-full px-1.5" />
                    </div>
                  );
                }

                const entry = row.entry;
                const isSelected = selectedSet.has(entry.path);
                const isDir = isDirEntry(entry);
                const isSymlink =
                  entry.fileType === 'symlink' ||
                  entry.fileType === 'symlink_dir';
                const dimmed = isEntryDimmed(entry);

                const entryIsDir = isDirEntry(entry);
                const isSubdirDropHover =
                  entryIsDir &&
                  Boolean(internalDrag?.active) &&
                  internalDrag?.dropTargetPane === paneId &&
                  internalDrag?.dropTargetDir === entry.path &&
                  !(
                    internalDrag?.sourcePane === paneId &&
                    internalDrag?.sources.includes(entry.path)
                  );
                return (
                  <div
                    key={entry.path}
                    data-drop-dir={entryIsDir ? entry.path : undefined}
                    onMouseDown={(e) => {
                      if (
                        e.button === 0 &&
                        !e.shiftKey &&
                        !e.ctrlKey &&
                        !e.metaKey
                      ) {
                        const sources =
                          isSelected && pane.selectedPaths.length > 0
                            ? pane.selectedPaths
                            : [entry.path];
                        beginPointerDrag(paneId, sources, e.clientX, e.clientY);
                      }
                    }}
                    onClick={(e) => handleRowClick(e, row)}
                    onDoubleClick={() => handleRowDoubleClick(row)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setActivePane(paneId);
                      if (!isSelected) {
                        selectSingle(paneId, entry.path);
                      }
                      setContextMenu({ x: e.clientX, y: e.clientY, entry });
                    }}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${vRow.size}px`,
                      transform: `translateY(${vRow.start}px)`,
                    }}
                    className={`grid ${TABLE_GRID_COLS} items-center text-[11px] cursor-pointer ${
                      isSelected
                        ? isDark
                          ? 'bg-[#264f78] text-white'
                          : 'bg-[#cce4f7] text-[#003366]'
                        : isDark
                        ? 'hover:bg-[#2a2d2e]'
                        : 'hover:bg-[#f0f6fc]'
                    } ${
                      isFocused && isActive
                        ? 'ring-1 ring-inset ring-[#3b82f6]/80'
                        : ''
                    } ${
                      isSubdirDropHover
                        ? 'bg-emerald-500/25 ring-1 ring-inset ring-emerald-400'
                        : ''
                    } ${dimmed ? 'opacity-50' : ''}`}
                  >
                    <div
                      className={`h-full px-1.5 flex items-center gap-1.5 truncate ${colDividerCls}`}
                    >
                      {isSymlink ? (
                        <Link2 className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                      ) : isDir ? (
                        <Folder className="w-3.5 h-3.5 text-[#eab308] fill-[#eab308] shrink-0" />
                      ) : (
                        <File className="w-3.5 h-3.5 text-[#9cdcfe] shrink-0" />
                      )}
                      <span className="truncate">{entry.name}</span>
                    </div>
                    <span
                      className={`h-full px-1.5 flex items-center justify-end tabular-nums ${colDividerCls}`}
                    >
                      {isDir ? '' : formatSizeKB(entry.size)}
                    </span>
                    <span
                      className={`h-full px-1.5 flex items-center truncate ${
                        isSelected
                          ? ''
                          : isDark
                          ? 'text-[#9e9e9e]'
                          : 'text-[#555555]'
                      } ${colDividerCls}`}
                    >
                      {getFileTypeDescription(entry)}
                    </span>
                    <span
                      className={`h-full px-1.5 flex items-center truncate tabular-nums ${
                        isSelected
                          ? ''
                          : isDark
                          ? 'text-[#9e9e9e]'
                          : 'text-[#555555]'
                      } ${colDividerCls}`}
                    >
                      {formatDateTime(entry.modifiedMs)}
                    </span>
                    <span
                      className={`h-full px-1.5 flex items-center truncate ${
                        isSelected
                          ? ''
                          : isDark
                          ? 'text-[#9e9e9e]'
                          : 'text-[#555555]'
                      } ${colDividerCls}`}
                    >
                      {entry.extension}
                    </span>
                    <span
                      className={`h-full px-1.5 flex items-center truncate font-mono text-[10px] ${
                        isSelected
                          ? ''
                          : isDark
                          ? 'text-[#9e9e9e]'
                          : 'text-[#555555]'
                      }`}
                    >
                      {entry.permissionsText}
                    </span>
                  </div>
                );
              })}
            </div>
            )}
          </div>
        </div>
      </div>

      {/* WinSCP TTBXStatusBar: "0 B of 14.5 GB in 0 of 43" */}
      <div
        className={`shrink-0 h-5 px-2 border-t flex items-center justify-between text-[11px] ${
          isDark
            ? 'bg-[#252526] border-[#333333] text-[#a8a8a8]'
            : 'bg-[#f0f0f0] border-[#cccccc] text-[#444444]'
        }`}
      >
        <span className="truncate">
          {`${formatBytes(selectedBytes)} of ${formatBytes(pane.totalBytes)} in ${
            selectedEntries.length
          } of ${totalItemsCount}`}
        </span>
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => void toggleShowHidden(paneId)}
            className={`hover:underline ${
              pane.showHidden ? 'text-[#4da3ff] font-medium' : ''
            }`}
            title="Ctrl+Alt+H"
          >
            {t('pane.hiddenCount')} {pane.hiddenCount} {pane.showHidden ? t('pane.shown') : ''}
          </button>
          <button
            type="button"
            onClick={() => openModal('filter', paneId)}
            className={`hover:underline ${
              pane.filterMask !== '*' ? 'text-amber-400 font-medium' : ''
            }`}
            title="Ctrl+F"
          >
            {t('pane.filterLabel')} {pane.filterMask}
          </button>
        </div>
      </div>

      {/* Right-click Context Menu */}
      {contextMenu && (
        <div
          style={{ top: contextMenu.y, left: contextMenu.x }}
          className={`fixed z-50 w-52 border shadow-xl py-1 text-[11px] ${
            isDark
              ? 'bg-[#252526] border-[#454545] text-[#e0e0e0]'
              : 'bg-white border-[#c8c8c8] text-[#1e1e1e]'
          }`}
        >
          {contextMenu.entry && (
            <>
              <button
                type="button"
                onClick={() => openModal('copy', paneId)}
                className={`w-full px-3 py-1 text-left flex justify-between ${
                  isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                }`}
              >
                <span>{t('pane.ctxCopy')}</span>
                <span className="opacity-70">F5</span>
              </button>
              <button
                type="button"
                onClick={() => openModal('move', paneId)}
                className={`w-full px-3 py-1 text-left flex justify-between ${
                  isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                }`}
              >
                <span>{t('pane.ctxMove')}</span>
                <span className="opacity-70">F6</span>
              </button>
              <button
                type="button"
                onClick={() => void openFileInEditor(paneId)}
                className={`w-full px-3 py-1 text-left flex justify-between ${
                  isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                }`}
              >
                <span>{t('pane.edit')}</span>
                <span className="opacity-70">F4</span>
              </button>
              <button
                type="button"
                onClick={() => openModal('rename', paneId)}
                className={`w-full px-3 py-1 text-left flex justify-between ${
                  isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                }`}
              >
                <span>{t('pane.ctxRename')}</span>
                <span className="opacity-70">F2</span>
              </button>
              <button
                type="button"
                onClick={() => openModal('delete', paneId)}
                className={`w-full px-3 py-1 text-left flex justify-between text-red-400 ${
                  isDark ? 'hover:bg-red-500/20' : 'hover:bg-red-50'
                }`}
              >
                <span>{t('pane.ctxDelete')}</span>
                <span className="opacity-70">F8</span>
              </button>
              <button
                type="button"
                onClick={() => openModal('properties', paneId)}
                className={`w-full px-3 py-1 text-left flex justify-between ${
                  isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                }`}
              >
                <span>{t('pane.properties')}</span>
                <span className="opacity-70">F9</span>
              </button>
              <div
                className={`my-1 border-t ${
                  isDark ? 'border-[#3a3a3a]' : 'border-[#e0e0e0]'
                }`}
              />
            </>
          )}
          <button
            type="button"
            onClick={() => openModal('mkdir', paneId)}
            className={`w-full px-3 py-1 text-left flex justify-between ${
              isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
            }`}
          >
            <span>{t('pane.ctxNewDir')}</span>
            <span className="opacity-70">F7</span>
          </button>
          <button
            type="button"
            onClick={() => openModal('newfile', paneId)}
            className={`w-full px-3 py-1 text-left flex justify-between ${
              isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
            }`}
          >
            <span>{t('pane.ctxNewFile')}</span>
            <span className="opacity-70">Shift+F4</span>
          </button>
          {isRemoteSftp && (
            <button
              type="button"
              onClick={() => openModal('symlink', paneId)}
              className={`w-full px-3 py-1 text-left flex justify-between ${
                isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
              }`}
            >
              <span>{t('pane.ctxSymlink')}</span>
              <span className="opacity-70">SFTP</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => openModal('bookmarks', paneId)}
            className={`w-full px-3 py-1 text-left flex justify-between ${
              isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
            }`}
          >
            <span>{t('pane.ctxBookmarks')}</span>
            <span className="opacity-70">Ctrl+B</span>
          </button>
          <div
            className={`my-1 border-t ${
              isDark ? 'border-[#3a3a3a]' : 'border-[#e0e0e0]'
            }`}
          />
          <button
            type="button"
            onClick={() => selectAll(paneId)}
            className={`w-full px-3 py-1 text-left flex justify-between ${
              isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
            }`}
          >
            <span>{t('pane.ctxSelectAll')}</span>
            <span className="opacity-70">Ctrl+A</span>
          </button>
          <button
            type="button"
            onClick={() => clearSelection(paneId)}
            className={`w-full px-3 py-1 text-left ${
              isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
            }`}
          >
            {t('pane.ctxClearSel')}
          </button>
          <button
            type="button"
            onClick={() => void refreshPane(paneId)}
            className={`w-full px-3 py-1 text-left flex justify-between ${
              isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
            }`}
          >
            <span>{t('pane.ctxRefresh')}</span>
            <span className="opacity-70">Ctrl+R</span>
          </button>
        </div>
      )}
    </div>
  );
}
