import { create } from 'zustand';
import { localFsApi } from '../services/localFsApi';
import {
  sftpApi,
  type AuthChallengeInfo,
  type HostKeyPromptInfo,
  type LocationProfile,
  type SftpConnectOutcome,
  type SftpConnectRequest,
} from '../services/sftpApi';
import {
  editorApi,
  shellApi,
  syncApi,
  type EditorDocument,
} from '../services/phase5Api';
import {
  onNativeMenuAction,
  preferencesApi,
  type AppPreferences,
} from '../services/phase6Api';
import type { LocaleCode } from '../i18n';
import {
  buildDefaultTransferOptions,
  transferApi,
  type EnqueueTransferRequest,
  type TransferDirection,
  type TransferPresetName,
  type TransferQueueSnapshot,
  type TransferTaskStatus,
} from '../services/transferApi';
import type {
  ActiveModalType,
  DirectoryListing,
  DriveInfo,
  FileEntry,
  InterfaceMode,
  PaneId,
  PaneState,
  QueueItem,
  RightPaneMode,
  SessionTab,
  SortField,
  ThemeMode,
} from '../types/fs';
import type { SiteConfig } from '../types/site';
import { getVisibleSortedEntries } from '../utils/formatters';

function createInitialPaneState(): PaneState {
  return {
    currentPath: '',
    parentPath: null,
    breadcrumbs: [],
    entries: [],
    totalFiles: 0,
    totalDirs: 0,
    hiddenCount: 0,
    totalBytes: 0,
    loading: false,
    error: null,
    showHidden: false,
    showTree: false,
    filterMask: '*',
    sortField: 'name',
    sortDir: 'asc',
    selectedPaths: [],
    focusedPath: null,
    lastAnchorPath: null,
    history: [],
    historyIndex: -1,
  };
}

export interface ConnectSecrets {
  password?: string;
  passphrase?: string;
  tunnelPassword?: string;
}

export interface CopyDialogPreset {
  sourcePane: PaneId;
  sources: string[];
  targetDir: string;
  isMove: boolean;
  direction: TransferDirection;
  isDesktopDrop?: boolean;
}

function isTerminalTransferStatus(status: TransferTaskStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'skipped' ||
    status === 'cancelled'
  );
}

let transferListenerInitialized = false;
let phase5ListenersInitialized = false;
let phase6MenuListenerInitialized = false;

const DEFAULT_PREFERENCES: AppPreferences = {
  language: 'zh-TW',
  theme: 'dark',
  interfaceMode: 'commander',
  showHiddenFiles: false,
  confirmOverwriting: true,
  confirmDeleting: true,
  confirmClosingSession: true,
  maxConcurrentTransfers: 3,
  defaultSpeedLimitKbps: 0,
  useFilepartResume: true,
  externalEditorCommand: 'code --wait',
  doubleClickAction: 'edit',
  rememberSessionTabs: false,
};

interface WorkspaceStore {
  theme: ThemeMode;
  locale: LocaleCode;
  preferences: AppPreferences;
  interfaceMode: InterfaceMode;
  activePane: PaneId;
  rightPaneMode: RightPaneMode;
  splitRatio: number;
  showQueueDock: boolean;
  queueHeight: number;
  showFunctionKeyBar: boolean;
  showCommandLineBar: boolean;

  drives: DriveInfo[];
  tabs: SessionTab[];
  activeTabId: string;

  connectingSession: boolean;
  connectionError: string | null;
  pendingConnectRequest: SftpConnectRequest | null;
  hostKeyPrompt: HostKeyPromptInfo | null;
  authChallenge: AuthChallengeInfo | null;
  bookmarks: LocationProfile[];

  leftPane: PaneState;
  rightPane: PaneState;

  queueItems: QueueItem[];
  transferPreset: TransferPresetName;
  transferSnapshot: TransferQueueSnapshot | null;
  foregroundBatchId: string | null;
  copyDialogPreset: CopyDialogPreset | null;
  activeModal: ActiveModalType;
  modalPane: PaneId;
  commandHistory: string[];

  openEditorFiles: EditorDocument[];
  editorDrafts: Record<string, string>;
  activeEditorDocId: string | null;
  isEditorModalOpen: boolean;
  showTerminalDrawer: boolean;
  terminalConsoleLogs: string[];
  keepUpToDateActive: boolean;

  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  setLocale: (locale: LocaleCode) => void;
  toggleLocale: () => void;
  loadPreferences: () => Promise<void>;
  savePreferences: (prefs: AppPreferences) => Promise<void>;
  setInterfaceMode: (mode: InterfaceMode) => void;
  setActivePane: (pane: PaneId) => void;
  setRightPaneMode: (mode: RightPaneMode) => void;
  setSplitRatio: (ratio: number) => void;
  toggleQueueDock: () => void;
  setQueueHeight: (height: number) => void;
  toggleFunctionKeyBar: () => void;
  toggleCommandLineBar: () => void;
  swapPanes: () => void;

  addTab: () => void;
  connectSessionWithSite: (site: SiteConfig, secrets?: ConnectSecrets) => Promise<void>;
  reconnectSiteOnTab: (tabId: string, site: SiteConfig, secrets?: ConnectSecrets) => Promise<void>;
  trustAndReconnectHostKey: (savePermanently: boolean) => Promise<void>;
  cancelHostKeyPrompt: () => Promise<void>;
  submitAuthChallenge: (responses: string[], saveSecret: boolean) => Promise<void>;
  cancelAuthChallenge: () => Promise<void>;
  disconnectActiveSession: () => Promise<void>;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;

  loadBookmarks: (siteId?: string | null) => Promise<void>;
  saveBookmarks: (bookmarks: LocationProfile[]) => Promise<void>;

  openModal: (modal: ActiveModalType, pane?: PaneId) => void;
  openCopyDialogWithPreset: (preset: CopyDialogPreset) => void;
  closeModal: () => void;
  setTransferPreset: (preset: TransferPresetName) => void;
  setForegroundBatchId: (batchId: string | null) => void;
  enqueueTransfer: (
    request: EnqueueTransferRequest,
    showForegroundProgress?: boolean,
  ) => Promise<string>;
  addQueueLog: (item: Omit<QueueItem, 'id' | 'timestamp'>) => void;
  clearQueueLogs: () => void;

