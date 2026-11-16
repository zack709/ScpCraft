import { useEffect, useRef, useState } from 'react';
import { Columns2, Globe, LayoutPanelLeft, Moon, Plus, Server, Sun, X } from 'lucide-react';
import { translate } from '../../i18n';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useSiteStore } from '../../stores/useSiteStore';
import { findDifferentEntryPaths, formatDirTabName } from '../../utils/formatters';
import { isMacOS } from '../../utils/platform';

interface MenuEntry {
  label: string;
  shortcut?: string;
  action: () => void;
  divider?: boolean;
}

/** Shared helper so both MenuBar ("Commands -> Compare Directories") and Toolbar run identical pane comparison. */
export function runCompareDirectories(): void {
  const state = useWorkspaceStore.getState();
  const { leftDiffPaths, rightDiffPaths } = findDifferentEntryPaths(
    state.leftPane.entries,
    state.rightPane.entries
  );

  useWorkspaceStore.setState((s) => ({
    leftPane: {
      ...s.leftPane,
      selectedPaths: leftDiffPaths,
      focusedPath: leftDiffPaths[0] ?? s.leftPane.focusedPath,
    },
    rightPane: {
      ...s.rightPane,
      selectedPaths: rightDiffPaths,
      focusedPath: rightDiffPaths[0] ?? s.rightPane.focusedPath,
    },
  }));

  state.addQueueLog({
    operation: 'copy',
    source: state.leftPane.currentPath || 'Left',
    target: state.rightPane.currentPath || 'Right',
    status: 'done',
    detail: `Compared directories: ${leftDiffPaths.length} diff(s) left, ${rightDiffPaths.length} diff(s) right`,
  });
}

