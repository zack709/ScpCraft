import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { SiteConfig } from '../types/site';
import type { LocaleCode } from '../i18n';

export interface AppPreferences {
  language: LocaleCode | string;
  theme: 'dark' | 'light' | string;
  interfaceMode: 'commander' | 'explorer' | string;
  showHiddenFiles: boolean;
  confirmOverwriting: boolean;
  confirmDeleting: boolean;
  confirmClosingSession: boolean;
  maxConcurrentTransfers: number;
  defaultSpeedLimitKbps: number;
  useFilepartResume: boolean;
  externalEditorCommand: string;
  doubleClickAction: 'edit' | 'open' | 'properties' | string;
  rememberSessionTabs: boolean;
}

export interface CleanupDataItem {
  id: string;
  label: string;
  description: string;
  location: string;
  exists: boolean;
  sizeBytes: number;
  itemCount: number;
  checkedByDefault: boolean;
}

export interface GenerateUrlRequest {
  site: SiteConfig;
  includeUsername: boolean;
  includePassword: boolean;
  includeHostKey: boolean;
  includeRemoteDir: boolean;
  winscpSpecific: boolean;
  saveExtension: boolean;
  rawSettings: boolean;
  hostKeyFingerprint: string | null;
}

export interface GenerateUrlBundle {
  url: string;
  winscpScript: string;
  batchScript: string;
  cliCommand: string;
  powershellScript: string;
  csharpCode: string;
  powershellSdkCode: string;
  rustCode: string;
}

export const preferencesApi = {
  get: () => invoke<AppPreferences>('app_preferences_get'),
  save: (preferences: AppPreferences) =>
    invoke<AppPreferences>('app_preferences_save', { preferences }),
};

export const cleanupApi = {
  inspect: () => invoke<CleanupDataItem[]>('app_cleanup_inspect'),
  execute: (selectedIds: string[]) =>
    invoke<number>('app_cleanup_execute', { selectedIds }),
};

export const urlGeneratorApi = {
  generateBundle: (request: GenerateUrlRequest) =>
    invoke<GenerateUrlBundle>('site_generate_url_bundle', { request }),
};

export function onNativeMenuAction(cb: (actionId: string) => void): Promise<UnlistenFn> {
  return listen<string>('menu://action', (ev) => cb(ev.payload));
}