  initWorkspace: () => Promise<void>;
  loadDrives: () => Promise<void>;
  navigateTo: (pane: PaneId, path: string | null, pushHistory?: boolean) => Promise<void>;
  cancelNavigation: (pane: PaneId) => void;
  refreshPane: (pane: PaneId) => Promise<void>;
  goBack: (pane: PaneId) => Promise<void>;
  goForward: (pane: PaneId) => Promise<void>;
  goUp: (pane: PaneId) => Promise<void>;
  goRoot: (pane: PaneId) => Promise<void>;
  goHome: (pane: PaneId) => Promise<void>;

  toggleShowHidden: (pane: PaneId) => Promise<void>;
  toggleTreeSidebar: (pane: PaneId) => void;
  setFilterMask: (pane: PaneId, mask: string) => void;
  setSort: (pane: PaneId, field: SortField) => void;

  setFocusedPath: (pane: PaneId, path: string | null) => void;
  selectSingle: (pane: PaneId, path: string) => void;
  toggleSelect: (pane: PaneId, path: string) => void;
  selectRange: (pane: PaneId, targetPath: string) => void;
  selectAll: (pane: PaneId) => void;
  clearSelection: (pane: PaneId) => void;
  invertSelection: (pane: PaneId) => void;
  moveFocus: (pane: PaneId, delta: number, extendSelection?: boolean) => void;

  createDirectory: (pane: PaneId, name: string, octalMode?: string | null) => Promise<void>;
  createFile: (pane: PaneId, name: string) => Promise<void>;
  createSymlink: (
    pane: PaneId,
    linkName: string,
    targetPath: string,
    isHardLink: boolean,
  ) => Promise<void>;
  renameEntry: (pane: PaneId, targetPath: string, newName: string) => Promise<void>;
  deleteSelected: (pane: PaneId, useTrash: boolean) => Promise<void>;
  copyOrMoveSelected: (sourcePane: PaneId, targetDir: string, isMove: boolean) => Promise<void>;
  runCommandInput: (cmd: string) => void;

  openFileInEditor: (pane: PaneId, path?: string) => Promise<void>;
  setActiveEditorDocId: (docId: string | null) => void;
  updateEditorDraft: (docId: string, content: string) => void;
  updateEditorDocMeta: (doc: EditorDocument, resetDraft?: boolean) => void;
  closeEditorDoc: (docId: string) => Promise<void>;
  closeEditorModal: () => void;
  toggleTerminalDrawer: (open?: boolean) => void;
  appendTerminalConsole: (line: string) => void;
  clearTerminalConsole: () => void;
  setKeepUpToDateActive: (active: boolean) => void;
}

function getPane(state: WorkspaceStore, pane: PaneId): PaneState {
  return pane === 'left' ? state.leftPane : state.rightPane;
}

function updatePane(
  state: WorkspaceStore,
  pane: PaneId,
  updater: (prev: PaneState) => PaneState,
): Partial<WorkspaceStore> {
  if (pane === 'left') {
    return { leftPane: updater(state.leftPane) };
  }
  return { rightPane: updater(state.rightPane) };
}

function isRemoteSftpPane(state: WorkspaceStore, pane: PaneId): boolean {
  return pane === 'right' && state.rightPaneMode === 'remote_sftp';
}

function applyListingToPane(
  prev: PaneState,
  listing: DirectoryListing,
  pushHistory: boolean,
): PaneState {
  let nextHistory = prev.history;
  let nextIdx = prev.historyIndex;
  if (pushHistory && listing.path && prev.history[prev.historyIndex] !== listing.path) {
    nextHistory = prev.history.slice(0, prev.historyIndex + 1);
    nextHistory.push(listing.path);
    nextIdx = nextHistory.length - 1;
  }

  const firstFocus = listing.parentPath
    ? '__PARENT__'
    : listing.entries[0]?.path ?? null;

  return {
    ...prev,
    currentPath: listing.path,
    parentPath: listing.parentPath,
    breadcrumbs: listing.breadcrumbs,
    entries: listing.entries,
    totalFiles: listing.totalFiles,
    totalDirs: listing.totalDirs,
    hiddenCount: listing.hiddenCount,
    totalBytes: listing.totalBytes,
    loading: false,
    error: null,
    selectedPaths: [],
    focusedPath: firstFocus,
    lastAnchorPath: firstFocus,
    history: nextHistory,
    historyIndex: nextIdx,
  };
}

