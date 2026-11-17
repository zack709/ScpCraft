import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Edit3,
  Eye,
  EyeOff,
  Folder,
  FolderPlus,
  HelpCircle,
  KeyRound,
  LogIn,
  Monitor,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { translate, type TranslationKey } from '../../i18n';
import { useSiteStore } from '../../stores/useSiteStore';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { isMacOS } from '../../utils/platform';
import type { FtpsMode, SiteConfig, SiteProtocol, SiteSearchMode } from '../../types/site';

type SubPromptState =
  | null
  | { kind: 'saveAs'; name: string; folder: string }
  | { kind: 'rename'; name: string }
  | { kind: 'newFolder'; name: string; assignToDraft?: boolean }
  | { kind: 'pasteUrl'; url: string }
  | { kind: 'generateUrl'; url: string; cli: string; includePwd: boolean }
  | { kind: 'importYaml'; text: string }
  | { kind: 'exportYaml'; text: string }
  | { kind: 'help' };

type TreeContextMenuState =
  | null
  | {
      x: number;
      y: number;
      target:
        | { kind: 'site'; site: SiteConfig }
        | { kind: 'folder'; folder: string }
        | { kind: 'empty' };
    };

function matchesSearch(site: SiteConfig, query: string, mode: SiteSearchMode): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (mode === 'prefix') {
    return site.name.toLowerCase().startsWith(q);
  }
  if (mode === 'substring') {
    return site.name.toLowerCase().includes(q) || (site.folder?.toLowerCase().includes(q) ?? false);
  }
  return (
    site.name.toLowerCase().includes(q) ||
    site.hostName.toLowerCase().includes(q) ||
    site.userName.toLowerCase().includes(q) ||
    site.protocol.toLowerCase().includes(q) ||
    site.note.toLowerCase().includes(q) ||
    (site.folder?.toLowerCase().includes(q) ?? false)
  );
}

