import { invoke } from '@tauri-apps/api/core';
import type { DirectoryListing, DriveInfo, FileProperties } from '../types/fs';

export const localFsApi = {
  listDrives(): Promise<DriveInfo[]> {
    return invoke<DriveInfo[]>('local_list_drives');
  },

  listDir(path: string | null, showHidden: boolean): Promise<DirectoryListing> {
    return invoke<DirectoryListing>('local_list_dir', { path, showHidden });
  },

  createDir(parentPath: string, name: string): Promise<string> {
    return invoke<string>('local_create_dir', { parentPath, name });
  },

  createFile(parentPath: string, name: string): Promise<string> {
    return invoke<string>('local_create_file', { parentPath, name });
  },

  rename(path: string, newName: string): Promise<string> {
    return invoke<string>('local_rename', { path, newName });
  },

  delete(paths: string[], useTrash: boolean): Promise<number> {
    return invoke<number>('local_delete', { paths, useTrash });
  },

  copyOrMove(sources: string[], targetDir: string, isMove: boolean): Promise<number> {
    return invoke<number>('local_copy_or_move', { sources, targetDir, isMove });
  },

  getProperties(path: string, calculateDirSize: boolean): Promise<FileProperties> {
    return invoke<FileProperties>('local_get_properties', { path, calculateDirSize });
  },
};