function getOrderedRowPaths(paneState: PaneState, respectHidden = false): string[] {
  const sorted = getVisibleSortedEntries(
    paneState.entries,
    paneState.filterMask,
    paneState.sortField,
    paneState.sortDir,
    respectHidden ? paneState.showHidden : true,
  );
  const rows: string[] = [];
  if (paneState.parentPath) {
    rows.push('__PARENT__');
  }
  for (const e of sorted) {
    rows.push(e.path);
  }
  return rows;
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => {
  const tabRightPanes = new Map<string, PaneState>();
  const navSeq: Record<PaneId, number> = { left: 0, right: 0 };

  const applyConnectOutcome = async (
    sessionId: string,
    site: SiteConfig,
    outcome: SftpConnectOutcome,
  ) => {
    if (outcome.outcome === 'host_key_prompt') {
      set({
        connectingSession: false,
        hostKeyPrompt: outcome.payload,
        authChallenge: null,
      });
      return;
    }

    if (outcome.outcome === 'auth_prompt') {
      set({
        connectingSession: false,
        authChallenge: outcome.payload,
        hostKeyPrompt: null,
      });
      return;
    }

    const { initialListing, authMethodUsed, initialPath } = outcome.payload;
    set((s) => ({
      connectingSession: false,
      connectionError: null,
      pendingConnectRequest: null,
      hostKeyPrompt: null,
      authChallenge: null,
      rightPaneMode: s.interfaceMode === 'commander' ? 'remote_sftp' : s.rightPaneMode,
      activePane: s.interfaceMode === 'commander' ? 'right' : s.activePane,
      tabs: s.tabs.map((t) =>
        t.id === sessionId ? { ...t, connected: true } : t,
      ),
      rightPane: applyListingToPane(createInitialPaneState(), initialListing, true),
    }));

    get().addQueueLog({
      operation: 'copy',
      source: `${site.protocol.toUpperCase()}://${site.userName || 'anonymous'}@${site.hostName}:${site.portNumber}`,
      target: initialPath,
      status: 'done',
      detail: `Connected via ${authMethodUsed} authentication (${initialListing.totalDirs} dirs, ${initialListing.totalFiles} files)`,
    });

    if (site.advanced.localDirectory.trim()) {
      await get().navigateTo('left', site.advanced.localDirectory.trim(), true);
    }
  };

  const executeSftpConnect = async (request: SftpConnectRequest) => {
    set({
      connectingSession: true,
      connectionError: null,
      pendingConnectRequest: request,
      hostKeyPrompt: null,
      authChallenge: null,
    });

    try {
      const outcome = await sftpApi.connect(request);
      await applyConnectOutcome(request.sessionId, request.site, outcome);
    } catch (err) {
      const msg = String(err);
      set({
        connectingSession: false,
        connectionError: msg,
        pendingConnectRequest: null,
      });
      get().addQueueLog({
        operation: 'copy',
        source: `${request.site.protocol.toUpperCase()}://${request.site.userName || 'anonymous'}@${request.site.hostName}:${request.site.portNumber}`,
        target: 'Connection failed',
        status: 'error',
        detail: msg,
      });
    }
  };

  return {
    theme: 'dark',
    locale: 'zh-TW',
    preferences: DEFAULT_PREFERENCES,
    interfaceMode: 'commander',
    activePane: 'left',
    rightPaneMode: 'local_secondary',
    splitRatio: 0.5,
    showQueueDock: true,
    queueHeight: 136,
    showFunctionKeyBar: true,
    showCommandLineBar: false,

    drives: [],
    tabs: [
      {
        id: 'tab-1',
        title: 'Local / Workspace',
        protocol: 'Local',
        connected: true,
        color: '#3b82f6',
      },
    ],
    activeTabId: 'tab-1',

    connectingSession: false,
    connectionError: null,
    pendingConnectRequest: null,
    hostKeyPrompt: null,
    authChallenge: null,
    bookmarks: [],

    leftPane: createInitialPaneState(),
    rightPane: createInitialPaneState(),

    queueItems: [],
    transferPreset: 'Default',
    transferSnapshot: null,
    foregroundBatchId: null,
    copyDialogPreset: null,
    activeModal: 'none',
    modalPane: 'left',
    commandHistory: [],

    openEditorFiles: [],
    editorDrafts: {},
    activeEditorDocId: null,
    isEditorModalOpen: false,
    showTerminalDrawer: false,
    terminalConsoleLogs: [],
    keepUpToDateActive: false,

    setTheme: (theme) => set({ theme }),
    toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
    setLocale: (locale) => set({ locale }),
    toggleLocale: () =>
      set((s) => ({ locale: s.locale === 'zh-TW' ? 'en' : 'zh-TW' })),
    loadPreferences: async () => {
      try {
        const prefs = await preferencesApi.get();
        const nextLocale: LocaleCode = prefs.language === 'en' ? 'en' : 'zh-TW';
        const nextTheme: ThemeMode = prefs.theme === 'light' ? 'light' : 'dark';
        const nextMode: InterfaceMode =
          prefs.interfaceMode === 'explorer' ? 'explorer' : 'commander';
        set((s) => ({
          preferences: prefs,
          locale: nextLocale,
          theme: nextTheme,
          interfaceMode: nextMode,
          leftPane: { ...s.leftPane, showHidden: prefs.showHiddenFiles },
          rightPane: { ...s.rightPane, showHidden: prefs.showHiddenFiles },
        }));
        await transferApi.updateSettings(
          prefs.maxConcurrentTransfers,
          prefs.defaultSpeedLimitKbps,
        );
      } catch {
        // Ignore outside Tauri runtime
      }
    },
    savePreferences: async (prefs) => {
      const saved = await preferencesApi.save(prefs);
      const nextLocale: LocaleCode = saved.language === 'en' ? 'en' : 'zh-TW';
      const nextTheme: ThemeMode = saved.theme === 'light' ? 'light' : 'dark';
      const nextMode: InterfaceMode =
        saved.interfaceMode === 'explorer' ? 'explorer' : 'commander';
      set((s) => ({
        preferences: saved,
        locale: nextLocale,
        theme: nextTheme,
        interfaceMode: nextMode,
        leftPane: { ...s.leftPane, showHidden: saved.showHiddenFiles },
        rightPane: { ...s.rightPane, showHidden: saved.showHiddenFiles },
      }));
      try {
        await transferApi.updateSettings(
          saved.maxConcurrentTransfers,
          saved.defaultSpeedLimitKbps,
        );
      } catch {
        // Ignore outside Tauri runtime
      }
      await get().refreshPane('left');
      if (get().rightPaneMode !== 'remote_placeholder') {
        await get().refreshPane('right');
      }
    },
    setInterfaceMode: (interfaceMode) => set({ interfaceMode }),
    setActivePane: (activePane) => set({ activePane }),
    setRightPaneMode: (rightPaneMode) => set({ rightPaneMode }),
    setSplitRatio: (ratio) => set({ splitRatio: Math.min(0.8, Math.max(0.2, ratio)) }),
    toggleQueueDock: () => set((s) => ({ showQueueDock: !s.showQueueDock })),
    setQueueHeight: (queueHeight) => set({ queueHeight: Math.min(380, Math.max(84, queueHeight)) }),
    toggleFunctionKeyBar: () => set((s) => ({ showFunctionKeyBar: !s.showFunctionKeyBar })),
    toggleCommandLineBar: () => set((s) => ({ showCommandLineBar: !s.showCommandLineBar })),

    swapPanes: () =>
      set((s) => ({
        leftPane: s.rightPane,
        rightPane: s.leftPane,
        activePane: s.activePane === 'left' ? 'right' : 'left',
      })),

    addTab: () =>
      set((s) => {
        tabRightPanes.set(s.activeTabId, s.rightPane);
        const idx = s.tabs.length + 1;
        const newTab: SessionTab = {
          id: `tab-${Date.now()}`,
          title: `Session ${idx}`,
          protocol: 'SFTP (Pending)',
          connected: false,
          color: '#10b981',
        };
        return {
          tabs: [...s.tabs, newTab],
          activeTabId: newTab.id,
          rightPane: createInitialPaneState(),
          rightPaneMode: s.interfaceMode === 'commander' ? 'remote_placeholder' : s.rightPaneMode,
          connectionError: null,
        };
      }),

    connectSessionWithSite: async (site, secrets) => {
      const label =
        site.name.trim() ||
        (site.userName ? `${site.userName}@${site.hostName}` : site.hostName) ||
        'Remote Session';
      const tabId = `tab-${Date.now()}`;
      const newTab: SessionTab = {
        id: tabId,
        title: label,
        protocol: site.protocol.toUpperCase(),
        connected: false,
        color: site.color || '#10b981',
        site,
      };

      set((s) => {
        tabRightPanes.set(s.activeTabId, s.rightPane);
        return {
          tabs: [...s.tabs, newTab],
          activeTabId: tabId,
          rightPane: createInitialPaneState(),
          rightPaneMode: s.interfaceMode === 'commander' ? 'remote_placeholder' : s.rightPaneMode,
          connectionError: null,
        };
      });

      await executeSftpConnect({
        sessionId: tabId,
        site,
        password: secrets?.password ?? null,
        passphrase: secrets?.passphrase ?? null,
        tunnelPassword: secrets?.tunnelPassword ?? null,
      });
    },

    reconnectSiteOnTab: async (tabId, site, secrets) => {
      set((s) => {
        if (s.activeTabId !== tabId) {
          tabRightPanes.set(s.activeTabId, s.rightPane);
        }
        return {
          activeTabId: tabId,
          rightPane: createInitialPaneState(),
          rightPaneMode: 'remote_placeholder',
          tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, connected: false, site } : t)),
        };
      });
      await executeSftpConnect({
        sessionId: tabId,
        site,
        password: secrets?.password ?? null,
        passphrase: secrets?.passphrase ?? null,
        tunnelPassword: secrets?.tunnelPassword ?? null,
      });
    },

    trustAndReconnectHostKey: async (savePermanently) => {
      const { hostKeyPrompt, pendingConnectRequest } = get();
      if (!hostKeyPrompt || !pendingConnectRequest) return;

      set({ connectingSession: true });
      try {
        await sftpApi.trustHostKey(
          hostKeyPrompt.host,
          hostKeyPrompt.port,
          hostKeyPrompt.publicKeyOpenssh,
          savePermanently,
        );
        await executeSftpConnect(pendingConnectRequest);
      } catch (err) {
        set({
          connectingSession: false,
          hostKeyPrompt: null,
          connectionError: String(err),
        });
      }
    },

    cancelHostKeyPrompt: async () => {
      set({
        hostKeyPrompt: null,
        connectingSession: false,
        pendingConnectRequest: null,
        connectionError: 'Host key verification cancelled by user.',
      });
    },

    submitAuthChallenge: async (responses, saveSecret) => {
      const { authChallenge } = get();
      if (!authChallenge) return;

      set({ connectingSession: true });
      try {
        const outcome = await sftpApi.respondAuth(
          authChallenge.challengeId,
          responses,
          saveSecret,
        );
        const site = get().tabs.find((t) => t.id === authChallenge.sessionId)?.site ??
          get().pendingConnectRequest?.site;
        if (!site) {
          set({ connectingSession: false, authChallenge: null });
          return;
        }
        await applyConnectOutcome(authChallenge.sessionId, site, outcome);
      } catch (err) {
        set({
          connectingSession: false,
          authChallenge: null,
          connectionError: String(err),
        });
      }
    },

    cancelAuthChallenge: async () => {
      const { authChallenge } = get();
      if (authChallenge) {
        try {
          await sftpApi.cancelAuth(authChallenge.challengeId);
        } catch {
          // Ignore already closed challenge
        }
      }
      set({
        authChallenge: null,
        connectingSession: false,
        pendingConnectRequest: null,
        connectionError: 'Authentication cancelled by user.',
      });
    },

    disconnectActiveSession: async () => {
      const { activeTabId } = get();
      try {
        await sftpApi.disconnect(activeTabId);
      } catch {
        // Ignore if session already closed
      }
      set((s) => ({
        rightPaneMode: 'remote_placeholder',
        rightPane: createInitialPaneState(),
        tabs: s.tabs.map((t) =>
          t.id === activeTabId ? { ...t, connected: false } : t,
        ),
      }));
      get().addQueueLog({
        operation: 'copy',
        source: activeTabId,
        target: 'Disconnected',
        status: 'done',
        detail: 'Closed remote SFTP session.',
      });
    },

    closeTab: (id) => {
      const targetTab = get().tabs.find((t) => t.id === id);
      if (targetTab?.site && targetTab.connected) {
        void sftpApi.disconnect(id).catch(() => undefined);
      }

      let switchedTab: SessionTab | undefined;
      let closingActive = false;
      set((s) => {
        if (s.tabs.length <= 1) return s;
        tabRightPanes.delete(id);
        closingActive = s.activeTabId === id;
        const filtered = s.tabs.filter((t) => t.id !== id);
        const nextActive = closingActive ? filtered[filtered.length - 1].id : s.activeTabId;
        switchedTab = filtered.find((t) => t.id === nextActive);
        const nextMode: RightPaneMode =
          switchedTab?.site && switchedTab.connected
            ? 'remote_sftp'
            : switchedTab?.site
            ? 'remote_placeholder'
            : 'local_secondary';
        const restoredRightPane = closingActive
          ? tabRightPanes.get(nextActive) ?? createInitialPaneState()
          : s.rightPane;
        return {
          tabs: filtered,
          activeTabId: nextActive,
          rightPane: restoredRightPane,
          rightPaneMode: s.interfaceMode === 'commander' ? nextMode : s.rightPaneMode,
        };
      });

      if (closingActive) {
        if (switchedTab?.site && switchedTab.connected) {
          void get().refreshPane('right');
        } else if (switchedTab && !switchedTab.site) {
          if (!get().rightPane.currentPath) {
            void get().navigateTo('right', null, true);
          } else {
            void get().refreshPane('right');
          }
        }
      }
    },

    setActiveTab: (activeTabId) => {
      const prevActiveId = get().activeTabId;
      if (prevActiveId === activeTabId) return;
      const tab = get().tabs.find((t) => t.id === activeTabId);
      set((s) => {
        tabRightPanes.set(s.activeTabId, s.rightPane);
        const restoredRightPane = tabRightPanes.get(activeTabId) ?? createInitialPaneState();
        let nextMode = s.rightPaneMode;
        if (s.interfaceMode === 'commander') {
          if (tab?.site && tab.connected) {
            nextMode = 'remote_sftp';
          } else if (tab?.site) {
            nextMode = 'remote_placeholder';
          } else {
            nextMode = 'local_secondary';
          }
        }
        return {
          activeTabId,
          rightPane: restoredRightPane,
          rightPaneMode: nextMode,
          connectionError: null,
        };
      });
      if (tab?.site && tab.connected) {
        void get().refreshPane('right');
      } else if (tab && !tab.site) {
        if (!get().rightPane.currentPath) {
          void get().navigateTo('right', null, true);
        } else {
          void get().refreshPane('right');
        }
      }
    },

    loadBookmarks: async (siteId) => {
      try {
        const list = await sftpApi.listBookmarks(siteId ?? null);
        set({ bookmarks: list });
      } catch (err) {
        console.error('Failed to load bookmarks', err);
      }
    },

    saveBookmarks: async (bookmarks) => {
      const saved = await sftpApi.saveBookmarks(bookmarks);
      set({ bookmarks: saved });
    },

    openModal: (activeModal, pane) =>
      set((s) => {
        const modalPane = pane ?? s.activePane;
        if (activeModal === 'copy' || activeModal === 'move') {
          const srcPane = modalPane === 'left' ? s.leftPane : s.rightPane;
          const oppPane = modalPane === 'left' ? s.rightPane : s.leftPane;
          const direction: TransferDirection =
            s.rightPaneMode === 'remote_sftp'
              ? modalPane === 'left'
                ? 'upload'
                : 'download'
              : 'local_copy';
          return {
            activeModal,
            modalPane,
            copyDialogPreset: {
              sourcePane: modalPane,
              sources: getTargetPathsForPane(srcPane),
              targetDir: oppPane.currentPath,
              isMove: activeModal === 'move',
              direction,
            },
          };
        }
        return {
          activeModal,
          modalPane,
        };
      }),

    openCopyDialogWithPreset: (preset) =>
      set({
        activeModal: preset.isMove ? 'move' : 'copy',
        modalPane: preset.sourcePane,
        copyDialogPreset: preset,
      }),

    closeModal: () => set({ activeModal: 'none', copyDialogPreset: null }),

    setTransferPreset: (transferPreset) => set({ transferPreset }),

    setForegroundBatchId: (foregroundBatchId) => set({ foregroundBatchId }),

    enqueueTransfer: async (request, showForegroundProgress = false) => {
      const batchId = await transferApi.enqueue(request);
      if (showForegroundProgress) {
        set({ foregroundBatchId: batchId });
      } else {
        set({ showQueueDock: true });
      }
      try {
        const snap = await transferApi.getSnapshot();
        set({ transferSnapshot: snap });
      } catch {
        // Event listener updates snapshot anyway
      }
      return batchId;
    },

    addQueueLog: (item) =>
      set((s) => ({
        queueItems: [
          {
            ...item,
            id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: Date.now(),
          },
          ...s.queueItems,
        ].slice(0, 100),
      })),

    clearQueueLogs: () => set({ queueItems: [] }),

    initWorkspace: async () => {
      if (!transferListenerInitialized) {
        transferListenerInitialized = true;
        try {
          const snap = await transferApi.getSnapshot();
          set({ transferSnapshot: snap });
        } catch {
          // Ignore outside Tauri runtime
        }
        try {
          await transferApi.onQueueUpdated((snap) => {
            const prev = get().transferSnapshot;
            set({ transferSnapshot: snap });

            const prevActiveBatches = new Set(
              (prev?.items ?? [])
                .filter((i) => !isTerminalTransferStatus(i.status))
                .map((i) => i.batchId),
            );
            const stillActiveBatches = new Set(
              snap.items
                .filter((i) => !isTerminalTransferStatus(i.status))
                .map((i) => i.batchId),
            );

            let anyBatchFinished = false;
            for (const bid of prevActiveBatches) {
              if (!stillActiveBatches.has(bid)) {
                anyBatchFinished = true;
                const batchItems = snap.items.filter((i) => i.batchId === bid);
                const doneCount = batchItems.filter((i) => i.status === 'completed').length;
                const failCount = batchItems.filter((i) => i.status === 'failed').length;
                const first = batchItems[0];
                if (first) {
                  get().addQueueLog({
                    operation: first.isMove ? 'move' : 'copy',
                    source: `${batchItems.length} file(s) (${first.direction})`,
                    target: first.targetPath,
                    status: failCount > 0 ? 'error' : 'done',
                    detail: `Transferred ${doneCount}/${batchItems.length} file(s)${
                      failCount > 0 ? `, ${failCount} failed` : ''
                    }`,
                  });
                }
              }
            }

            if (anyBatchFinished) {
              void get().refreshPane('left');
              if (get().rightPaneMode !== 'remote_placeholder') {
                void get().refreshPane('right');
              }
            }
          });
        } catch {
          // Ignore outside Tauri runtime
        }
      }

      if (!phase5ListenersInitialized) {
        phase5ListenersInitialized = true;
        try {
          await editorApi.onExternalSynced((ev) => {
            set((s) => ({
              openEditorFiles: s.openEditorFiles.map((d) =>
                d.docId === ev.docId
                  ? {
                      ...d,
                      content: ev.content,
                      size: ev.bytesWritten,
                      modifiedMs: ev.savedAtMs,
                    }
                  : d,
              ),
              editorDrafts: {
                ...s.editorDrafts,
                [ev.docId]: ev.content,
              },
            }));
            get().addQueueLog({
              operation: 'copy',
              source: ev.path,
              target: ev.isRemote ? 'Remote Editor Sync' : 'Local Editor Sync',
              status: ev.status === 'error' ? 'error' : 'done',
              detail: ev.detail,
            });
            if (ev.status !== 'error') {
              if (ev.isRemote && get().rightPaneMode === 'remote_sftp') {
                void get().refreshPane('right');
              } else if (!ev.isRemote) {
                void get().refreshPane('left');
              }
            }
          });
        } catch {
          // Ignore outside Tauri runtime
        }
        try {
          await syncApi.onKeepUpToDate((status) => {
            set({ keepUpToDateActive: status.running });
            const latest = status.logs[0];
            if (latest && (latest.action === 'upload' || latest.action === 'delete' || latest.action === 'error')) {
              get().addQueueLog({
                operation: latest.action === 'delete' ? 'delete' : 'copy',
                source: latest.relativePath,
                target: status.remoteDir || 'Keep Up to Date',
                status: latest.status === 'error' ? 'error' : 'done',
                detail: latest.detail,
              });
              if (get().rightPaneMode !== 'remote_placeholder') {
                void get().refreshPane('right');
              }
            }
          });
        } catch {
          // Ignore outside Tauri runtime
        }
      }

      if (!phase6MenuListenerInitialized) {
        phase6MenuListenerInitialized = true;
        await get().loadPreferences();
        try {
          await onNativeMenuAction((actionId) => {
            const st = get();
            switch (actionId) {
              case 'new_session':
                void import('./useSiteStore').then((m) =>
                  m.useSiteStore.getState().openLoginDialog(),
                );
                break;
              case 'generate_url':
                st.openModal('generate_url', st.activePane);
                break;
              case 'disconnect':
                void st.disconnectActiveSession();
                break;
              case 'mode_commander':
                st.setInterfaceMode('commander');
                break;
              case 'mode_explorer':
                st.setInterfaceMode('explorer');
                break;
              case 'toggle_terminal':
                st.toggleTerminalDrawer();
                break;
              case 'toggle_theme':
                st.toggleTheme();
                break;
              case 'toggle_locale':
                st.toggleLocale();
                break;
              case 'synchronize':
                st.openModal('synchronize', st.activePane);
                break;
              case 'keep_up_to_date':
                st.openModal('keep_up_to_date', st.activePane);
                break;
              case 'find_files':
                st.openModal('find_files', st.activePane);
                break;
              case 'custom_commands':
                st.openModal('custom_commands', st.activePane);
                break;
              case 'preferences':
                st.openModal('preferences', st.activePane);
                break;
              case 'cleanup':
                st.openModal('cleanup', st.activePane);
                break;
            }
          });
        } catch {
          // Ignore outside Tauri runtime
        }
      }

      await get().loadDrives();
      await Promise.all([
        get().navigateTo('left', null, true),
        get().navigateTo('right', null, true),
      ]);
    },

    loadDrives: async () => {
      try {
        const drives = await localFsApi.listDrives();
        set({ drives });
      } catch (err) {
        console.error('Failed to load drives', err);
      }
    },

    navigateTo: async (pane, path, pushHistory = true) => {
      const seq = ++navSeq[pane];
      const currentState = get();
      const current = getPane(currentState, pane);
      const isRemote = isRemoteSftpPane(currentState, pane);

      set((s) =>
        updatePane(s, pane, (p) => ({
          ...p,
          loading: true,
          error: null,
        })),
      );

      try {
        const listing = isRemote
          ? await sftpApi.listDir(currentState.activeTabId, path ?? '~')
          : await localFsApi.listDir(path, current.showHidden);

        if (navSeq[pane] !== seq) return;

        set((s) =>
          updatePane(s, pane, (p) => applyListingToPane(p, listing, pushHistory)),
        );
      } catch (err) {
        if (navSeq[pane] !== seq) return;
        set((s) =>
          updatePane(s, pane, (p) => ({
            ...p,
            loading: false,
            error: String(err),
          })),
        );
      }
    },

    cancelNavigation: (pane) => {
      ++navSeq[pane];
      set((s) =>
        updatePane(s, pane, (p) => ({
          ...p,
          loading: false,
          error: null,
        })),
      );
    },

    refreshPane: async (pane) => {
      const state = get();
      const p = getPane(state, pane);
      const fallback = isRemoteSftpPane(state, pane) ? '~' : null;
      await get().navigateTo(pane, p.currentPath || fallback, false);
    },

    goBack: async (pane) => {
      const p = getPane(get(), pane);
      if (p.historyIndex > 0) {
        const targetIdx = p.historyIndex - 1;
        const targetPath = p.history[targetIdx];
        set((s) => updatePane(s, pane, (prev) => ({ ...prev, historyIndex: targetIdx })));
        await get().navigateTo(pane, targetPath, false);
      }
    },

    goForward: async (pane) => {
      const p = getPane(get(), pane);
      if (p.historyIndex < p.history.length - 1) {
        const targetIdx = p.historyIndex + 1;
        const targetPath = p.history[targetIdx];
        set((s) => updatePane(s, pane, (prev) => ({ ...prev, historyIndex: targetIdx })));
        await get().navigateTo(pane, targetPath, false);
      }
    },

    goUp: async (pane) => {
      const p = getPane(get(), pane);
      if (p.parentPath) {
        await get().navigateTo(pane, p.parentPath, true);
      }
    },

    goRoot: async (pane) => {
      const state = get();
      const p = getPane(state, pane);
      const root = isRemoteSftpPane(state, pane) ? '/' : p.breadcrumbs[0]?.path ?? null;
      await get().navigateTo(pane, root, true);
    },

    goHome: async (pane) => {
      const isRemote = isRemoteSftpPane(get(), pane);
      await get().navigateTo(pane, isRemote ? '~' : null, true);
    },

    toggleShowHidden: async (pane) => {
      const state = get();
      const nextVal = !getPane(state, pane).showHidden;
      set((s) => updatePane(s, pane, (p) => ({ ...p, showHidden: nextVal })));
      if (!isRemoteSftpPane(state, pane)) {
        await get().refreshPane(pane);
      }
    },

    toggleTreeSidebar: (pane) =>
      set((s) => updatePane(s, pane, (p) => ({ ...p, showTree: !p.showTree }))),

    setFilterMask: (pane, filterMask) =>
      set((s) => updatePane(s, pane, (p) => ({ ...p, filterMask: filterMask || '*' }))),

    setSort: (pane, field) =>
      set((s) =>
        updatePane(s, pane, (p) => {
          const sameField = p.sortField === field;
          return {
            ...p,
            sortField: field,
            sortDir: sameField ? (p.sortDir === 'asc' ? 'desc' : 'asc') : 'asc',
          };
        }),
      ),

    setFocusedPath: (pane, focusedPath) =>
      set((s) => updatePane(s, pane, (p) => ({ ...p, focusedPath }))),

    selectSingle: (pane, path) =>
      set((s) =>
        updatePane(s, pane, (p) => ({
          ...p,
          focusedPath: path,
          lastAnchorPath: path,
          selectedPaths: path === '__PARENT__' ? [] : [path],
        })),
      ),

    toggleSelect: (pane, path) =>
      set((s) =>
        updatePane(s, pane, (p) => {
          if (path === '__PARENT__') {
            return { ...p, focusedPath: path };
          }
          const exists = p.selectedPaths.includes(path);
          const selectedPaths = exists
            ? p.selectedPaths.filter((x) => x !== path)
            : [...p.selectedPaths, path];
          return {
            ...p,
            focusedPath: path,
            lastAnchorPath: path,
            selectedPaths,
          };
        }),
      ),

    selectRange: (pane, targetPath) =>
      set((s) =>
        updatePane(s, pane, (p) => {
          const rows = getOrderedRowPaths(p, isRemoteSftpPane(s, pane)).filter(
            (r) => r !== '__PARENT__',
          );
          const anchor =
            p.lastAnchorPath && rows.includes(p.lastAnchorPath) ? p.lastAnchorPath : rows[0];
          if (!anchor || targetPath === '__PARENT__') {
            return { ...p, focusedPath: targetPath };
          }
          const start = rows.indexOf(anchor);
          const end = rows.indexOf(targetPath);
          if (start === -1 || end === -1) return { ...p, focusedPath: targetPath };
          const [lo, hi] = start <= end ? [start, end] : [end, start];
          return {
            ...p,
            focusedPath: targetPath,
            selectedPaths: rows.slice(lo, hi + 1),
          };
        }),
      ),

    selectAll: (pane) =>
      set((s) =>
        updatePane(s, pane, (p) => {
          const rows = getOrderedRowPaths(p, isRemoteSftpPane(s, pane)).filter(
            (r) => r !== '__PARENT__',
          );
          return { ...p, selectedPaths: rows };
        }),
      ),

    clearSelection: (pane) =>
      set((s) => updatePane(s, pane, (p) => ({ ...p, selectedPaths: [] }))),

    invertSelection: (pane) =>
      set((s) =>
        updatePane(s, pane, (p) => {
          const rows = getOrderedRowPaths(p, isRemoteSftpPane(s, pane)).filter(
            (r) => r !== '__PARENT__',
          );
          const current = new Set(p.selectedPaths);
          return {
            ...p,
            selectedPaths: rows.filter((r) => !current.has(r)),
          };
        }),
      ),

    moveFocus: (pane, delta, extendSelection = false) =>
      set((s) =>
        updatePane(s, pane, (p) => {
          const rows = getOrderedRowPaths(p, isRemoteSftpPane(s, pane));
          if (rows.length === 0) return p;
          const idx = p.focusedPath ? rows.indexOf(p.focusedPath) : 0;
          const safeIdx = idx === -1 ? 0 : idx;
          const nextIdx = Math.max(0, Math.min(rows.length - 1, safeIdx + delta));
          const nextPath = rows[nextIdx];

          let selectedPaths = p.selectedPaths;
          if (extendSelection && nextPath !== '__PARENT__') {
            const setSel = new Set(p.selectedPaths);
            setSel.add(nextPath);
            selectedPaths = Array.from(setSel);
          } else if (!extendSelection) {
            selectedPaths = nextPath === '__PARENT__' ? [] : [nextPath];
          }

          return {
            ...p,
            focusedPath: nextPath,
            lastAnchorPath: extendSelection ? p.lastAnchorPath : nextPath,
            selectedPaths,
          };
        }),
      ),

    createDirectory: async (pane, name, octalMode) => {
      const state = get();
      const p = getPane(state, pane);
      const isRemote = isRemoteSftpPane(state, pane);
      const created = isRemote
        ? await sftpApi.createDir(state.activeTabId, p.currentPath, name, octalMode ?? null)
        : await localFsApi.createDir(p.currentPath, name);

      get().addQueueLog({
        operation: 'mkdir',
        source: name,
        target: created,
        status: 'done',
        detail: `Created ${isRemote ? 'remote ' : ''}directory ${name}`,
      });
      await get().refreshPane(pane);
      get().selectSingle(pane, created);
    },

    createFile: async (pane, name) => {
      const state = get();
      const p = getPane(state, pane);
      const isRemote = isRemoteSftpPane(state, pane);
      const created = isRemote
        ? await sftpApi.createFile(state.activeTabId, p.currentPath, name)
        : await localFsApi.createFile(p.currentPath, name);

      get().addQueueLog({
        operation: 'newfile',
        source: name,
        target: created,
        status: 'done',
        detail: `Created ${isRemote ? 'remote ' : ''}file ${name}`,
      });
      await get().refreshPane(pane);
      get().selectSingle(pane, created);
    },

    createSymlink: async (pane, linkName, targetPath, isHardLink) => {
      const state = get();
      const p = getPane(state, pane);
      const created = await sftpApi.createSymlink(
        state.activeTabId,
        p.currentPath,
        linkName,
        targetPath,
        isHardLink,
      );
      get().addQueueLog({
        operation: 'newfile',
        source: targetPath,
        target: created,
        status: 'done',
        detail: `Created ${isHardLink ? 'hard link' : 'symlink'} ${linkName} -> ${targetPath}`,
      });
      await get().refreshPane(pane);
      get().selectSingle(pane, created);
    },

    renameEntry: async (pane, targetPath, newName) => {
      const state = get();
      const isRemote = isRemoteSftpPane(state, pane);
      const renamed = isRemote
        ? await sftpApi.rename(state.activeTabId, targetPath, newName)
        : await localFsApi.rename(targetPath, newName);

      get().addQueueLog({
        operation: 'rename',
        source: targetPath,
        target: renamed,
        status: 'done',
        detail: `Renamed to ${newName}`,
      });
      await get().refreshPane(pane);
      get().selectSingle(pane, renamed);
    },

    deleteSelected: async (pane, useTrash) => {
      const state = get();
      const p = getPane(state, pane);
      const targets = getTargetPathsForPane(p);
      if (targets.length === 0) return;

      const isRemote = isRemoteSftpPane(state, pane);
      const count = isRemote
        ? await sftpApi.delete(state.activeTabId, targets)
        : await localFsApi.delete(targets, useTrash);

      get().addQueueLog({
        operation: 'delete',
        source: `${count} item(s)`,
        target: isRemote ? 'Remote Delete' : useTrash ? 'Recycle Bin' : 'Permanent',
        status: 'done',
        detail: `Deleted ${count} ${isRemote ? 'remote ' : ''}item(s)`,
      });
      await get().refreshPane(pane);
    },

    copyOrMoveSelected: async (sourcePane, targetDir, isMove) => {
      const state = get();
      const p = getPane(state, sourcePane);
      const targets = getTargetPathsForPane(p);
      if (targets.length === 0) return;

      const direction: TransferDirection =
        state.rightPaneMode === 'remote_sftp'
          ? sourcePane === 'left'
            ? 'upload'
            : 'download'
          : 'local_copy';

      const options = buildDefaultTransferOptions(
        direction,
        direction === 'local_copy' ? null : state.activeTabId,
        isMove,
        state.transferPreset,
      );
      await get().enqueueTransfer(
        {
          sources: targets,
          targetDir,
          options,
        },
        true,
      );
    },

    runCommandInput: (cmd) => {
      const trimmed = cmd.trim();
      if (!trimmed) return;
      set((s) => ({
        commandHistory: [trimmed, ...s.commandHistory.filter((c) => c !== trimmed)].slice(0, 30),
      }));
      const state = get();
      const active = state.activePane;
      if (trimmed.toLowerCase().startsWith('cd ')) {
        const dest = trimmed.slice(3).trim();
        void get().navigateTo(active, dest, true);
        return;
      }
      const isRemote = isRemoteSftpPane(state, active);
      const cwd = getPane(state, active).currentPath || null;
      get().appendTerminalConsole(`$ ${trimmed}`);
      set({ showTerminalDrawer: true });

      void (async () => {
        try {
          const res = isRemote
            ? await shellApi.execRemote({ sessionId: state.activeTabId, command: trimmed, cwd })
            : await shellApi.execLocal(trimmed, cwd);
          if (res.stdout.trim()) get().appendTerminalConsole(res.stdout.trimEnd());
          if (res.stderr.trim()) get().appendTerminalConsole(`[stderr] ${res.stderr.trimEnd()}`);
          get().appendTerminalConsole(`[exit ${res.exitCode} in ${res.durationMs}ms]`);
        } catch (err) {
          get().appendTerminalConsole(`[error] ${String(err)}`);
        }
      })();
    },

    openFileInEditor: async (pane, explicitPath) => {
      const state = get();
      const p = getPane(state, pane);
      const targetPath = explicitPath ?? getTargetPathsForPane(p)[0];
      if (!targetPath) return;

      const entry = p.entries.find((e) => e.path === targetPath);
      if (entry && (entry.fileType === 'dir' || entry.fileType === 'symlink_dir')) {
        await get().navigateTo(pane, entry.path, true);
        return;
      }

      const isRemote = isRemoteSftpPane(state, pane);
      try {
        const doc = await editorApi.openFile({
          pane,
          sessionId: isRemote ? state.activeTabId : null,
          path: targetPath,
          isRemote,
        });
        set((s) => {
          const exists = s.openEditorFiles.some((d) => d.docId === doc.docId);
          return {
            openEditorFiles: exists
              ? s.openEditorFiles.map((d) => (d.docId === doc.docId ? doc : d))
              : [...s.openEditorFiles, doc],
            editorDrafts: {
              ...s.editorDrafts,
              [doc.docId]: doc.content,
            },
            activeEditorDocId: doc.docId,
            isEditorModalOpen: true,
          };
        });
      } catch (err) {
        get().addQueueLog({
          operation: 'copy',
          source: targetPath,
          target: 'Built-in Editor',
          status: 'error',
          detail: String(err),
        });
      }
    },

    setActiveEditorDocId: (activeEditorDocId) => set({ activeEditorDocId }),

    updateEditorDraft: (docId, content) =>
      set((s) => ({
        editorDrafts: { ...s.editorDrafts, [docId]: content },
      })),

    updateEditorDocMeta: (doc, resetDraft = false) =>
      set((s) => ({
        openEditorFiles: s.openEditorFiles.map((d) => (d.docId === doc.docId ? doc : d)),
        editorDrafts: resetDraft
          ? { ...s.editorDrafts, [doc.docId]: doc.content }
          : s.editorDrafts,
      })),

    closeEditorDoc: async (docId) => {
      try {
        await editorApi.closeFile(docId);
      } catch {
        // Ignore already closed docs
      }
      set((s) => {
        const remaining = s.openEditorFiles.filter((d) => d.docId !== docId);
        const nextDrafts = { ...s.editorDrafts };
        delete nextDrafts[docId];
        const nextActive =
          s.activeEditorDocId === docId
            ? remaining[remaining.length - 1]?.docId ?? null
            : s.activeEditorDocId;
        return {
          openEditorFiles: remaining,
          editorDrafts: nextDrafts,
          activeEditorDocId: nextActive,
          isEditorModalOpen: remaining.length > 0 ? s.isEditorModalOpen : false,
        };
      });
    },

    closeEditorModal: () => set({ isEditorModalOpen: false }),

    toggleTerminalDrawer: (open) =>
      set((s) => ({
        showTerminalDrawer: typeof open === 'boolean' ? open : !s.showTerminalDrawer,
      })),

    appendTerminalConsole: (line) =>
      set((s) => ({
        terminalConsoleLogs: [...s.terminalConsoleLogs, line].slice(-400),
      })),

    clearTerminalConsole: () => set({ terminalConsoleLogs: [] }),

    setKeepUpToDateActive: (keepUpToDateActive) => set({ keepUpToDateActive }),
  };
});

export function getTargetPathsForPane(pane: PaneState): string[] {
  if (pane.selectedPaths.length > 0) {
    return pane.selectedPaths.filter((x) => x !== '__PARENT__');
  }
  if (pane.focusedPath && pane.focusedPath !== '__PARENT__') {
    return [pane.focusedPath];
  }
  return [];
}

export function getTargetEntriesForPane(pane: PaneState): FileEntry[] {
  const paths = new Set(getTargetPathsForPane(pane));
  return pane.entries.filter((e) => paths.has(e.path));
}