export function MainMenuBar() {
  const {
    theme,
    toggleTheme,
    locale,
    toggleLocale,
    interfaceMode,
    setInterfaceMode,
    activePane,
    rightPaneMode,
    setRightPaneMode,
    activeTabId,
    tabs,
    addTab,
    closeTab,
    disconnectActiveSession,
    openModal,
    refreshPane,
    toggleShowHidden,
    toggleTreeSidebar,
    selectAll,
    clearSelection,
    invertSelection,
    toggleQueueDock,
    toggleFunctionKeyBar,
    toggleCommandLineBar,
    toggleTerminalDrawer,
    setSplitRatio,
    swapPanes,
    goHome,
    goRoot,
    goUp,
  } = useWorkspaceStore();

  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    window.addEventListener('mousedown', handleOutside);
    return () => window.removeEventListener('mousedown', handleOutside);
  }, []);

  const isDark = theme === 'dark';
  const isMac = isMacOS();
  const t = (k: Parameters<typeof translate>[1]) => translate(locale, k);

  const makePaneMenu = (pane: 'left' | 'right'): MenuEntry[] => [
    { label: t('item.openDir'), shortcut: 'Ctrl+O', action: () => openModal('opendir', pane) },
    { label: t('item.parentDir'), shortcut: 'Backspace', action: () => void goUp(pane) },
    { label: t('item.rootDir'), action: () => void goRoot(pane) },
    { label: t('item.homeDir'), action: () => void goHome(pane) },
    { label: t('item.refresh'), shortcut: 'Ctrl+R', action: () => void refreshPane(pane), divider: true },
    { label: t('item.filterFiles'), shortcut: 'Ctrl+F', action: () => openModal('filter', pane) },
    { label: t('item.toggleHidden'), shortcut: 'Ctrl+Alt+H', action: () => void toggleShowHidden(pane) },
    { label: t('item.toggleTree'), action: () => toggleTreeSidebar(pane) },
  ];

  const menuList: { id: string; label: string; items: MenuEntry[] }[] = [
    { id: 'Left', label: t('menu.Left'), items: makePaneMenu('left') },
    {
      id: 'Mark',
      label: t('menu.Mark'),
      items: [
        { label: t('item.selectByMask'), shortcut: 'Ctrl+F', action: () => openModal('filter', activePane) },
        { label: t('item.selectAll'), shortcut: 'Ctrl+A', action: () => selectAll(activePane) },
        { label: t('item.unselectAll'), action: () => clearSelection(activePane) },
        { label: t('item.invertSelection'), action: () => invertSelection(activePane) },
      ],
    },
    {
      id: 'Files',
      label: t('menu.Files'),
      items: [
        { label: t('item.copy'), shortcut: 'F5', action: () => openModal('copy', activePane) },
        { label: t('item.move'), shortcut: 'F6', action: () => openModal('move', activePane) },
        { label: t('item.rename'), shortcut: 'F2', action: () => openModal('rename', activePane), divider: true },
        { label: t('item.mkdir'), shortcut: 'F7', action: () => openModal('mkdir', activePane) },
        { label: t('item.newfile'), shortcut: 'Shift+F4', action: () => openModal('newfile', activePane) },
        { label: t('item.symlink'), action: () => openModal('symlink', 'right') },
        { label: t('item.delete'), shortcut: 'F8', action: () => openModal('delete', activePane), divider: true },
        { label: t('item.properties'), shortcut: 'F9', action: () => openModal('properties', activePane) },
      ],
    },
    {
      id: 'Commands',
      label: t('menu.Commands'),
      items: [
        { label: t('item.bookmarks'), shortcut: 'Ctrl+B', action: () => openModal('bookmarks', activePane), divider: true },
        { label: t('item.compareDirs'), action: runCompareDirectories },
        { label: t('item.synchronize'), shortcut: 'Ctrl+S', action: () => openModal('synchronize', activePane) },
        { label: t('item.keepUpToDate'), action: () => openModal('keep_up_to_date', activePane) },
        { label: t('item.findFiles'), shortcut: 'Alt+F7', action: () => openModal('find_files', activePane), divider: true },
        { label: t('item.openTerminal'), shortcut: 'Ctrl+T', action: () => toggleTerminalDrawer() },
        { label: t('item.customCommands'), action: () => openModal('custom_commands', activePane), divider: true },
        { label: t('item.copyTarget'), shortcut: 'F5', action: () => openModal('copy', activePane), divider: true },
        { label: t('item.swapPanels'), shortcut: 'Ctrl+U', action: () => swapPanes() },
        { label: t('item.equalizePanels'), action: () => setSplitRatio(0.5) },
      ],
    },
    {
      id: 'Tabs',
      label: t('menu.Tabs'),
      items: [
        { label: t('item.newSession'), shortcut: 'Ctrl+N', action: () => useSiteStore.getState().openLoginDialog() },
        { label: t('item.newTab'), action: () => addTab() },
        { label: t('item.generateUrl'), shortcut: 'Ctrl+Shift+U', action: () => openModal('generate_url', activePane), divider: true },
        ...(rightPaneMode === 'remote_sftp'
          ? [
              {
                label: t('item.disconnect'),
                action: () => void disconnectActiveSession(),
              },
            ]
          : []),
        {
          label: t('item.closeTab'),
          action: () => {
            if (tabs.length > 1) closeTab(activeTabId);
          },
          divider: true,
        },
        {
          label: rightPaneMode === 'local_secondary' ? t('item.switchRightToRemote') : t('item.switchRightToLocal'),
          action: () => {
            if (rightPaneMode === 'local_secondary') {
              const curTab = tabs.find((x) => x.id === activeTabId);
              setRightPaneMode(
                curTab?.site && curTab.connected ? 'remote_sftp' : 'remote_placeholder'
              );
            } else {
              setRightPaneMode('local_secondary');
            }
          },
        },
      ],
    },
    {
      id: 'Options',
      label: t('menu.Options'),
      items: [
        { label: t('mode.commander'), action: () => setInterfaceMode('commander') },
        { label: t('mode.explorer'), action: () => setInterfaceMode('explorer'), divider: true },
        { label: t('item.toggleQueue'), action: () => toggleQueueDock() },
        { label: t('item.toggleFKeys'), action: () => toggleFunctionKeyBar() },
        { label: t('item.toggleCmdBar'), action: () => toggleCommandLineBar(), divider: true },
        { label: t('item.preferences'), shortcut: 'Ctrl+,', action: () => openModal('preferences', activePane) },
        { label: t('item.cleanup'), action: () => openModal('cleanup', activePane), divider: true },
        { label: t('item.switchLang'), action: () => toggleLocale() },
        { label: isDark ? t('theme.toLight') : t('theme.toDark'), action: () => toggleTheme() },
      ],
    },
    { id: 'Right', label: t('menu.Right'), items: makePaneMenu('right') },
    {
      id: 'Help',
      label: t('menu.Help'),
      items: [{ label: t('item.about'), action: () => setShowAbout(true) }],
    },
  ];

  if (isMac) {
    return (
      <div
        data-tauri-drag-region
        className={`shrink-0 flex items-center justify-between pl-[78px] pr-3 h-[38px] border-b select-none ${
          isDark
            ? 'bg-[#242426] border-white/10 text-[#f5f5f7]'
            : 'bg-[#ececed] border-black/10 text-[#1d1d1f]'
        }`}
      >
        <div data-tauri-drag-region className="flex items-center gap-2">
          <span className="font-semibold tracking-tight text-sm text-[#0a84ff] flex items-center gap-1.5 pointer-events-none">
            <Server className="w-4 h-4" />
            ScpCraft
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div
            className={`flex items-center p-0.5 rounded-lg text-[11px] ${
              isDark ? 'bg-white/10' : 'bg-black/8'
            }`}
          >
            <button
              type="button"
              onClick={() => setInterfaceMode('commander')}
              title="Commander (Dual Pane)"
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-all ${
                interfaceMode === 'commander'
                  ? isDark
                    ? 'bg-[#0a84ff] text-white shadow-sm font-medium'
                    : 'bg-white text-[#1d1d1f] shadow-sm font-medium'
                  : isDark
                  ? 'text-[#a1a1a6] hover:text-white'
                  : 'text-[#6e6e73] hover:text-[#1d1d1f]'
              }`}
            >
              <Columns2 className="w-3.5 h-3.5" />
              {t('mode.commander')}
            </button>
            <button
              type="button"
              onClick={() => setInterfaceMode('explorer')}
              title={t('mode.explorer')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-all ${
                interfaceMode === 'explorer'
                  ? isDark
                    ? 'bg-[#0a84ff] text-white shadow-sm font-medium'
                    : 'bg-white text-[#1d1d1f] shadow-sm font-medium'
                  : isDark
                  ? 'text-[#a1a1a6] hover:text-white'
                  : 'text-[#6e6e73] hover:text-[#1d1d1f]'
              }`}
            >
              <LayoutPanelLeft className="w-3.5 h-3.5" />
              {t('mode.explorer')}
            </button>
          </div>

          <button
            type="button"
            onClick={toggleLocale}
            title={t('lang.toggle')}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium inline-flex items-center gap-1.5 transition-colors ${
              isDark
                ? 'bg-white/10 hover:bg-white/15 text-[#64d2ff]'
                : 'bg-black/6 hover:bg-black/10 text-[#0066cc]'
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            {t('lang.badge')}
          </button>

          <button
            type="button"
            onClick={toggleTheme}
            title={isDark ? t('theme.toLight') : t('theme.toDark')}
            className={`p-1.5 rounded-md transition-colors ${
              isDark
                ? 'bg-white/10 hover:bg-white/15 text-amber-300'
                : 'bg-black/6 hover:bg-black/10 text-slate-700'
            }`}
          >
            {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        ref={menuRef}
        className={`shrink-0 flex items-center justify-between px-2 h-6 text-[11px] border-b select-none ${
          isDark
            ? 'bg-[#202020] border-[#333333] text-[#dcdcdc]'
            : 'bg-[#f3f3f3] border-[#d0d0d0] text-[#1e1e1e]'
        }`}
      >
        <div className="flex items-center gap-0.5 relative">
          <span className="font-semibold tracking-tight px-1.5 text-[#4da3ff] flex items-center gap-1 mr-1">
            <Server className="w-3 h-3" />
            ScpCraft
          </span>
          {menuList.map(({ id, label, items }) => (
            <div key={id} className="relative">
              <button
                type="button"
                onClick={() => setOpenMenu(openMenu === id ? null : id)}
                className={`px-2 py-0.5 transition-colors ${
                  openMenu === id
                    ? isDark
                      ? 'bg-[#1e4b85] text-white'
                      : 'bg-[#cce4f7] text-[#003366]'
                    : isDark
                    ? 'hover:bg-[#333333] text-[#dcdcdc]'
                    : 'hover:bg-[#e1e1e1] text-[#1e1e1e]'
                }`}
              >
                {label}
              </button>
              {openMenu === id && (
                <div
                  className={`absolute left-0 top-full w-64 border shadow-xl z-50 py-1 ${
                    isDark
                      ? 'bg-[#252526] border-[#454545] text-[#e0e0e0]'
                      : 'bg-white border-[#c8c8c8] text-[#1e1e1e]'
                  }`}
                >
                  {items.map((item) => (
                    <div key={item.label}>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          item.action();
                        }}
                        className={`w-full px-3 py-1 text-left flex items-center justify-between text-[11px] ${
                          isDark ? 'hover:bg-[#1e4b85] hover:text-white' : 'hover:bg-[#0078d7] hover:text-white'
                        }`}
                      >
                        <span>{item.label}</span>
                        {item.shortcut && (
                          <span className="text-[10px] opacity-70">{item.shortcut}</span>
                        )}
                      </button>
                      {item.divider && (
                        <div className={`my-1 border-t ${isDark ? 'border-[#3a3a3a]' : 'border-[#e0e0e0]'}`} />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <div
            className={`flex items-center border text-[10px] ${
              isDark ? 'bg-[#2a2a2a] border-[#3d3d3d]' : 'bg-[#e5e5e5] border-[#c8c8c8]'
            }`}
          >
            <button
              type="button"
              onClick={() => setInterfaceMode('commander')}
              title="Commander (Dual Pane)"
              className={`flex items-center gap-1 px-1.5 py-0.5 ${
                interfaceMode === 'commander'
                  ? 'bg-[#1e4b85] text-white'
                  : isDark
                  ? 'text-[#a0a0a0] hover:text-white'
                  : 'text-[#555555] hover:text-black'
              }`}
            >
              <Columns2 className="w-3 h-3" />
              {t('mode.commander')}
            </button>
            <button
              type="button"
              onClick={() => setInterfaceMode('explorer')}
              title={t('mode.explorer')}
              className={`flex items-center gap-1 px-1.5 py-0.5 ${
                interfaceMode === 'explorer'
                  ? 'bg-[#1e4b85] text-white'
                  : isDark
                  ? 'text-[#a0a0a0] hover:text-white'
                  : 'text-[#555555] hover:text-black'
              }`}
            >
              <LayoutPanelLeft className="w-3 h-3" />
              {t('mode.explorer')}
            </button>
          </div>

          <button
            type="button"
            onClick={toggleLocale}
            title={t('lang.toggle')}
            className={`px-1.5 py-0.5 border text-[10px] inline-flex items-center gap-1 ${
              isDark
                ? 'border-[#3d3d3d] hover:bg-[#333333] text-sky-300'
                : 'border-[#c8c8c8] hover:bg-[#e1e1e1] text-sky-700'
            }`}
          >
            <Globe className="w-3 h-3" />
            {t('lang.badge')}
          </button>

          <button
            type="button"
            onClick={toggleTheme}
            title={isDark ? t('theme.toLight') : t('theme.toDark')}
            className={`p-0.5 border ${
              isDark
                ? 'border-[#3d3d3d] hover:bg-[#333333] text-amber-300'
                : 'border-[#c8c8c8] hover:bg-[#e1e1e1] text-slate-700'
            }`}
          >
            {isDark ? <Sun className="w-3 h-3" /> : <Moon className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {showAbout && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShowAbout(false);
          }}
        >
          <div
            className={`w-full max-w-sm border shadow-2xl p-4 text-xs ${
              isDark ? 'bg-[#252526] border-[#454545] text-[#e0e0e0]' : 'bg-white border-[#c8c8c8] text-[#1e1e1e]'
            }`}
          >
            <div className="flex items-center justify-between mb-2 pb-2 border-b border-[#3a3a3a]">
              <span className="font-semibold">About ScpCraft v0.1.7</span>
              <button type="button" onClick={() => setShowAbout(false)} className="opacity-70 hover:opacity-100">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="leading-relaxed mb-2 opacity-85">
              ScpCraft is a cross-platform Commander/Explorer SFTP, SCP, FTP, WebDAV &amp; S3 client built with Tauri 2.0 (Rust + React/TypeScript).
            </p>
            <div className="text-[11px] leading-relaxed mb-3 pt-2 border-t border-current/10 opacity-80 space-y-1">
              <div className="font-semibold">Author: zack709</div>
              <div>Copyright &copy; 2026 zack709 &amp; ScpCraft Contributors</div>
              <div>
                Licensed under the Apache License, Version 2.0 (the &quot;License&quot;); you may not use this software except in compliance with the License.
              </div>
              <div className="font-mono text-[10px] opacity-75">
                http://www.apache.org/licenses/LICENSE-2.0
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowAbout(false)}
                className="px-3 py-1 bg-[#1e4b85] hover:bg-[#255da3] text-white text-xs"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** WinSCP TThemePageControl Session Tab Strip — sits below TopDock toolbars and directly above panes. */
export function SessionTabsBar() {
  const {
    theme,
    interfaceMode,
    leftPane,
    rightPane,
    rightPaneMode,
    tabs,
    activeTabId,
    closeTab,
    setActiveTab,
  } = useWorkspaceStore();

  const isDark = theme === 'dark';
  const isMac = isMacOS();

  const getTabTitle = (tabId: string, fallback: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.site) return `${tab.site.name} (${tab.site.protocol.toUpperCase()})`;
    if (tabId !== activeTabId) return fallback;
    const leftLabel = formatDirTabName(leftPane.currentPath);
    if (interfaceMode === 'explorer') return leftLabel;
    const rightLabel =
      rightPaneMode === 'local_secondary'
        ? formatDirTabName(rightPane.currentPath)
        : 'Remote';
    return `${leftLabel} – ${rightLabel}`;
  };

  return (
    <div
      className={`shrink-0 flex items-center ${
        isMac ? 'gap-1.5 px-3 h-9' : 'gap-0.5 px-1 h-6'
      } border-b overflow-x-auto select-none ${
        isMac
          ? isDark
            ? 'bg-[#1c1c1e] border-white/10'
            : 'bg-[#f2f2f7] border-black/10'
          : isDark
          ? 'bg-[#1b1b1b] border-[#333333]'
          : 'bg-[#e8e8e8] border-[#c8c8c8]'
      }`}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const displayTitle = getTabTitle(tab.id, tab.title);
        if (isMac) {
          return (
            <div
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`group flex items-center gap-2 px-3 py-1 rounded-lg text-[11px] cursor-pointer transition-all ${
                active
                  ? isDark
                    ? 'bg-[#2c2c2e] text-white shadow-sm ring-1 ring-white/12 font-medium'
                    : 'bg-white text-[#1d1d1f] shadow-sm ring-1 ring-black/8 font-medium'
                  : isDark
                  ? 'text-[#98989d] hover:bg-white/8 hover:text-white'
                  : 'text-[#6e6e73] hover:bg-black/5 hover:text-[#1d1d1f]'
              }`}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: tab.connected ? '#30d158' : '#ff9f0a' }}
              />
              <span className="truncate max-w-[220px]">{displayTitle}</span>
              {tabs.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  className="opacity-50 hover:opacity-100 rounded-full p-0.5 hover:bg-white/10"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          );
        }
        return (
          <div
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`group flex items-center gap-1.5 px-2.5 h-[22px] mt-[2px] rounded-t border-t-2 text-[11px] cursor-pointer transition-colors ${
              active
                ? isDark
                  ? 'bg-[#2b2b2b] text-white border-x border-[#3f3f3f]'
                  : 'bg-white text-[#1e1e1e] border-x border-[#c0c0c0] font-medium'
                : isDark
                ? 'bg-[#222222] text-[#a0a0a0] hover:bg-[#2a2a2a] border-transparent'
                : 'bg-[#dcdcdc] text-[#555555] hover:bg-[#e5e5e5] border-transparent'
            }`}
            style={{ borderTopColor: active ? tab.color : 'transparent' }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: tab.connected ? '#22c55e' : '#f59e0b' }}
            />
            <span className="truncate max-w-[200px]">{displayTitle}</span>
            {tabs.length > 1 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="opacity-60 hover:opacity-100 rounded p-0.5"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => useSiteStore.getState().openLoginDialog()}
        title="New Session / Open Site Manager (Ctrl+N)"
        className={
          isMac
            ? `flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-lg transition-colors ${
                isDark
                  ? 'text-[#98989d] hover:bg-white/10 hover:text-white'
                  : 'text-[#6e6e73] hover:bg-black/6 hover:text-[#1d1d1f]'
              }`
            : `flex items-center gap-1 px-2 h-5 mt-[2px] text-[11px] rounded-t ${
                isDark ? 'text-[#b0b0b0] hover:bg-[#2a2a2a] hover:text-white' : 'text-[#555555] hover:bg-[#e0e0e0]'
              }`
        }
      >
        <Plus className={isMac ? 'w-3.5 h-3.5' : 'w-3 h-3'} />
        New Tab
      </button>
    </div>
  );
}
