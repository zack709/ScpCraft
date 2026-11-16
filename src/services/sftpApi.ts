import { invoke } from '@tauri-apps/api/core';
import type { DirectoryListing, FileEntry } from '../types/fs';
import type { SiteConfig } from '../types/site';

export interface KeyInspection {
  path: string;
  kind: string;
  encrypted: boolean;
  algorithm: string | null;
  comment: string | null;
}

export interface HostKeyPromptInfo {
  status: 'unknown' | 'mismatch';
  isTunnel: boolean;
  host: string;
  port: number;
  keyAlgorithm: string;
  fingerprintSha256: string;
  fingerprintSha512: string;
  publicKeyOpenssh: string;
  knownHostsPath: string;
  mismatchLine: number | null;
}

export interface AuthPromptItem {
  id: string;
  prompt: string;
  echo: boolean;
}

export interface AuthChallengeInfo {
  challengeId: string;
  sessionId: string;
  siteId: string;
  host: string;
  port: number;
  userName: string;
  authKind: 'password' | 'passphrase' | 'keyboard_interactive';
  title: string;
  instructions: string;
  keyPath: string | null;
  prompts: AuthPromptItem[];
  logLines: string[];
  errorMessage: string | null;
}

export interface SftpConnectedInfo {
  sessionId: string;
  homePath: string;
  initialPath: string;
  initialListing: DirectoryListing;
  authMethodUsed: string;
  serverBanner: string;
}

export type SftpConnectOutcome =
  | { outcome: 'connected'; payload: SftpConnectedInfo }
  | { outcome: 'host_key_prompt'; payload: HostKeyPromptInfo }
  | { outcome: 'auth_prompt'; payload: AuthChallengeInfo };

export interface SftpConnectRequest {
  sessionId: string;
  site: SiteConfig;
  password: string | null;
  passphrase: string | null;
  tunnelPassword: string | null;
}

export interface ChecksumEntry {
  algorithm: string;
  value: string;
}

export interface RemoteFileProperties {
  entry: FileEntry;
  uid: number | null;
  gid: number | null;
  ownerName: string | null;
  groupName: string | null;
  itemCount: number;
  calculatedSize: number;
  checksums: ChecksumEntry[];
}

export interface LocationProfile {
  id: string;
  name: string;
  localPath: string;
  remotePath: string;
  siteId: string | null;
}

export const sftpApi = {
  connect(request: SftpConnectRequest): Promise<SftpConnectOutcome> {
    return invoke<SftpConnectOutcome>('sftp_connect', { request });
  },

  respondAuth(
    challengeId: string,
    responses: string[],
    saveSecret: boolean,
  ): Promise<SftpConnectOutcome> {
    return invoke<SftpConnectOutcome>('sftp_connect_respond', {
      challengeId,
      responses,
      saveSecret,
    });
  },

  cancelAuth(challengeId: string): Promise<void> {
    return invoke<void>('sftp_connect_cancel', { challengeId });
  },

  trustHostKey(
    host: string,
    port: number,
    publicKeyOpenssh: string,
    savePermanently: boolean,
  ): Promise<void> {
    return invoke<void>('sftp_trust_host_key', {
      host,
      port,
      publicKeyOpenssh,
      savePermanently,
    });
  },

  disconnect(sessionId: string): Promise<void> {
    return invoke<void>('sftp_disconnect', { sessionId });
  },

  sessionStatus(sessionId: string): Promise<boolean> {
    return invoke<boolean>('sftp_session_status', { sessionId });
  },

  inspectKeyFile(path: string): Promise<KeyInspection> {
    return invoke<KeyInspection>('sftp_inspect_key_file', { path });
  },

  listDir(sessionId: string, path: string): Promise<DirectoryListing> {
    return invoke<DirectoryListing>('sftp_list_dir', { sessionId, path });
  },

  createDir(
    sessionId: string,
    parentPath: string,
    name: string,
    octalMode: string | null,
  ): Promise<string> {
    return invoke<string>('sftp_create_dir', {
      sessionId,
      parentPath,
      name,
      octalMode,
    });
  },

  createFile(
    sessionId: string,
    parentPath: string,
    name: string,
  ): Promise<string> {
    return invoke<string>('sftp_create_file', {
      sessionId,
      parentPath,
      name,
    });
  },

  rename(
    sessionId: string,
    path: string,
    newName: string,
  ): Promise<string> {
    return invoke<string>('sftp_rename', { sessionId, path, newName });
  },

  delete(sessionId: string, paths: string[]): Promise<number> {
    return invoke<number>('sftp_delete', { sessionId, paths });
  },

  createSymlink(
    sessionId: string,
    currentDir: string,
    linkName: string,
    targetPath: string,
    isHardLink: boolean,
  ): Promise<string> {
    return invoke<string>('sftp_create_symlink', {
      sessionId,
      currentDir,
      linkName,
      targetPath,
      isHardLink,
    });
  },

  getProperties(
    sessionId: string,
    path: string,
    calculateSize: boolean,
    checksumAlg: string | null,
  ): Promise<RemoteFileProperties> {
    return invoke<RemoteFileProperties>('sftp_get_properties', {
      sessionId,
      path,
      calculateSize,
      checksumAlg,
    });
  },

  setPermissions(
    sessionId: string,
    paths: string[],
    octalMode: string | null,
    ownerUid: number | null,
    groupGid: number | null,
    addXToDirs: boolean,
    recursive: boolean,
  ): Promise<number> {
    return invoke<number>('sftp_set_permissions', {
      sessionId,
      paths,
      octalMode,
      ownerUid,
      groupGid,
      addXToDirs,
      recursive,
    });
  },

  listBookmarks(siteId: string | null): Promise<LocationProfile[]> {
    return invoke<LocationProfile[]>('sftp_list_bookmarks', { siteId });
  },

  saveBookmarks(bookmarks: LocationProfile[]): Promise<LocationProfile[]> {
    return invoke<LocationProfile[]>('sftp_save_bookmarks', { bookmarks });
  },
};
