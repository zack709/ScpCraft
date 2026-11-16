import { invoke } from '@tauri-apps/api/core';
import type {
  GeneratedSessionUrlResult,
  ParsedSessionUrlResult,
  SiteConfig,
  SiteImportResult,
  SiteRepositoryFile,
  SiteSecretBundle,
} from '../types/site';

const LOCAL_STORAGE_KEY = 'scpcraft.sites.v1';

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function loadFallbackRepo(): SiteRepositoryFile {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw) as SiteRepositoryFile;
    }
  } catch {
    // ignore corrupted local fallback
  }
  return {
    version: 1,
    showLoginOnStartup: true,
    folders: [],
    sites: [],
  };
}

function saveFallbackRepo(repo: SiteRepositoryFile): SiteRepositoryFile {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(repo));
  return repo;
}

export const siteApi = {
  async listSites(): Promise<SiteRepositoryFile> {
    if (isTauriRuntime()) {
      return invoke<SiteRepositoryFile>('site_list');
    }
    return loadFallbackRepo();
  },

  async saveSite(
    site: SiteConfig,
    secrets: SiteSecretBundle,
    saveAsNew: boolean
  ): Promise<SiteRepositoryFile> {
    if (isTauriRuntime()) {
      return invoke<SiteRepositoryFile>('site_save', { site, secrets, saveAsNew });
    }
    const repo = loadFallbackRepo();
    const cleanSite: SiteConfig = {
      ...site,
      id: !site.id || saveAsNew ? `site-${Date.now()}` : site.id,
      hasPassword: Boolean(secrets.password) || (!saveAsNew && site.hasPassword),
      hasPassphrase: Boolean(secrets.passphrase) || (!saveAsNew && site.hasPassphrase),
    };
    const idx = repo.sites.findIndex((s) => s.id === cleanSite.id);
    if (idx >= 0 && !saveAsNew) {
      repo.sites[idx] = cleanSite;
    } else {
      repo.sites.push(cleanSite);
    }
    if (cleanSite.folder && !repo.folders.includes(cleanSite.folder)) {
      repo.folders.push(cleanSite.folder);
    }
    return saveFallbackRepo(repo);
  },

  async deleteSite(siteId: string): Promise<SiteRepositoryFile> {
    if (isTauriRuntime()) {
      return invoke<SiteRepositoryFile>('site_delete', { siteId });
    }
    const repo = loadFallbackRepo();
    repo.sites = repo.sites.filter((s) => s.id !== siteId);
    return saveFallbackRepo(repo);
  },

  async renameSite(siteId: string, newName: string): Promise<SiteRepositoryFile> {
    if (isTauriRuntime()) {
      return invoke<SiteRepositoryFile>('site_rename', { siteId, newName });
    }
    const repo = loadFallbackRepo();
    const target = repo.sites.find((s) => s.id === siteId);
    if (target) target.name = newName;
    return saveFallbackRepo(repo);
  },

  async cloneSite(siteId: string): Promise<SiteRepositoryFile> {
    if (isTauriRuntime()) {
      return invoke<SiteRepositoryFile>('site_clone', { siteId });
    }
    const repo = loadFallbackRepo();
    const source = repo.sites.find((s) => s.id === siteId);
    if (source) {
      repo.sites.push({
        ...structuredClone(source),
        id: `site-${Date.now()}`,
        name: `${source.name} (Copy)`,
      });
    }
    return saveFallbackRepo(repo);
  },

  async createFolder(folderName: string): Promise<SiteRepositoryFile> {
    if (isTauriRuntime()) {
      return invoke<SiteRepositoryFile>('site_create_folder', { folderName });
    }
    const repo = loadFallbackRepo();
    if (!repo.folders.includes(folderName)) {
      repo.folders.push(folderName);
    }
    return saveFallbackRepo(repo);
  },

  async deleteFolder(folderName: string): Promise<SiteRepositoryFile> {
    if (isTauriRuntime()) {
      return invoke<SiteRepositoryFile>('site_delete_folder', { folderName });
    }
    const repo = loadFallbackRepo();
    repo.folders = repo.folders.filter((f) => f !== folderName);
    repo.sites = repo.sites.map((s) => (s.folder === folderName ? { ...s, folder: null } : s));
    return saveFallbackRepo(repo);
  },

  async setShowOnStartup(show: boolean): Promise<SiteRepositoryFile> {
    if (isTauriRuntime()) {
      return invoke<SiteRepositoryFile>('site_set_show_on_startup', { show });
    }
    const repo = loadFallbackRepo();
    repo.showLoginOnStartup = show;
    return saveFallbackRepo(repo);
  },

  async getSecret(siteId: string): Promise<SiteSecretBundle> {
    if (isTauriRuntime()) {
      return invoke<SiteSecretBundle>('site_get_secret', { siteId });
    }
    return { password: null, passphrase: null, tunnelPassword: null };
  },

  async importYaml(yamlContent: string): Promise<SiteImportResult> {
    return invoke<SiteImportResult>('site_import_yaml', { yamlContent });
  },

  async exportYaml(): Promise<string> {
    return invoke<string>('site_export_yaml');
  },

  async parseSessionUrl(url: string): Promise<ParsedSessionUrlResult> {
    return invoke<ParsedSessionUrlResult>('site_parse_session_url', { url });
  },

  async generateSessionUrl(
    site: SiteConfig,
    includePassword: boolean
  ): Promise<GeneratedSessionUrlResult> {
    return invoke<GeneratedSessionUrlResult>('site_generate_session_url', {
      site,
      includePassword,
    });
  },

  async pickPrivateKeyFile(): Promise<string | null> {
    if (!isTauriRuntime()) return null;
    return invoke<string | null>('pick_private_key_file');
  },
};