export function SiteManagerModal() {
  const { theme, locale } = useWorkspaceStore();
  const t = (key: TranslationKey) => translate(locale, key);
  const isMac = isMacOS();
  const {
    isLoginDialogOpen,
    closeLoginDialog,
    openAdvancedDialog,
    sites,
    folders,
    showLoginOnStartup,
    selection,
    expandedFolders,
    searchQuery,
    searchMode,
    isEditingSavedSite,
    draftSite,
    draftPassword,
    busy,
    error,
    notice,
    clearNotice,
    setSearchQuery,
    setSearchMode,
    toggleFolderExpanded,
    selectNewSite,
    selectFolder,
    selectSite,
    beginEditSelected,
    cancelEditSelected,
    updateDraft,
    setProtocol,
    setFtpsMode,
    setDraftPassword,
    saveDraft,
    deleteSelectedSite,
    renameSelectedSite,
    cloneSelectedSite,
    createFolder,
    deleteSelectedFolder,
    moveSiteToFolder,
    setShowLoginOnStartup,
    importFromYamlText,
    exportToYamlText,
    pasteSessionUrl,
    generateSessionUrl,
    loginWithCurrent,
  } = useSiteStore();

  const [toolsOpen, setToolsOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [searchMenuOpen, setSearchMenuOpen] = useState(false);
  const [showPasswordText, setShowPasswordText] = useState(false);
  const [subPrompt, setSubPrompt] = useState<SubPromptState>(null);
  const [dragState, setDragState] = useState<null | {
    siteId: string;
    siteName: string;
    x: number;
    y: number;
  }>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [treeContextMenu, setTreeContextMenu] = useState<TreeContextMenuState>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const manageRef = useRef<HTMLDivElement>(null);
  const searchMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const pendingDragRef = useRef<null | {
    siteId: string;
    siteName: string;
    startX: number;
    startY: number;
    active: boolean;
  }>(null);
  const dragOverTargetRef = useRef<string | null>(null);
  const justDraggedRef = useRef(false);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (toolsRef.current && !toolsRef.current.contains(target)) setToolsOpen(false);
      if (manageRef.current && !manageRef.current.contains(target)) setManageOpen(false);
      if (searchMenuRef.current && !searchMenuRef.current.contains(target)) setSearchMenuOpen(false);
      if (contextMenuRef.current && !contextMenuRef.current.contains(target)) {
        setTreeContextMenu(null);
      }
    };
    const onMove = (e: MouseEvent) => {
      const pending = pendingDragRef.current;
      if (!pending) return;
      if (!pending.active) {
        if (Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY) < 5) {
          return;
        }
        pending.active = true;
      }
      setDragState({
        siteId: pending.siteId,
        siteName: pending.siteName,
        x: e.clientX,
        y: e.clientY,
      });
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const dropEl = el?.closest('[data-drop-folder]') as HTMLElement | null;
      const targetFolder = dropEl?.getAttribute('data-drop-folder') ?? null;
      dragOverTargetRef.current = targetFolder;
      setDragOverTarget(targetFolder);
    };
    const onUp = () => {
      const pending = pendingDragRef.current;
      if (!pending) return;
      pendingDragRef.current = null;
      const target = dragOverTargetRef.current;
      dragOverTargetRef.current = null;
      setDragState(null);
      setDragOverTarget(null);
      if (pending.active) {
        justDraggedRef.current = true;
        setTimeout(() => {
          justDraggedRef.current = false;
        }, 0);
        if (target === '__root__') {
          void moveSiteToFolder(pending.siteId, null);
        } else if (target) {
          void moveSiteToFolder(pending.siteId, target);
        }
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [moveSiteToFolder]);

  const filteredSites = useMemo(
    () => sites.filter((s) => matchesSearch(s, searchQuery, searchMode)),
    [sites, searchQuery, searchMode]
  );

  const visibleFolders = useMemo(() => {
    if (!searchQuery.trim()) return folders;
    const withMatches = new Set(
      filteredSites.map((s) => s.folder).filter((f): f is string => Boolean(f))
    );
    return folders.filter(
      (f) => withMatches.has(f) || f.toLowerCase().includes(searchQuery.trim().toLowerCase())
    );
  }, [folders, filteredSites, searchQuery]);

  const rootSites = useMemo(
    () => filteredSites.filter((s) => !s.folder),
    [filteredSites]
  );

  const folderChildren = useMemo(() => {
    if (selection.kind !== 'folder') return [];
    return sites.filter((s) => s.folder === selection.folder);
  }, [sites, selection]);

  if (!isLoginDialogOpen) return null;

  const isDark = theme === 'dark';
  const isSavedSite = selection.kind === 'site';
  const editable = !isSavedSite || isEditingSavedSite;
  const encryptionEnabled =
    draftSite.protocol === 'ftp' ||
    draftSite.protocol === 'webdav' ||
    draftSite.protocol === 's3';

  const inputCls = `w-full ${
    isMac ? 'h-[30px] px-2.5 rounded-md' : 'h-[23px] px-2'
  } border text-xs outline-none ${
    isDark
      ? 'bg-[#1e1e1e] border-[#3f3f3f] text-[#e0e0e0] focus:border-[#4da3ff] disabled:bg-[#242425] disabled:text-[#999999]'
      : 'bg-white border-[#b8b8b8] text-[#1e1e1e] focus:border-[#0078d7] disabled:bg-[#f0f0f0] disabled:text-slate-600'
  }`;

  const dialogBtnCls = `${
    isMac ? 'h-[30px] px-3.5 rounded-md' : 'h-[25px] px-3'
  } border text-xs whitespace-nowrap inline-flex items-center justify-center gap-1.5 transition-colors ${
    isDark
      ? 'bg-[#2d2d30] border-[#454545] text-[#e0e0e0] hover:bg-[#3a3a3e] disabled:opacity-45 disabled:pointer-events-none'
      : 'bg-[#e1e1e1] border-[#adadad] text-[#1e1e1e] hover:bg-[#e5f1fb] hover:border-[#0078d7] disabled:opacity-45 disabled:pointer-events-none'
  }`;

  const handleOpenGenerateUrl = async (includePwd: boolean) => {
    try {
      const res = await generateSessionUrl(includePwd);
      setSubPrompt({
        kind: 'generateUrl',
        url: res.url,
        cli: res.cliCommand,
        includePwd,
      });
    } catch {
      // ignore if error set in store
    }
  };

  const handleOpenExportYaml = async () => {
    const yamlText = await exportToYamlText();
    setSubPrompt({ kind: 'exportYaml', text: yamlText });
  };

  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    await importFromYamlText(text);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 select-none"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeLoginDialog();
      }}
    >
      <div
        className={`${
          isMac ? 'w-[840px] rounded-xl overflow-hidden' : 'w-[680px]'
        } max-w-full border shadow-2xl flex flex-col text-xs ${
          isDark
            ? 'bg-[#252526] border-[#454545] text-[#e0e0e0]'
            : 'bg-[#f0f0f0] border-[#999999] text-[#1e1e1e]'
        }`}
      >
        {/* Title bar matching Login – WinSCP */}
        <div
          className={`flex items-center justify-between px-3 py-1.5 border-b ${
            isDark ? 'bg-[#1f1f1f] border-[#383838]' : 'bg-white border-[#d0d0d0]'
          }`}
        >
          <div className="flex items-center gap-2 font-medium">
            <Monitor className="w-3.5 h-3.5 text-[#4da3ff]" />
            <span>{t('site.title')}</span>
          </div>
          <button
            type="button"
            onClick={closeLoginDialog}
            className="opacity-70 hover:opacity-100 p-0.5"
            aria-label="Close Login Dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Hidden file input for Import YAML (.yml) */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".yml,.yaml"
          className="hidden"
          onChange={handleFileChosen}
        />

        {/* Dual Pane Body: SitesPanel + MainPanel */}
        <div
          className={`flex min-h-0 ${
            isMac ? 'gap-3.5 p-3.5 h-[470px]' : 'gap-2.5 p-2.5 h-[398px]'
          }`}
        >
          {/* Left pane: SitesPanel */}
          <div className={`${isMac ? 'w-[280px]' : 'w-[248px]'} shrink-0 flex flex-col min-h-0`}>
            <div
              className={`flex-1 border flex flex-col min-h-0 ${
                isDark ? 'bg-[#1e1e1e] border-[#3f3f3f]' : 'bg-white border-[#b8b8b8]'
              }`}
            >
              {/* SessionTree */}
              <div
                data-drop-folder="__root__"
                className={`flex-1 overflow-y-auto scpcraft-scroll p-1 space-y-0.5 ${
                  dragState && dragOverTarget === '__root__'
                    ? isDark
                      ? 'ring-1 ring-inset ring-[#4da3ff] bg-[#1e4b85]/15'
                      : 'ring-1 ring-inset ring-[#0078d7] bg-[#e5f1fb]/50'
                    : ''
                }`}
                onContextMenu={(e) => {
                  if (e.target === e.currentTarget) {
                    e.preventDefault();
                    setTreeContextMenu({ x: e.clientX, y: e.clientY, target: { kind: 'empty' } });
                  }
                }}
              >
                {/* Fixed top item: New Site + New Folder */}
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={selectNewSite}
                    className={`flex-1 min-w-0 flex items-center gap-1.5 px-1.5 py-1 text-left ${
                      selection.kind === 'newSite'
                        ? 'bg-[#1e4b85] text-white'
                        : isDark
                        ? 'hover:bg-[#2c2c2e] text-[#e0e0e0]'
                        : 'hover:bg-[#e5f1fb] text-[#1e1e1e]'
                    }`}
                  >
                    <span className="relative inline-flex items-center shrink-0">
                      <Monitor className="w-3.5 h-3.5 text-sky-400" />
                      <Sparkles className="w-2.5 h-2.5 text-amber-300 -ml-1 -mt-2" />
                    </span>
                    <span className="truncate font-medium">{t('site.newSite')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSubPrompt({ kind: 'newFolder', name: '' })}
                    title={t('site.createFolderTip')}
                    aria-label={t('site.createFolderTip')}
                    className={`px-1.5 py-1 shrink-0 border ${
                      isDark
                        ? 'border-[#3a3a3c] hover:bg-[#2c2c2e] text-[#eab308]'
                        : 'border-[#d0d0d0] hover:bg-[#e5f1fb] text-[#b45309]'
                    }`}
                  >
                    <FolderPlus className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Expandable Folder Groups */}
                {visibleFolders.map((folder) => {
                  const expanded = expandedFolders.includes(folder) || Boolean(searchQuery.trim());
                  const folderSelected =
                    selection.kind === 'folder' && selection.folder === folder;
                  const children = filteredSites.filter((s) => s.folder === folder);
                  const isDragOver = dragOverTarget === folder;

                  return (
                    <div
                      key={folder}
                      data-drop-folder={folder}
                      onMouseEnter={() => {
                        if (pendingDragRef.current?.active) {
                          dragOverTargetRef.current = folder;
                          setDragOverTarget(folder);
                        }
                      }}
                      onMouseLeave={() => {
                        if (pendingDragRef.current?.active && dragOverTargetRef.current === folder) {
                          dragOverTargetRef.current = '__root__';
                          setDragOverTarget('__root__');
                        }
                      }}
                    >
                      <div
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          selectFolder(folder);
                          setTreeContextMenu({
                            x: e.clientX,
                            y: e.clientY,
                            target: { kind: 'folder', folder },
                          });
                        }}
                        className={`flex items-center gap-1 px-1 py-0.5 cursor-pointer ${
                          isDragOver
                            ? isDark
                              ? 'ring-1 ring-[#4da3ff] bg-[#1e4b85]/40 text-white'
                              : 'ring-1 ring-[#0078d7] bg-[#cfe4f7] text-[#1e1e1e]'
                            : folderSelected
                            ? 'bg-[#1e4b85] text-white'
                            : isDark
                            ? 'hover:bg-[#2c2c2e] text-[#dcdcdc]'
                            : 'hover:bg-[#e5f1fb] text-[#1e1e1e]'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleFolderExpanded(folder);
                          }}
                          className="p-0.5 opacity-80 hover:opacity-100"
                          aria-label={`Toggle ${folder}`}
                        >
                          {expanded ? (
                            <ChevronDown className="w-3 h-3" />
                          ) : (
                            <ChevronRight className="w-3 h-3" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => selectFolder(folder)}
                          onDoubleClick={() => toggleFolderExpanded(folder)}
                          className="flex-1 flex items-center gap-1.5 text-left min-w-0 py-0.5"
                        >
                          <Folder className="w-3.5 h-3.5 text-[#eab308] shrink-0 fill-[#eab308]/25" />
                          <span className="truncate flex-1">{folder}</span>
                          <span className="text-[10px] opacity-60 shrink-0 pr-0.5">
                            ({children.length})
                          </span>
                        </button>
                      </div>

                      {expanded && (
                        <div
                          className={`ml-3 pl-2.5 border-l space-y-0.5 mt-0.5 ${
                            isDark ? 'border-[#454548]' : 'border-[#c4c4c4]'
                          }`}
                        >
                          {children.map((site) => {
                            const selected =
                              selection.kind === 'site' && selection.siteId === site.id;
                            return (
                              <div
                                key={site.id}
                                role="button"
                                tabIndex={0}
                                onMouseDown={(e) => {
                                  if (e.button !== 0) return;
                                  e.preventDefault();
                                  pendingDragRef.current = {
                                    siteId: site.id,
                                    siteName: site.name,
                                    startX: e.clientX,
                                    startY: e.clientY,
                                    active: false,
                                  };
                                }}
                                onClick={() => {
                                  if (justDraggedRef.current) return;
                                  void selectSite(site.id, false);
                                }}
                                onDoubleClick={() =>
                                  void selectSite(site.id, false).then(() => loginWithCurrent())
                                }
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  void selectSite(site.id, false);
                                  setTreeContextMenu({
                                    x: e.clientX,
                                    y: e.clientY,
                                    target: { kind: 'site', site },
                                  });
                                }}
                                className={`w-full flex items-center gap-1.5 pr-1.5 pl-0.5 py-0.5 text-left select-none cursor-pointer ${
                                  selected
                                    ? 'bg-[#1e4b85] text-white'
                                    : isDark
                                    ? 'hover:bg-[#2c2c2e] text-[#dcdcdc]'
                                    : 'hover:bg-[#e5f1fb] text-[#1e1e1e]'
                                }`}
                              >
                                <span
                                  className={`w-2 h-px shrink-0 ${
                                    isDark ? 'bg-[#454548]' : 'bg-[#c4c4c4]'
                                  }`}
                                />
                                <Monitor
                                  className="w-3.5 h-3.5 shrink-0"
                                  style={{ color: site.color ?? '#38bdf8' }}
                                />
                                <span className="truncate">{site.name}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Root-level Sites */}
                {rootSites.map((site) => {
                  const selected = selection.kind === 'site' && selection.siteId === site.id;
                  return (
                    <div
                      key={site.id}
                      role="button"
                      tabIndex={0}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        pendingDragRef.current = {
                          siteId: site.id,
                          siteName: site.name,
                          startX: e.clientX,
                          startY: e.clientY,
                          active: false,
                        };
                      }}
                      onClick={() => {
                        if (justDraggedRef.current) return;
                        void selectSite(site.id, false);
                      }}
                      onDoubleClick={() =>
                        void selectSite(site.id, false).then(() => loginWithCurrent())
                      }
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void selectSite(site.id, false);
                        setTreeContextMenu({
                          x: e.clientX,
                          y: e.clientY,
                          target: { kind: 'site', site },
                        });
                      }}
                      className={`w-full flex items-center gap-1.5 px-1.5 py-0.5 text-left select-none cursor-pointer ${
                        selected
                          ? 'bg-[#1e4b85] text-white'
                          : isDark
                          ? 'hover:bg-[#2c2c2e] text-[#dcdcdc]'
                          : 'hover:bg-[#e5f1fb] text-[#1e1e1e]'
                      }`}
                    >
                      <Monitor
                        className="w-3.5 h-3.5 shrink-0"
                        style={{ color: site.color ?? '#38bdf8' }}
                      />
                      <span className="truncate">{site.name}</span>
                    </div>
                  );
                })}
              </div>

              {/* Incremental Search Bar inside SessionTree */}
              <div
                className={`border-t px-1.5 py-1 flex items-center gap-1 ${
                  isDark ? 'bg-[#232325] border-[#383838]' : 'bg-[#f8f8f8] border-[#dcdcdc]'
                }`}
              >
                <Search className="w-3 h-3 opacity-70 shrink-0" />
                <input
                  type="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('site.searchPlaceholder')}
                  className="flex-1 bg-transparent text-[11px] outline-none min-w-0"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="opacity-70 hover:opacity-100"
                    title={t('site.clearSearch')}
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
                <div className="relative" ref={searchMenuRef}>
                  <button
                    type="button"
                    onClick={() => setSearchMenuOpen((v) => !v)}
                    title={t('site.searchMode')}
                    className={`p-0.5 border ${
                      isDark
                        ? 'border-[#3f3f3f] hover:bg-[#333333]'
                        : 'border-[#cccccc] hover:bg-[#e5e5e5]'
                    }`}
                  >
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  {searchMenuOpen && (
                    <div
                      className={`absolute right-0 bottom-full mb-1 w-52 border shadow-xl z-50 py-1 text-[11px] ${
                        isDark
                          ? 'bg-[#252526] border-[#454545] text-[#e0e0e0]'
                          : 'bg-white border-[#c0c0c0] text-[#1e1e1e]'
                      }`}
                    >
                      {(
                        [
                          ['prefix', t('site.searchPrefix')],
                          ['substring', t('site.searchSubstring')],
                          ['allFields', t('site.searchAll')],
                        ] as [SiteSearchMode, string][]
                      ).map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => {
                            setSearchMode(mode);
                            setSearchMenuOpen(false);
                          }}
                          className={`w-full px-2.5 py-1 text-left flex items-center justify-between ${
                            searchMode === mode
                              ? 'bg-[#1e4b85] text-white'
                              : isDark
                              ? 'hover:bg-[#333333]'
                              : 'hover:bg-[#e5f1fb]'
                          }`}
                        >
                          <span>{label}</span>
                          {searchMode === mode && <span>✓</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Bottom Left Buttons: Tools ▾ and Manage ▾ */}
            <div className="flex items-center justify-between gap-2 mt-2">
              <div className="relative flex-1" ref={toolsRef}>
                <button
                  type="button"
                  onClick={() => setToolsOpen((v) => !v)}
                  className={`${dialogBtnCls} w-full justify-between`}
                >
                  <span>{t('site.tools')}</span>
                  <ChevronDown className="w-3 h-3 opacity-75" />
                </button>
                {toolsOpen && (
                  <div
                    className={`absolute left-0 bottom-full mb-1 w-60 border shadow-xl z-50 py-1 ${
                      isDark
                        ? 'bg-[#252526] border-[#454545] text-[#e0e0e0]'
                        : 'bg-white border-[#c0c0c0] text-[#1e1e1e]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setToolsOpen(false);
                        fileInputRef.current?.click();
                      }}
                      className={`w-full px-3 py-1.5 text-left flex items-center gap-2 ${
                        isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                      }`}
                    >
                      <Upload className="w-3.5 h-3.5 text-sky-400" />
                      {t('site.importFile')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setToolsOpen(false);
                        setSubPrompt({ kind: 'importYaml', text: '' });
                      }}
                      className={`w-full px-3 py-1.5 text-left flex items-center gap-2 ${
                        isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                      }`}
                    >
                      <Plus className="w-3.5 h-3.5 text-emerald-400" />
                      {t('site.pasteYaml')}
                    </button>
                    <div className={`my-1 border-t ${isDark ? 'border-[#3a3a3a]' : 'border-[#e0e0e0]'}`} />
                    <button
                      type="button"
                      onClick={() => {
                        setToolsOpen(false);
                        void handleOpenExportYaml();
                      }}
                      className={`w-full px-3 py-1.5 text-left flex items-center gap-2 ${
                        isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                      }`}
                    >
                      <Download className="w-3.5 h-3.5 text-sky-400" />
                      {t('site.exportYaml')}
                    </button>
                  </div>
                )}
              </div>

              <div className="relative flex-1" ref={manageRef}>
                <button
                  type="button"
                  onClick={() => setManageOpen((v) => !v)}
                  className={`${dialogBtnCls} w-full justify-between`}
                >
                  <span>{t('site.manage')}</span>
                  <ChevronDown className="w-3 h-3 opacity-75" />
                </button>
                {manageOpen && (
                  <div
                    className={`absolute left-0 bottom-full mb-1 w-56 border shadow-xl z-50 py-1 ${
                      isDark
                        ? 'bg-[#252526] border-[#454545] text-[#e0e0e0]'
                        : 'bg-white border-[#c0c0c0] text-[#1e1e1e]'
                    }`}
                  >
                    <button
                      type="button"
                      disabled={!isSavedSite}
                      onClick={() => {
                        setManageOpen(false);
                        beginEditSelected();
                      }}
                      className={`w-full px-3 py-1 text-left disabled:opacity-40 ${
                        isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                      }`}
                    >
                      {t('site.edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setManageOpen(false);
                        setSubPrompt({
                          kind: 'saveAs',
                          name: draftSite.name || draftSite.hostName || t('site.newSite'),
                          folder: draftSite.folder ?? '',
                        });
                      }}
                      className={`w-full px-3 py-1 text-left ${
                        isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                      }`}
                    >
                      {t('site.saveAs')}
                    </button>
                    <button
                      type="button"
                      disabled={!isSavedSite}
                      onClick={() => {
                        setManageOpen(false);
                        setSubPrompt({ kind: 'rename', name: draftSite.name });
                      }}
                      className={`w-full px-3 py-1 text-left disabled:opacity-40 ${
                        isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                      }`}
                    >
                      {t('site.rename')}
                    </button>
                    <button
                      type="button"
                      disabled={!isSavedSite}
                      onClick={() => {
                        setManageOpen(false);
                        void cloneSelectedSite();
                      }}
                      className={`w-full px-3 py-1 text-left disabled:opacity-40 ${
                        isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                      }`}
                    >
                      {t('site.clone')}
                    </button>
                    <button
                      type="button"
                      disabled={!isSavedSite}
                      onClick={() => {
                        setManageOpen(false);
                        void deleteSelectedSite();
                      }}
                      className={`w-full px-3 py-1 text-left text-red-400 disabled:opacity-40 ${
                        isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                      }`}
                    >
                      {t('site.deleteSite')}
                    </button>
                    <div className={`my-1 border-t ${isDark ? 'border-[#3a3a3a]' : 'border-[#e0e0e0]'}`} />
                    <button
                      type="button"
                      onClick={() => {
                        setManageOpen(false);
                        setSubPrompt({ kind: 'newFolder', name: '' });
                      }}
                      className={`w-full px-3 py-1 text-left ${
                        isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                      }`}
                    >
                      {t('site.newFolder')}
                    </button>
                    {selection.kind === 'folder' && (
                      <button
                        type="button"
                        onClick={() => {
                          setManageOpen(false);
                          void deleteSelectedFolder();
                        }}
                        className={`w-full px-3 py-1 text-left text-red-400 ${
                          isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                        }`}
                      >
                        {t('site.deleteFolder')} "{selection.folder}"
                      </button>
                    )}
                    <div className={`my-1 border-t ${isDark ? 'border-[#3a3a3a]' : 'border-[#e0e0e0]'}`} />
                    <button
                      type="button"
                      onClick={() => {
                        setManageOpen(false);
                        setSubPrompt({ kind: 'pasteUrl', url: '' });
                      }}
                      className={`w-full px-3 py-1 text-left ${
                        isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                      }`}
                    >
                      {t('site.pasteUrl')}
                    </button>
                    <button
                      type="button"
                      disabled={!draftSite.hostName.trim()}
                      onClick={() => {
                        setManageOpen(false);
                        void handleOpenGenerateUrl(false);
                      }}
                      className={`w-full px-3 py-1 text-left disabled:opacity-40 ${
                        isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                      }`}
                    >
                      {t('site.genUrl')}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right pane: MainPanel */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            {selection.kind === 'folder' ? (
              <div
                className={`flex-1 border p-3 flex flex-col min-h-0 ${
                  isDark ? 'border-[#3f3f3f] bg-[#212122]' : 'border-[#c8c8c8] bg-white'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 font-medium">
                    <Folder className="w-4 h-4 text-[#eab308]" />
                    <span>{t('site.folder')}: {selection.folder}</span>
                    <span className="text-[11px] opacity-65">
                      ({folderChildren.length} {t('site.sitesCount')})
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        selectNewSite();
                        updateDraft((s) => ({ ...s, folder: selection.folder }));
                      }}
                      className={dialogBtnCls}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      {t('site.newSiteHere')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteSelectedFolder()}
                      className={`${dialogBtnCls} text-red-400`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      {t('site.removeFolder')}
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto grid grid-cols-2 gap-1.5 content-start">
                  {folderChildren.length === 0 ? (
                    <div className="col-span-2 text-center py-8 opacity-60">
                      {t('site.emptyFolder')}
                    </div>
                  ) : (
                    folderChildren.map((child) => (
                      <button
                        key={child.id}
                        type="button"
                        onClick={() => void selectSite(child.id, false)}
                        onDoubleClick={() =>
                          void selectSite(child.id, false).then(() => loginWithCurrent())
                        }
                        className={`p-2 border text-left flex items-center gap-2 ${
                          isDark
                            ? 'bg-[#2a2a2c] border-[#3f3f3f] hover:border-[#4da3ff]'
                            : 'bg-[#f7f7f7] border-[#d0d0d0] hover:border-[#0078d7]'
                        }`}
                      >
                        <Monitor
                          className="w-4 h-4 shrink-0"
                          style={{ color: child.color ?? '#38bdf8' }}
                        />
                        <div className="min-w-0">
                          <div className="font-medium truncate">{child.name}</div>
                          <div className="text-[10px] opacity-70 truncate">
                            {child.protocol.toUpperCase()} · {child.userName}@{child.hostName}:
                            {child.portNumber}
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <>
                {/* Session GroupBox */}
                <fieldset
                  className={`border px-3 pb-3 pt-1.5 space-y-2.5 ${
                    isDark ? 'border-[#3f3f3f]' : 'border-[#c8c8c8]'
                  }`}
                >
                  <legend className="px-1 text-[11px] opacity-90">{t('site.session')}</legend>

                  {/* Row 1: File protocol + Encryption */}
                  <div className="grid grid-cols-[1fr_180px] gap-2.5">
                    <div>
                      <label className="block mb-1 opacity-90">{t('site.protocol')}</label>
                      <select
                        aria-label="File protocol"
                        disabled={!editable}
                        value={draftSite.protocol}
                        onChange={(e) => setProtocol(e.target.value as SiteProtocol)}
                        className={inputCls}
                      >
                        <option value="sftp">SFTP</option>
                        <option value="scp">SCP</option>
                        <option value="ftp">FTP</option>
                        <option value="webdav">WebDAV</option>
                        <option value="s3">Amazon S3</option>
                      </select>
                    </div>
                    <div>
                      <label className="block mb-1 opacity-90">{t('site.encryption')}</label>
                      <select
                        aria-label="Encryption"
                        disabled={!editable || !encryptionEnabled}
                        value={draftSite.ftpsMode}
                        onChange={(e) => setFtpsMode(e.target.value as FtpsMode)}
                        className={inputCls}
                      >
                        <option value="none">{t('site.encNone')}</option>
                        <option value="implicit">{t('site.encImplicit')}</option>
                        <option value="explicit">{t('site.encExplicit')}</option>
                      </select>
                    </div>
                  </div>

                  {/* Row 2: Hostname + Port number */}
                  <div className="grid grid-cols-[1fr_92px] gap-2.5">
                    <div>
                      <label className="block mb-1 opacity-90">
                        {draftSite.protocol === 's3' ? t('site.endpointHost') : t('site.hostName')}
                      </label>
                      <input
                        type="text"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        disabled={!editable}
                        value={draftSite.hostName}
                        onChange={(e) =>
                          updateDraft((s) => ({ ...s, hostName: e.target.value }))
                        }
                        placeholder={
                          draftSite.protocol === 's3' ? 's3.amazonaws.com' : 'example.com'
                        }
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="block mb-1 opacity-90">{t('site.portNumber')}</label>
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        disabled={!editable}
                        value={draftSite.portNumber}
                        onChange={(e) =>
                          updateDraft((s) => ({
                            ...s,
                            portNumber: Math.max(1, Math.min(65535, Number(e.target.value) || 22)),
                          }))
                        }
                        className={`${inputCls} text-right`}
                      />
                    </div>
                  </div>

                  {/* Row 3: Username + Password */}
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block mb-1 opacity-90">
                        {draftSite.protocol === 's3' ? t('site.accessKeyId') : t('site.userName')}
                      </label>
                      <input
                        type="text"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        disabled={
                          !editable ||
                          (draftSite.protocol === 'ftp' && draftSite.anonymousLogin) ||
                          (draftSite.protocol === 's3' && draftSite.s3EnvCredentials)
                        }
                        value={draftSite.userName}
                        onChange={(e) =>
                          updateDraft((s) => ({ ...s, userName: e.target.value }))
                        }
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="flex items-center justify-between mb-1 opacity-90">
                        <span>
                          {draftSite.protocol === 's3' ? t('site.secretAccessKey') : t('site.password')}
                        </span>
                        {draftSite.hasPassword && (
                          <span
                            className="inline-flex items-center gap-0.5 text-[10px] text-emerald-400"
                            title={t('site.keyringTip')}
                          >
                            <KeyRound className="w-2.5 h-2.5" />
                            {t('site.keyring')}
                          </span>
                        )}
                      </label>
                      <div className="relative">
                        <input
                          type={showPasswordText ? 'text' : 'password'}
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          disabled={
                            !editable ||
                            (draftSite.protocol === 'ftp' && draftSite.anonymousLogin) ||
                            (draftSite.protocol === 's3' && draftSite.s3EnvCredentials)
                          }
                          value={draftPassword}
                          onChange={(e) => setDraftPassword(e.target.value)}
                          placeholder={draftSite.hasPassword ? '••••••••' : ''}
                          className={`${inputCls} pr-7`}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPasswordText((v) => !v)}
                          className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-60 hover:opacity-100"
                          title={showPasswordText ? t('site.hidePassword') : t('site.showPassword')}
                        >
                          {showPasswordText ? (
                            <EyeOff className="w-3 h-3" />
                          ) : (
                            <Eye className="w-3 h-3" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Protocol-specific quick checkboxes matching TLoginDialog */}
                  {draftSite.protocol === 'ftp' && (
                    <label className="inline-flex items-center gap-1.5 text-[11px] cursor-pointer">
                      <input
                        type="checkbox"
                        disabled={!editable}
                        checked={draftSite.anonymousLogin}
                        onChange={(e) =>
                          updateDraft((s) => ({
                            ...s,
                            anonymousLogin: e.target.checked,
                            userName: e.target.checked ? 'anonymous' : s.userName,
                          }))
                        }
                      />
                      <span>{t('site.anonymousLogin')}</span>
                    </label>
                  )}
                  {draftSite.protocol === 's3' && (
                    <label className="inline-flex items-center gap-1.5 text-[11px] cursor-pointer">
                      <input
                        type="checkbox"
                        disabled={!editable}
                        checked={draftSite.s3EnvCredentials}
                        onChange={(e) =>
                          updateDraft((s) => ({
                            ...s,
                            s3EnvCredentials: e.target.checked,
                          }))
                        }
                      />
                      <span>{t('site.s3EnvCreds')}</span>
                    </label>
                  )}

                  {/* Folder / Group selector */}
                  <div>
                    <label className="block mb-1 opacity-90">{t('site.folderSelect')}</label>
                    <div className="flex items-center gap-1.5">
                      <select
                        aria-label={t('site.folderSelect')}
                        disabled={!editable}
                        value={draftSite.folder ?? ''}
                        onChange={(e) =>
                          updateDraft((s) => ({
                            ...s,
                            folder: e.target.value || null,
                          }))
                        }
                        className={inputCls}
                      >
                        <option value="">{t('site.noFolder')}</option>
                        {folders.map((f) => (
                          <option key={f} value={f}>
                            {f}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={!editable}
                        onClick={() =>
                          setSubPrompt({ kind: 'newFolder', name: '', assignToDraft: true })
                        }
                        title={t('site.createFolderTip')}
                        className={`${dialogBtnCls} px-2 shrink-0`}
                      >
                        <FolderPlus className="w-3.5 h-3.5 text-[#eab308]" />
                      </button>
                    </div>
                  </div>

                  {/* Row 4: Action buttons (Edit vs Save/Cancel + Advanced...) */}
                  <div className="flex items-center justify-between pt-1">
                    <div className="flex items-center gap-1.5">
                      {!editable ? (
                        <button
                          type="button"
                          onClick={beginEditSelected}
                          className={`${dialogBtnCls} w-[108px]`}
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          {t('site.edit')}
                        </button>
                      ) : (
                        <>
                          {isSavedSite ? (
                            <>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void saveDraft()}
                                className={`${dialogBtnCls} ${isMac ? 'min-w-[84px]' : 'w-[84px]'} font-medium`}
                              >
                                {t('site.save')}
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  setSubPrompt({
                                    kind: 'saveAs',
                                    name: draftSite.name || draftSite.hostName || t('site.newSite'),
                                    folder: draftSite.folder ?? '',
                                  })
                                }
                                className={`${dialogBtnCls} ${isMac ? 'min-w-[96px]' : 'min-w-[80px]'}`}
                              >
                                {t('site.saveAs')}
                              </button>
                              <button
                                type="button"
                                onClick={() => void cancelEditSelected()}
                                className={`${dialogBtnCls} ${isMac ? 'min-w-[80px]' : 'w-[70px]'}`}
                              >
                                {t('site.cancel')}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                setSubPrompt({
                                  kind: 'saveAs',
                                  name: draftSite.name || draftSite.hostName || t('site.newSite'),
                                  folder: draftSite.folder ?? '',
                                })
                              }
                              className={`${dialogBtnCls} ${isMac ? 'min-w-[108px]' : 'w-[108px]'} font-medium`}
                            >
                              {t('site.save')}
                            </button>
                          )}
                        </>
                      )}
                    </div>

                    <button
                      type="button"
                      disabled={!editable}
                      onClick={openAdvancedDialog}
                      className={`${dialogBtnCls} ${isMac ? 'min-w-[112px]' : 'w-[108px]'}`}
                    >
                      {t('site.advanced')}
                    </button>
                  </div>
                </fieldset>

                {/* Note GroupBox below Session */}
                <fieldset
                  className={`flex-1 border px-3 pb-2 pt-1 mt-2 flex flex-col min-h-0 ${
                    isDark ? 'border-[#3f3f3f]' : 'border-[#c8c8c8]'
                  }`}
                >
                  <legend className="px-1 text-[11px] opacity-90">{t('site.note')}</legend>
                  <textarea
                    disabled={!editable}
                    value={draftSite.note}
                    onChange={(e) => updateDraft((s) => ({ ...s, note: e.target.value }))}
                    placeholder={t('site.notePlaceholder')}
                    className={`flex-1 w-full resize-none bg-transparent text-[11px] outline-none ${
                      !editable ? 'opacity-75' : ''
                    }`}
                  />
                </fieldset>
              </>
            )}

            {(error || notice) && (
              <div
                className={`mt-2 px-2.5 py-1 text-[11px] border flex items-center justify-between gap-2 ${
                  error
                    ? 'bg-red-500/15 border-red-500/40 text-red-300'
                    : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                }`}
              >
                <span className="truncate">{error ?? notice}</span>
                <button type="button" onClick={clearNotice} className="opacity-75 hover:opacity-100">
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Bottom Dialog Bar */}
        <div
          className={`flex items-center justify-between px-3 py-2 border-t ${
            isDark ? 'bg-[#1f1f1f] border-[#383838]' : 'bg-[#e8e8e8] border-[#cccccc]'
          }`}
        >
          <label className="flex items-center gap-2 text-[11px] cursor-pointer">
            <input
              type="checkbox"
              checked={showLoginOnStartup}
              onChange={(e) => void setShowLoginOnStartup(e.target.checked)}
            />
            <span>{t('site.showOnStartup')}</span>
          </label>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={selection.kind === 'folder'}
              onClick={() => void loginWithCurrent()}
              className={`${
                isMac ? 'h-[30px] px-4 rounded-md' : 'h-[25px] w-[108px] px-3'
              } bg-[#1e4b85] hover:bg-[#255da3] disabled:opacity-45 text-white font-medium whitespace-nowrap inline-flex items-center justify-center gap-1.5 border border-[#2b6cb0]`}
            >
              <LogIn className="w-3.5 h-3.5 text-emerald-300" />
              {t('site.login')}
            </button>
            <button
              type="button"
              onClick={closeLoginDialog}
              className={`${dialogBtnCls} ${isMac ? 'min-w-[84px]' : 'w-[80px]'}`}
            >
              {t('site.close')}
            </button>
            <button
              type="button"
              onClick={() => setSubPrompt({ kind: 'help' })}
              className={`${dialogBtnCls} ${isMac ? 'min-w-[84px]' : 'w-[80px]'}`}
            >
              <HelpCircle className="w-3.5 h-3.5" />
              {t('site.help')}
            </button>
          </div>
        </div>

        {/* Inline Sub-Modals (WebView2-safe replacement for native prompts) */}
        {subPrompt && (
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setSubPrompt(null);
            }}
          >
            <div
              className={`w-[440px] max-w-full border shadow-2xl p-4 space-y-3 text-xs ${
                isDark
                  ? 'bg-[#252526] border-[#454545] text-[#e0e0e0]'
                  : 'bg-white border-[#a0a0a0] text-[#1e1e1e]'
              }`}
            >
              {subPrompt.kind === 'saveAs' && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveDraft({
                      nameOverride: subPrompt.name,
                      folderOverride: subPrompt.folder.trim() || null,
                      saveAsNew: selection.kind === 'newSite' || subPrompt.name !== draftSite.name,
                    }).then(() => setSubPrompt(null));
                  }}
                  className="space-y-3"
                >
                  <div className="font-semibold flex items-center gap-2">
                    <FolderPlus className="w-4 h-4 text-[#4da3ff]" />
                    {t('site.saveSessionAs')}
                  </div>
                  <div>
                    <label className="block mb-1">{t('site.siteNameLabel')}</label>
                    <input
                      autoFocus
                      type="text"
                      value={subPrompt.name}
                      onChange={(e) => setSubPrompt({ ...subPrompt, name: e.target.value })}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="block mb-1">{t('site.folderLabel')}</label>
                    <input
                      type="text"
                      list="scpcraft-folder-options"
                      value={subPrompt.folder}
                      onChange={(e) => setSubPrompt({ ...subPrompt, folder: e.target.value })}
                      placeholder={t('site.rootFolderPlaceholder')}
                      className={inputCls}
                    />
                    <datalist id="scpcraft-folder-options">
                      {folders.map((f) => (
                        <option key={f} value={f} />
                      ))}
                    </datalist>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setSubPrompt(null)} className={dialogBtnCls}>
                      {t('site.cancel')}
                    </button>
                    <button
                      type="submit"
                      className="h-[25px] px-4 bg-[#1e4b85] hover:bg-[#255da3] text-white"
                    >
                      {t('site.ok')}
                    </button>
                  </div>
                </form>
              )}

              {subPrompt.kind === 'rename' && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void renameSelectedSite(subPrompt.name).then(() => setSubPrompt(null));
                  }}
                  className="space-y-3"
                >
                  <div className="font-semibold">{t('site.renameSiteTitle')}</div>
                  <input
                    autoFocus
                    type="text"
                    value={subPrompt.name}
                    onChange={(e) => setSubPrompt({ ...subPrompt, name: e.target.value })}
                    className={inputCls}
                  />
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setSubPrompt(null)} className={dialogBtnCls}>
                      {t('site.cancel')}
                    </button>
                    <button
                      type="submit"
                      className="h-[25px] px-4 bg-[#1e4b85] hover:bg-[#255da3] text-white"
                    >
                      {t('site.renameBtn')}
                    </button>
                  </div>
                </form>
              )}

              {subPrompt.kind === 'newFolder' && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const trimmed = subPrompt.name.trim().replace(/^\/+|\/+$/g, '');
                    const assignToDraft = Boolean(subPrompt.assignToDraft);
                    void createFolder(subPrompt.name, {
                      selectFolder: !assignToDraft,
                    }).then(() => {
                      if (assignToDraft && trimmed) {
                        updateDraft((s) => ({ ...s, folder: trimmed }));
                      }
                      setSubPrompt(null);
                    });
                  }}
                  className="space-y-3"
                >
                  <div className="font-semibold">{t('site.newFolderTitle')}</div>
                  <input
                    autoFocus
                    type="text"
                    placeholder={t('site.newFolderPlaceholder')}
                    value={subPrompt.name}
                    onChange={(e) => setSubPrompt({ ...subPrompt, name: e.target.value })}
                    className={inputCls}
                  />
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setSubPrompt(null)} className={dialogBtnCls}>
                      {t('site.cancel')}
                    </button>
                    <button
                      type="submit"
                      className="h-[25px] px-4 bg-[#1e4b85] hover:bg-[#255da3] text-white"
                    >
                      {t('site.createBtn')}
                    </button>
                  </div>
                </form>
              )}

              {subPrompt.kind === 'pasteUrl' && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void pasteSessionUrl(subPrompt.url).then(() => setSubPrompt(null));
                  }}
                  className="space-y-3"
                >
                  <div className="font-semibold">{t('site.pasteUrlTitle')}</div>
                  <input
                    autoFocus
                    type="text"
                    placeholder="sftp://user:pass@host:22/path"
                    value={subPrompt.url}
                    onChange={(e) => setSubPrompt({ ...subPrompt, url: e.target.value })}
                    className={`${inputCls} font-mono`}
                  />
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setSubPrompt(null)} className={dialogBtnCls}>
                      {t('site.cancel')}
                    </button>
                    <button
                      type="submit"
                      className="h-[25px] px-4 bg-[#1e4b85] hover:bg-[#255da3] text-white"
                    >
                      {t('site.loadUrlBtn')}
                    </button>
                  </div>
                </form>
              )}

              {subPrompt.kind === 'generateUrl' && (
                <div className="space-y-3">
                  <div className="font-semibold">{t('site.genUrlTitle')}</div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={subPrompt.includePwd}
                      onChange={(e) => void handleOpenGenerateUrl(e.target.checked)}
                    />
                    <span>{t('site.includePwdInUrl')}</span>
                  </label>
                  <div>
                    <div className="text-[11px] opacity-75 mb-1">{t('site.sessionUrlLabel')}</div>
                    <div className="flex gap-1.5">
                      <input readOnly value={subPrompt.url} className={`${inputCls} font-mono`} />
                      <button
                        type="button"
                        onClick={() => void navigator.clipboard.writeText(subPrompt.url)}
                        className={dialogBtnCls}
                        title={t('site.copyUrl')}
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] opacity-75 mb-1">{t('site.cliCommandLabel')}</div>
                    <div className="flex gap-1.5">
                      <input readOnly value={subPrompt.cli} className={`${inputCls} font-mono`} />
                      <button
                        type="button"
                        onClick={() => void navigator.clipboard.writeText(subPrompt.cli)}
                        className={dialogBtnCls}
                        title={t('site.copyCli')}
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button type="button" onClick={() => setSubPrompt(null)} className={dialogBtnCls}>
                      {t('site.close')}
                    </button>
                  </div>
                </div>
              )}

              {subPrompt.kind === 'importYaml' && (
                <div className="space-y-3">
                  <div className="font-semibold">{t('site.importYamlTitle')}</div>
                  <textarea
                    rows={9}
                    value={subPrompt.text}
                    onChange={(e) => setSubPrompt({ ...subPrompt, text: e.target.value })}
                    placeholder={"version: 1\nsites:\n  - name: My Server\n    protocol: sftp\n    hostName: example.com\n    portNumber: 22\n    userName: root"}
                    className={`w-full p-2 border text-xs font-mono outline-none ${
                      isDark ? 'bg-[#1e1e1e] border-[#3f3f3f]' : 'bg-white border-[#c0c0c0]'
                    }`}
                  />
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setSubPrompt(null)} className={dialogBtnCls}>
                      {t('site.cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void importFromYamlText(subPrompt.text).then(() => setSubPrompt(null))
                      }
                      className="h-[25px] px-4 bg-[#1e4b85] hover:bg-[#255da3] text-white"
                    >
                      {t('site.importBtn')}
                    </button>
                  </div>
                </div>
              )}

              {subPrompt.kind === 'exportYaml' && (
                <div className="space-y-3">
                  <div className="font-semibold">{t('site.exportYamlTitle')}</div>
                  <p className="text-[11px] opacity-80">
                    {t('site.exportYamlNote')}
                  </p>
                  <textarea
                    readOnly
                    rows={10}
                    value={subPrompt.text}
                    className={`w-full p-2 border text-[11px] font-mono outline-none ${
                      isDark ? 'bg-[#1e1e1e] border-[#3f3f3f]' : 'bg-slate-50 border-[#c0c0c0]'
                    }`}
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const blob = new Blob([subPrompt.text], { type: 'text/yaml;charset=utf-8' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = 'scpcraft-sites.yml';
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                      className={dialogBtnCls}
                    >
                      <Download className="w-3.5 h-3.5" />
                      {t('site.downloadYaml')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(subPrompt.text)}
                      className={dialogBtnCls}
                    >
                      <Copy className="w-3.5 h-3.5" />
                      {t('site.copyAll')}
                    </button>
                    <button type="button" onClick={() => setSubPrompt(null)} className={dialogBtnCls}>
                      {t('site.close')}
                    </button>
                  </div>
                </div>
              )}

              {subPrompt.kind === 'help' && (
                <div className="space-y-2.5">
                  <div className="font-semibold">{t('site.helpTitle')}</div>
                  <ul className="list-disc pl-4 space-y-1 opacity-85 leading-relaxed">
                    <li>{t('site.helpYaml')}</li>
                    <li>{t('site.helpSecurity')}</li>
                    <li>{t('site.helpShortcuts')}</li>
                  </ul>
                  <div className="flex justify-end">
                    <button type="button" onClick={() => setSubPrompt(null)} className={dialogBtnCls}>
                      {t('site.ok')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {treeContextMenu && (
          <div
            ref={contextMenuRef}
            style={{ left: treeContextMenu.x, top: treeContextMenu.y }}
            className={`fixed z-[60] min-w-[180px] border shadow-2xl py-1 text-xs ${
              isDark
                ? 'bg-[#252526] border-[#454545] text-[#e0e0e0]'
                : 'bg-white border-[#c0c0c0] text-[#1e1e1e]'
            }`}
          >
            {treeContextMenu.target.kind === 'site' && (() => {
              const targetSite = treeContextMenu.target.site;
              return (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setTreeContextMenu(null);
                      void selectSite(targetSite.id, false).then(() => loginWithCurrent());
                    }}
                    className={`w-full px-3 py-1.5 text-left flex items-center gap-2 font-medium ${
                      isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                    }`}
                  >
                    <LogIn className="w-3.5 h-3.5 text-sky-400" />
                    {t('site.login')}
                  </button>
                  <div className={`my-1 border-t ${isDark ? 'border-[#3a3a3a]' : 'border-[#e0e0e0]'}`} />
                  <button
                    type="button"
                    onClick={() => {
                      setTreeContextMenu(null);
                      void selectSite(targetSite.id, true);
                    }}
                    className={`w-full px-3 py-1.5 text-left flex items-center gap-2 ${
                      isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                    }`}
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    {t('site.edit')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTreeContextMenu(null);
                      setSubPrompt({
                        kind: 'saveAs',
                        name: targetSite.name,
                        folder: targetSite.folder ?? '',
                      });
                    }}
                    className={`w-full px-3 py-1.5 text-left flex items-center gap-2 ${
                      isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                    }`}
                  >
                    <span className="w-3.5" />
                    {t('site.saveAs')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTreeContextMenu(null);
                      setSubPrompt({ kind: 'rename', name: targetSite.name });
                    }}
                    className={`w-full px-3 py-1.5 text-left flex items-center gap-2 ${
                      isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                    }`}
                  >
                    <span className="w-3.5" />
                    {t('site.rename')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTreeContextMenu(null);
                      void cloneSelectedSite();
                    }}
                    className={`w-full px-3 py-1.5 text-left flex items-center gap-2 ${
                      isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                    }`}
                  >
                    <Copy className="w-3.5 h-3.5" />
                    {t('site.clone')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTreeContextMenu(null);
                      void selectSite(targetSite.id, false).then(() => handleOpenGenerateUrl(false));
                    }}
                    className={`w-full px-3 py-1.5 text-left flex items-center gap-2 ${
                      isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                    }`}
                  >
                    <span className="w-3.5" />
                    {t('site.genUrl')}
                  </button>
                  <div className={`my-1 border-t ${isDark ? 'border-[#3a3a3a]' : 'border-[#e0e0e0]'}`} />
                  <div className="px-3 py-1 text-[10px] opacity-60 uppercase tracking-wider">
                    {t('site.moveToFolder')}
                  </div>
                  {targetSite.folder && (
                    <button
                      type="button"
                      onClick={() => {
                        setTreeContextMenu(null);
                        void moveSiteToFolder(targetSite.id, null);
                      }}
                      className={`w-full px-3 py-1.5 text-left flex items-center gap-2 ${
                        isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                      }`}
                    >
                      <Monitor className="w-3.5 h-3.5 opacity-75" />
                      {t('site.moveToRoot')}
                    </button>
                  )}
                  {folders
                    .filter((f) => f !== targetSite.folder)
                    .map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => {
                          setTreeContextMenu(null);
                          void moveSiteToFolder(targetSite.id, f);
                        }}
                        className={`w-full px-3 py-1.5 text-left flex items-center gap-2 ${
                          isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                        }`}
                      >
                        <Folder className="w-3.5 h-3.5 text-[#eab308]" />
                        <span className="truncate">{f}</span>
                      </button>
                    ))}
                  <div className={`my-1 border-t ${isDark ? 'border-[#3a3a3a]' : 'border-[#e0e0e0]'}`} />
                  <button
                    type="button"
                    onClick={() => {
                      setTreeContextMenu(null);
                      void deleteSelectedSite();
                    }}
                    className={`w-full px-3 py-1.5 text-left flex items-center gap-2 text-red-400 ${
                      isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                    }`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {t('site.deleteSite')}
                  </button>
                </>
              );
            })()}

            {treeContextMenu.target.kind === 'folder' && (() => {
              const targetFolder = treeContextMenu.target.folder;
              return (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setTreeContextMenu(null);
                      selectNewSite();
                      updateDraft((s) => ({ ...s, folder: targetFolder }));
                    }}
                    className={`w-full px-3 py-1.5 text-left flex items-center gap-2 ${
                      isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                    }`}
                  >
                    <Plus className="w-3.5 h-3.5 text-sky-400" />
                    {t('site.newSiteHere')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTreeContextMenu(null);
                      void deleteSelectedFolder();
                    }}
                    className={`w-full px-3 py-1.5 text-left flex items-center gap-2 text-red-400 ${
                      isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                    }`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {t('site.removeFolder')}
                  </button>
                </>
              );
            })()}

            {treeContextMenu.target.kind === 'empty' && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setTreeContextMenu(null);
                    selectNewSite();
                  }}
                  className={`w-full px-3 py-1.5 text-left flex items-center gap-2 ${
                    isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                  }`}
                >
                  <Plus className="w-3.5 h-3.5 text-sky-400" />
                  {t('site.newSite')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTreeContextMenu(null);
                    setSubPrompt({ kind: 'newFolder', name: '' });
                  }}
                  className={`w-full px-3 py-1.5 text-left flex items-center gap-2 ${
                    isDark ? 'hover:bg-[#1e4b85]' : 'hover:bg-[#0078d7] hover:text-white'
                  }`}
                >
                  <FolderPlus className="w-3.5 h-3.5 text-[#eab308]" />
                  {t('site.newFolder')}
                </button>
              </>
            )}
          </div>
        )}

        {dragState && (
          <div
            style={{ left: dragState.x + 12, top: dragState.y + 12 }}
            className={`fixed z-[70] pointer-events-none px-2 py-1 border shadow-lg text-xs flex items-center gap-1.5 ${
              isDark
                ? 'bg-[#1e4b85] border-[#4da3ff] text-white'
                : 'bg-[#0078d7] border-[#005a9e] text-white'
            }`}
          >
            <Monitor className="w-3.5 h-3.5 shrink-0" />
            <span className="font-medium">{dragState.siteName}</span>
            {dragOverTarget && (
              <span className="opacity-85 text-[11px]">
                → {dragOverTarget === '__root__' ? t('site.moveToRoot') : dragOverTarget}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
