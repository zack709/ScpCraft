import {
  Activity,
  ArrowLeftRight,
  Filter,
  GitCompare,
  HardDrive,
  Keyboard,
  Link2,
  ListChecks,
  LogIn,
  RefreshCw,
  Search,
  Server,
  Settings,
  SplitSquareHorizontal,
  Terminal,
  Trash2,
  Wrench,
} from 'lucide-react';
import { translate } from '../../i18n';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useSiteStore } from '../../stores/useSiteStore';
import { isMacOS } from '../../utils/platform';
import { runCompareDirectories } from './HeaderTabs';

export function Toolbar() {
  const {
    theme,
    locale,
    activePane,
    leftPane,
    rightPane,
    rightPaneMode,
    setRightPaneMode,
    showQueueDock,
    toggleQueueDock,
    showFunctionKeyBar,
    toggleFunctionKeyBar,
    showCommandLineBar,
    toggleCommandLineBar,
    openModal,
    setSplitRatio,
    swapPanes,
    interfaceMode,
    transferPreset,
    setTransferPreset,
    addQueueLog,
    showTerminalDrawer,
    toggleTerminalDrawer,
    keepUpToDateActive,
  } = useWorkspaceStore();

  const isDark = theme === 'dark';
  const isMac = isMacOS();
  const current = activePane === 'left' ? leftPane : rightPane;
  const t = (k: Parameters<typeof translate>[1]) => translate(locale, k);

  const btnCls = isMac
    ? `flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-md transition-colors ${
        isDark
          ? 'text-[#e5e5ea] hover:bg-white/10 hover:text-white'
          : 'text-[#1d1d1f] hover:bg-black/6'
      }`
    : `flex items-center gap-1 px-1.5 py-0.5 text-[11px] border border-transparent transition-colors ${
        isDark
          ? 'text-[#dcdcdc] hover:bg-[#333333] hover:border-[#454545] hover:text-white'
          : 'text-[#1e1e1e] hover:bg-[#e1e1e1] hover:border-[#c8c8c8]'
      }`;

  const activeBtnCls = isMac
    ? `flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-md font-medium transition-colors ${
        isDark
          ? 'bg-[#0a84ff]/25 text-[#64d2ff] ring-1 ring-[#0a84ff]/50'
          : 'bg-[#007aff]/12 text-[#0066cc] ring-1 ring-[#007aff]/30'
      }`
    : `flex items-center gap-1 px-1.5 py-0.5 text-[11px] border transition-colors ${
        isDark
          ? 'bg-[#1e4b85]/60 text-white border-[#3b82f6]/60'
          : 'bg-[#cce4f7] text-[#003366] border-[#99c9ef]'
      }`;

  const sep = (
    <div
      className={`w-px h-4 mx-1 shrink-0 ${
        isMac
          ? isDark
            ? 'bg-white/10'
            : 'bg-black/10'
          : isDark
          ? 'bg-[#3f3f3f]'
          : 'bg-[#c8c8c8]'
      }`}
    />
  );

  const handleSynchronizeClick = () => {
    openModal('synchronize', activePane);
  };

  return (
    <div
      className={`shrink-0 flex items-center flex-wrap ${
        isMac ? 'gap-1 px-3 py-1.5' : 'gap-0.5 px-1.5 py-1'
      } border-b select-none ${
        isMac
          ? isDark
            ? 'bg-[#242426] border-white/10'
            : 'bg-[#f5f5f7] border-black/10'
          : isDark
          ? 'bg-[#252526] border-[#333333]'
          : 'bg-[#f5f5f5] border-[#d0d0d0]'
      }`}
    >
      {/* Session / Login Toolbar Action */}
      <button
        type="button"
        onClick={() => useSiteStore.getState().openLoginDialog()}
        className={btnCls}
        title="Open Login / Site Manager (Ctrl+N)"
      >
        <LogIn className="w-3.5 h-3.5 text-emerald-400" />
        {t('tb.newSession')}
      </button>

      {sep}

      {/* Commands Toolbar Group */}
      <button
        type="button"
        onClick={runCompareDirectories}
        className={btnCls}
        title="Compare Directories between Left & Right Panes"
      >
        <GitCompare className="w-3.5 h-3.5 text-amber-400" />
        {t('tb.compare')}
      </button>
      <button
        type="button"
        onClick={handleSynchronizeClick}
        className={btnCls}
        title="Synchronize Directories (Ctrl+S)"
      >
        <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />
        {t('tb.sync')}
      </button>
      <button
        type="button"
        onClick={() => openModal('keep_up_to_date', activePane)}
        className={keepUpToDateActive ? activeBtnCls : btnCls}
        title="Keep Remote Directory up to Date"
      >
        <Activity
          className={`w-3.5 h-3.5 ${
            keepUpToDateActive ? 'text-emerald-400 animate-pulse' : 'text-emerald-400'
          }`}
        />
        {t('tb.keepUpToDate')}
      </button>
      <button
        type="button"
        onClick={() => openModal('find_files', activePane)}
        className={btnCls}
        title="Find Files (Alt+F7)"
      >
        <Search className="w-3.5 h-3.5 text-sky-400" />
        {t('tb.find')}
      </button>
      <button
        type="button"
        onClick={() => openModal('filter', activePane)}
        className={current.filterMask !== '*' ? activeBtnCls : btnCls}
        title="Filter File Mask (Ctrl+F)"
      >
        <Filter className="w-3.5 h-3.5 text-sky-300" />
        {t('tb.filter')}{current.filterMask !== '*' ? `: ${current.filterMask}` : ''}
      </button>

      {sep}

      {/* Preferences & Tools Toolbar Group */}
      <button
        type="button"
        onClick={() => openModal('preferences', activePane)}
        className={btnCls}
        title="Preferences (Ctrl+,)"
      >
        <Settings className="w-3.5 h-3.5 text-amber-300" />
        {t('tb.preferences')}
      </button>
      <button
        type="button"
        onClick={() => openModal('generate_url', activePane)}
        className={btnCls}
        title="Generate Session URL / Script / Code (Ctrl+Shift+U)"
      >
        <Link2 className="w-3.5 h-3.5 text-sky-400" />
        {t('tb.generateUrl')}
      </button>
      <button
        type="button"
        onClick={() => openModal('cleanup', activePane)}
        className={btnCls}
        title="Cleanup Application Data"
      >
        <Trash2 className="w-3.5 h-3.5 text-rose-400" />
        {t('tb.cleanup')}
      </button>
      <button
        type="button"
        onClick={toggleQueueDock}
        className={showQueueDock ? activeBtnCls : btnCls}
        title="Toggle Transfer Queue Panel"
      >
        <ListChecks className="w-3.5 h-3.5" />
        {t('tb.queue')}
      </button>

      {sep}

      {/* Transfer Settings Toolbar Group */}
      <div className="flex items-center gap-1.5 px-1 text-[11px]">
        <span className={isDark ? 'text-[#a0a0a0]' : 'text-[#555555]'}>
          {t('tb.transferSettings')}
        </span>
        <select
          aria-label="Transfer Settings Preset"
          value={transferPreset}
          onChange={(e) => {
            const next = e.target.value as 'Default' | 'Binary' | 'Text';
            setTransferPreset(next);
            addQueueLog({
              operation: 'copy',
              source: 'Transfer Preset',
              target: next,
              status: 'done',
              detail: `Transfer mode preset set to "${next}".`,
            });
          }}
          className={`h-5 px-1.5 border text-[11px] outline-none ${
            isDark
              ? 'bg-[#1e1e1e] border-[#3f3f3f] text-[#e0e0e0]'
              : 'bg-white border-[#c0c0c0] text-[#1e1e1e]'
          }`}
        >
          <option value="Default">Default</option>
          <option value="Binary">Binary</option>
          <option value="Text">Text</option>
        </select>
      </div>

      {sep}

      {/* View / Layout Controls */}
      {interfaceMode === 'commander' && (
        <>
          <button
            type="button"
            onClick={() => setSplitRatio(0.5)}
            className={btnCls}
            title="Equalize Panel Widths (50/50)"
          >
            <SplitSquareHorizontal className="w-3.5 h-3.5" />
            50/50
          </button>
          <button
            type="button"
            onClick={swapPanes}
            className={btnCls}
            title="Swap Left & Right Panels (Ctrl+U)"
          >
            <ArrowLeftRight className="w-3.5 h-3.5" />
            {t('tb.swap')}
          </button>
          <button
            type="button"
            onClick={() =>
              setRightPaneMode(
                rightPaneMode === 'local_secondary' ? 'remote_placeholder' : 'local_secondary'
              )
            }
            className={rightPaneMode === 'local_secondary' ? activeBtnCls : btnCls}
            title="Switch Right Pane between Local Browser and Remote Connection Panel"
          >
            {rightPaneMode === 'local_secondary' ? (
              <>
                <HardDrive className="w-3.5 h-3.5" />
                {t('tb.rightLocal')}
              </>
            ) : (
              <>
                <Server className="w-3.5 h-3.5" />
                {t('tb.rightRemote')}
              </>
            )}
          </button>
          {sep}
        </>
      )}

      <button
        type="button"
        onClick={() => toggleTerminalDrawer()}
        className={showTerminalDrawer ? activeBtnCls : btnCls}
        title="Toggle Interactive SSH Terminal / Console (Ctrl+T)"
      >
        <Terminal className="w-3.5 h-3.5 text-emerald-400" />
        {t('tb.terminal')}
      </button>
      <button
        type="button"
        onClick={() => openModal('custom_commands', activePane)}
        className={btnCls}
        title="Custom Commands..."
      >
        <Wrench className="w-3.5 h-3.5 text-amber-300" />
        {t('tb.customCmds')}
      </button>
      <button
        type="button"
        onClick={toggleCommandLineBar}
        className={showCommandLineBar ? activeBtnCls : btnCls}
        title="Toggle Command Bar"
      >
        <Terminal className="w-3.5 h-3.5" />
        {t('tb.commandBar')}
      </button>
      <button
        type="button"
        onClick={toggleFunctionKeyBar}
        className={showFunctionKeyBar ? activeBtnCls : btnCls}
        title="Toggle Function Key Bar"
      >
        <Keyboard className="w-3.5 h-3.5" />
        {t('tb.fkeys')}
      </button>
    </div>
  );
}
