import { create } from 'zustand';
import { siteApi } from '../services/siteApi';
import {
  createEmptySiteConfig,
  getDefaultPort,
  type FtpsMode,
  type SiteConfig,
  type SiteProtocol,
  type SiteSearchMode,
} from '../types/site';
import { useWorkspaceStore } from './useWorkspaceStore';

export type TreeNodeSelection =
  | { kind: 'newSite' }
  | { kind: 'folder'; folder: string }
  | { kind: 'site'; siteId: string };

interface SiteStore {
  initialized: boolean;
  loading: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;

  isLoginDialogOpen: boolean;
  isAdvancedDialogOpen: boolean;

  sites: SiteConfig[];
  folders: string[];
  showLoginOnStartup: boolean;

  selection: TreeNodeSelection;
  expandedFolders: string[];
  searchQuery: string;
  searchMode: SiteSearchMode;

  isEditingSavedSite: boolean;
  draftSite: SiteConfig;
  draftPassword: string;
  draftPassphrase: string;
  draftTunnelPassword: string;

  initSites: () => Promise<void>;
  openLoginDialog: () => void;
  closeLoginDialog: () => void;
  openAdvancedDialog: () => void;
  closeAdvancedDialog: () => void;
  clearNotice: () => void;

  setSearchQuery: (q: string) => void;
  setSearchMode: (mode: SiteSearchMode) => void;
  toggleFolderExpanded: (folder: string) => void;

  selectNewSite: () => void;
  selectFolder: (folder: string) => void;
  selectSite: (siteId: string, startEditing?: boolean) => Promise<void>;
  beginEditSelected: () => void;
  cancelEditSelected: () => Promise<void>;

  updateDraft: (updater: (prev: SiteConfig) => SiteConfig) => void;
  setProtocol: (protocol: SiteProtocol) => void;
  setFtpsMode: (mode: FtpsMode) => void;
  setDraftPassword: (pwd: string) => void;
  setDraftPassphrase: (phrase: string) => void;
  setDraftTunnelPassword: (tpwd: string) => void;

  saveDraft: (options?: { nameOverride?: string; folderOverride?: string | null; saveAsNew?: boolean }) => Promise<void>;
  deleteSelectedSite: () => Promise<void>;
  renameSelectedSite: (newName: string) => Promise<void>;
  cloneSelectedSite: () => Promise<void>;
  createFolder: (folderName: string) => Promise<void>;
  deleteSelectedFolder: () => Promise<void>;
  setShowLoginOnStartup: (show: boolean) => Promise<void>;

  importFromYamlText: (yamlText: string) => Promise<number>;
  exportToYamlText: () => Promise<string>;
  pasteSessionUrl: (url: string) => Promise<void>;
  generateSessionUrl: (includePassword: boolean) => Promise<{ url: string; cliCommand: string }>;
  loginWithCurrent: () => Promise<void>;
}

function buildDefaultSiteName(site: SiteConfig): string {
  if (site.name.trim()) return site.name.trim();
  if (site.userName.trim() && site.hostName.trim()) {
    return `${site.userName.trim()}@${site.hostName.trim()}`;
  }
  return site.hostName.trim() || 'New Site';
}

