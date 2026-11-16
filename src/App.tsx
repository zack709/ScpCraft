import { useEffect, useRef } from 'react';
import { MainMenuBar, SessionTabsBar } from './components/Layout/HeaderTabs';
import { Toolbar } from './components/Layout/Toolbar';
import { FunctionKeyBar } from './components/Layout/FunctionKeyBar';
import { FilePane } from './components/Pane/FilePane';
import { TransferQueueDock } from './components/Queue/TransferQueueDock';
import { FileOperationModals } from './components/Modals/FileOperationModals';
import { SiteManagerModal } from './components/SiteManager/SiteManagerModal';
import { AdvancedSiteModal } from './components/SiteManager/AdvancedSiteModal';
import { HostKeyModal } from './components/Auth/HostKeyModal';
import { InteractiveAuthModal } from './components/Auth/InteractiveAuthModal';
import { CopyConfirmModal } from './components/Transfer/CopyConfirmModal';
import { OverwriteModal } from './components/Transfer/OverwriteModal';
import { RemoteEditorModal } from './components/Editor/RemoteEditorModal';
import { TerminalDrawer } from './components/Terminal/TerminalDrawer';
import { CustomCommandModal } from './components/Modals/CustomCommandModal';
import { SynchronizeModal } from './components/Sync/SynchronizeModal';
import { RemoteFindModal } from './components/Modals/RemoteFindModal';
import { PreferencesModal } from './components/Modals/PreferencesModal';
import { CleanupModal } from './components/Modals/CleanupModal';
import { GenerateUrlModal } from './components/Modals/GenerateUrlModal';
import { usePaneNavigation } from './hooks/usePaneNavigation';
import { DragDropOverlay, useDragDropTransfer } from './hooks/useDragDropTransfer';
import { useSiteStore } from './stores/useSiteStore';
import { useWorkspaceStore } from './stores/useWorkspaceStore';
import { translate } from './i18n';
import { isMacOS } from './utils/platform';
import './App.css';

export function App() {
  const {
    theme,
    locale,
    interfaceMode,
    splitRatio,
    setSplitRatio,
    showQueueDock,
    queueHeight,
    setQueueHeight,
    initWorkspace,
  } = useWorkspaceStore();

  usePaneNavigation();
  useDragDropTransfer();

  useEffect(() => {
    void initWorkspace();
    void useSiteStore.getState().initSites();
  }, [initWorkspace]);

  const workspaceRef = useRef<HTMLDivElement>(null);

  const startHorizontalDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = workspaceRef.current;
    if (!container) return;

    const onMove = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0) {
        setSplitRatio((ev.clientX - rect.left) / rect.width);
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startQueueDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = queueHeight;

    const onMove = (ev: MouseEvent) => {
      setQueueHeight(startHeight + (startY - ev.clientY));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const isDark = theme === 'dark';
  const isMac = isMacOS();

  return (
    <div
      className={`h-screen w-screen flex flex-col overflow-hidden ${
        isMac
          ? isDark
            ? 'bg-[#1c1c1e] text-[#f5f5f7]'
            : 'bg-[#f5f5f7] text-[#1d1d1f]'
          : isDark
          ? 'bg-[#1e1e1e] text-[#e0e0e0]'
          : 'bg-white text-[#1e1e1e]'
      }`}
    >
      <MainMenuBar />
      <Toolbar />
      <SessionTabsBar />

      {/* Main Split Workspace */}
      <main ref={workspaceRef} className="flex-1 flex min-h-0 overflow-hidden">
        {interfaceMode === 'commander' ? (
          <>
            <div style={{ width: `${splitRatio * 100}%` }} className="h-full min-w-[185px]">
              <FilePane paneId="left" title={translate(locale, 'pane.local')} />
            </div>

            {/* Draggable Splitter (double click resets 50/50 like WinSCP TSplitter) */}
            <div
              onMouseDown={startHorizontalDrag}
              onDoubleClick={() => setSplitRatio(0.5)}
              title="Drag to resize panels; double-click for 50/50"
              className={
                isMac
                  ? `w-[4px] shrink-0 cursor-col-resize transition-colors ${
                      isDark
                        ? 'bg-[#1c1c1e] hover:bg-[#0a84ff]/70'
                        : 'bg-[#e5e5ea] hover:bg-[#007aff]/70'
                    }`
                  : `w-[5px] shrink-0 cursor-col-resize transition-colors border-x ${
                      isDark
                        ? 'bg-[#2b2b2b] border-[#3a3a3a] hover:bg-[#1e4b85]'
                        : 'bg-[#e0e0e0] border-[#c8c8c8] hover:bg-[#0078d7]'
                    }`
              }
            />

            <div style={{ width: `${(1 - splitRatio) * 100}%` }} className="h-full min-w-[185px]">
              <FilePane paneId="right" title={translate(locale, 'pane.target')} />
            </div>
          </>
        ) : (
          <div className="w-full h-full">
            <FilePane paneId="left" title={translate(locale, 'pane.explorer')} />
          </div>
        )}
      </main>

      <FunctionKeyBar />

      <TerminalDrawer />

      {showQueueDock && (
        <div
          onMouseDown={startQueueDrag}
          title="Drag to resize Transfer Queue panel"
          className={`h-1 shrink-0 cursor-row-resize transition-colors ${
            isDark
              ? 'bg-[#2b2b2b] hover:bg-[#1e4b85]'
              : 'bg-[#d0d0d0] hover:bg-[#0078d7]'
          }`}
        />
      )}

      <TransferQueueDock />
      <FileOperationModals />
      <CopyConfirmModal />
      <OverwriteModal />
      <DragDropOverlay />
      <SiteManagerModal />
      <AdvancedSiteModal />
      <HostKeyModal />
      <InteractiveAuthModal />
      <RemoteEditorModal />
      <CustomCommandModal />
      <SynchronizeModal />
      <RemoteFindModal />
      <PreferencesModal />
      <CleanupModal />
      <GenerateUrlModal />
    </div>
  );
}

export default App;