export const useSiteStore = create<SiteStore>((set, get) => ({
  initialized: false,
  loading: false,
  busy: false,
  error: null,
  notice: null,

  isLoginDialogOpen: false,
  isAdvancedDialogOpen: false,

  sites: [],
  folders: [],
  showLoginOnStartup: true,

  selection: { kind: 'newSite' },
  expandedFolders: [],
  searchQuery: '',
  searchMode: 'substring',

  isEditingSavedSite: true,
  draftSite: createEmptySiteConfig(),
  draftPassword: '',
  draftPassphrase: '',
  draftTunnelPassword: '',

  initSites: async () => {
    set({ loading: true, error: null });
    try {
      const repo = await siteApi.listSites();
      const firstSite = repo.sites[0];
      const nextSelection: TreeNodeSelection = firstSite
        ? { kind: 'site', siteId: firstSite.id }
        : { kind: 'newSite' };

      set({
        initialized: true,
        loading: false,
        sites: repo.sites,
        folders: repo.folders,
        showLoginOnStartup: repo.showLoginOnStartup,
        expandedFolders: repo.folders,
        isLoginDialogOpen: repo.showLoginOnStartup,
        selection: nextSelection,
        isEditingSavedSite: !firstSite,
        draftSite: firstSite ? structuredClone(firstSite) : createEmptySiteConfig(),
      });

      if (firstSite) {
        void get().selectSite(firstSite.id, false);
      }
    } catch (err) {
      set({
        initialized: true,
        loading: false,
        error: String(err),
      });
    }
  },

  openLoginDialog: () => {
    if (!get().initialized) {
      void get().initSites().then(() => set({ isLoginDialogOpen: true }));
    } else {
      set({ isLoginDialogOpen: true, error: null });
    }
  },

  closeLoginDialog: () => set({ isLoginDialogOpen: false, isAdvancedDialogOpen: false }),
  openAdvancedDialog: () => set({ isAdvancedDialogOpen: true }),
  closeAdvancedDialog: () => set({ isAdvancedDialogOpen: false }),
  clearNotice: () => set({ notice: null, error: null }),

  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSearchMode: (searchMode) => set({ searchMode }),
  toggleFolderExpanded: (folder) =>
    set((s) => ({
      expandedFolders: s.expandedFolders.includes(folder)
        ? s.expandedFolders.filter((f) => f !== folder)
        : [...s.expandedFolders, folder],
    })),

  selectNewSite: () =>
    set({
      selection: { kind: 'newSite' },
      isEditingSavedSite: true,
      draftSite: createEmptySiteConfig(),
      draftPassword: '',
      draftPassphrase: '',
      draftTunnelPassword: '',
      error: null,
    }),

  selectFolder: (folder) =>
    set((s) => ({
      selection: { kind: 'folder', folder },
      isEditingSavedSite: false,
      expandedFolders: s.expandedFolders.includes(folder)
        ? s.expandedFolders
        : [...s.expandedFolders, folder],
      error: null,
    })),

  selectSite: async (siteId, startEditing = false) => {
    const found = get().sites.find((x) => x.id === siteId);
    if (!found) return;
    set({
      selection: { kind: 'site', siteId },
      isEditingSavedSite: startEditing,
      draftSite: structuredClone(found),
      draftPassword: '',
      draftPassphrase: '',
      draftTunnelPassword: '',
      error: null,
    });
    try {
      const secret = await siteApi.getSecret(siteId);
      const currentSel = get().selection;
      if (currentSel.kind === 'site' && currentSel.siteId === siteId) {
        set({
          draftPassword: secret.password ?? '',
          draftPassphrase: secret.passphrase ?? '',
          draftTunnelPassword: secret.tunnelPassword ?? '',
        });
      }
    } catch {
      // Keep masked placeholder state if keyring lookup fails
    }
  },

  beginEditSelected: () => {
    if (get().selection.kind === 'site') {
      set({ isEditingSavedSite: true, error: null });
    }
  },

  cancelEditSelected: async () => {
    const sel = get().selection;
    if (sel.kind === 'site') {
      await get().selectSite(sel.siteId, false);
    } else {
      get().selectNewSite();
    }
  },

  updateDraft: (updater) =>
    set((s) => ({
      draftSite: updater(s.draftSite),
    })),

  setProtocol: (protocol) =>
    set((s) => {
      const prevDefault = getDefaultPort(s.draftSite.protocol, s.draftSite.ftpsMode);
      const nextFtps: FtpsMode =
        protocol === 'ftp' || protocol === 'webdav' || protocol === 's3'
          ? s.draftSite.ftpsMode
          : 'none';
      const nextPort =
        s.draftSite.portNumber === prevDefault || s.draftSite.portNumber === 0
          ? getDefaultPort(protocol, nextFtps)
          : s.draftSite.portNumber;
      return {
        draftSite: {
          ...s.draftSite,
          protocol,
          ftpsMode: nextFtps,
          portNumber: nextPort,
        },
      };
    }),

  setFtpsMode: (ftpsMode) =>
    set((s) => {
      const prevDefault = getDefaultPort(s.draftSite.protocol, s.draftSite.ftpsMode);
      const nextPort =
        s.draftSite.portNumber === prevDefault || s.draftSite.portNumber === 0
          ? getDefaultPort(s.draftSite.protocol, ftpsMode)
          : s.draftSite.portNumber;
      return {
        draftSite: {
          ...s.draftSite,
          ftpsMode,
          portNumber: nextPort,
        },
      };
    }),

  setDraftPassword: (draftPassword) => set({ draftPassword }),
  setDraftPassphrase: (draftPassphrase) => set({ draftPassphrase }),
  setDraftTunnelPassword: (draftTunnelPassword) => set({ draftTunnelPassword }),

  saveDraft: async (options) => {
    const state = get();
    set({ busy: true, error: null });
    try {
      const saveAsNew = options?.saveAsNew ?? state.selection.kind === 'newSite';
      const siteToSave: SiteConfig = {
        ...state.draftSite,
        name: options?.nameOverride?.trim() || buildDefaultSiteName(state.draftSite),
        folder:
          options && 'folderOverride' in options
            ? (options.folderOverride ?? null)
            : state.draftSite.folder,
      };
      const repo = await siteApi.saveSite(
        siteToSave,
        {
          password: state.draftPassword,
          passphrase: state.draftPassphrase,
          tunnelPassword: state.draftTunnelPassword || null,
        },
        saveAsNew
      );

      const savedMatch =
        repo.sites.find(
          (x) =>
            (x.id === siteToSave.id && !saveAsNew) ||
            (x.name === siteToSave.name && x.folder === siteToSave.folder)
        ) ?? repo.sites[repo.sites.length - 1];

      set({
        busy: false,
        sites: repo.sites,
        folders: repo.folders,
        showLoginOnStartup: repo.showLoginOnStartup,
        expandedFolders: savedMatch?.folder
          ? Array.from(new Set([...state.expandedFolders, savedMatch.folder]))
          : state.expandedFolders,
        selection: savedMatch ? { kind: 'site', siteId: savedMatch.id } : { kind: 'newSite' },
        isEditingSavedSite: false,
        draftSite: savedMatch ? structuredClone(savedMatch) : createEmptySiteConfig(),
        notice: `Saved site "${savedMatch?.name ?? siteToSave.name}" (credentials secured in OS Keyring).`,
      });
    } catch (err) {
      set({ busy: false, error: String(err) });
    }
  },

  deleteSelectedSite: async () => {
    const sel = get().selection;
    if (sel.kind !== 'site') return;
    set({ busy: true, error: null });
    try {
      const repo = await siteApi.deleteSite(sel.siteId);
      set({
        busy: false,
        sites: repo.sites,
        folders: repo.folders,
        selection: { kind: 'newSite' },
        isEditingSavedSite: true,
        draftSite: createEmptySiteConfig(),
        draftPassword: '',
        draftPassphrase: '',
        draftTunnelPassword: '',
        notice: 'Deleted selected site and purged OS Keyring credentials.',
      });
    } catch (err) {
      set({ busy: false, error: String(err) });
    }
  },

  renameSelectedSite: async (newName) => {
    const sel = get().selection;
    if (sel.kind !== 'site') return;
    set({ busy: true, error: null });
    try {
      const repo = await siteApi.renameSite(sel.siteId, newName);
      const updated = repo.sites.find((s) => s.id === sel.siteId);
      set({
        busy: false,
        sites: repo.sites,
        folders: repo.folders,
        draftSite: updated ? structuredClone(updated) : get().draftSite,
        notice: `Renamed site to "${newName}".`,
      });
    } catch (err) {
      set({ busy: false, error: String(err) });
    }
  },

  cloneSelectedSite: async () => {
    const sel = get().selection;
    if (sel.kind !== 'site') return;
    set({ busy: true, error: null });
    try {
      const prevIds = new Set(get().sites.map((s) => s.id));
      const repo = await siteApi.cloneSite(sel.siteId);
      const created = repo.sites.find((s) => !prevIds.has(s.id));
      set({
        busy: false,
        sites: repo.sites,
        folders: repo.folders,
        notice: created ? `Cloned site as "${created.name}".` : 'Cloned site.',
      });
      if (created) {
        await get().selectSite(created.id, true);
      }
    } catch (err) {
      set({ busy: false, error: String(err) });
    }
  },

  createFolder: async (folderName) => {
    set({ busy: true, error: null });
    try {
      const repo = await siteApi.createFolder(folderName);
      const trimmed = folderName.trim().replace(/^\/+|\/+$/g, '');
      set((s) => ({
        busy: false,
        sites: repo.sites,
        folders: repo.folders,
        expandedFolders: Array.from(new Set([...s.expandedFolders, trimmed])),
        selection: { kind: 'folder', folder: trimmed },
        notice: `Created folder "${trimmed}".`,
      }));
    } catch (err) {
      set({ busy: false, error: String(err) });
    }
  },

  deleteSelectedFolder: async () => {
    const sel = get().selection;
    if (sel.kind !== 'folder') return;
    set({ busy: true, error: null });
    try {
      const repo = await siteApi.deleteFolder(sel.folder);
      set({
        busy: false,
        sites: repo.sites,
        folders: repo.folders,
        selection: { kind: 'newSite' },
        isEditingSavedSite: true,
        draftSite: createEmptySiteConfig(),
        notice: `Deleted folder "${sel.folder}" (child sites moved to root).`,
      });
    } catch (err) {
      set({ busy: false, error: String(err) });
    }
  },

  setShowLoginOnStartup: async (show) => {
    set({ showLoginOnStartup: show });
    try {
      const repo = await siteApi.setShowOnStartup(show);
      set({ showLoginOnStartup: repo.showLoginOnStartup });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  importFromYamlText: async (yamlText) => {
    set({ busy: true, error: null });
    try {
      const res = await siteApi.importYaml(yamlText);
      set({
        busy: false,
        sites: res.repository.sites,
        folders: res.repository.folders,
        expandedFolders: res.repository.folders,
        notice: `Imported ${res.importedCount} site(s) from YAML (passwords excluded).`,
      });
      if (res.repository.sites[0]) {
        await get().selectSite(res.repository.sites[0].id, false);
      }
      return res.importedCount;
    } catch (err) {
      set({ busy: false, error: String(err) });
      return 0;
    }
  },

  exportToYamlText: async () => {
    return siteApi.exportYaml();
  },

  pasteSessionUrl: async (url) => {
    set({ busy: true, error: null });
    try {
      const parsed = await siteApi.parseSessionUrl(url);
      set({
        busy: false,
        selection: { kind: 'newSite' },
        isEditingSavedSite: true,
        draftSite: parsed.site,
        draftPassword: parsed.password ?? '',
        draftPassphrase: '',
        draftTunnelPassword: '',
        notice: `Loaded session fields from URL (${parsed.site.protocol.toUpperCase()}://${parsed.site.hostName}).`,
      });
    } catch (err) {
      set({ busy: false, error: String(err) });
    }
  },

  generateSessionUrl: async (includePassword) => {
    return siteApi.generateSessionUrl(get().draftSite, includePassword);
  },

  loginWithCurrent: async () => {
    const {
      draftSite: site,
      draftPassword,
      draftPassphrase,
      draftTunnelPassword,
    } = get();
    if (!site.hostName.trim()) {
      set({ error: 'Please enter a hostname or select a saved site before logging in.' });
      return;
    }
    set({ isLoginDialogOpen: false, isAdvancedDialogOpen: false, error: null });
    await useWorkspaceStore.getState().connectSessionWithSite(
      {
        ...site,
        name: buildDefaultSiteName(site),
      },
      {
        password: draftPassword || undefined,
        passphrase: draftPassphrase || undefined,
        tunnelPassword: draftTunnelPassword || undefined,
      },
    );
  },
}));
