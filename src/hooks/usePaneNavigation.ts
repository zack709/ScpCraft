import { useEffect } from 'react';
import { getTargetPathsForPane, useWorkspaceStore } from '../stores/useWorkspaceStore';
import { useSiteStore } from '../stores/useSiteStore';
import { isDirEntry } from '../utils/formatters';

export function usePaneNavigation() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const siteState = useSiteStore.getState();
      if (siteState.isAdvancedDialogOpen) {
        if (e.key === 'Escape') siteState.closeAdvancedDialog();
        return;
      }
      if (siteState.isLoginDialogOpen) {
        if (e.key === 'Escape') siteState.closeLoginDialog();
        return;
      }

      const store = useWorkspaceStore.getState();
      if (store.isEditorModalOpen) return;
      if (store.activeModal !== 'none') {
        if (e.key === 'Escape') store.closeModal();
        return;
      }

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        return;
      }

      const paneId = store.activePane;
      const pane = paneId === 'left' ? store.leftPane : store.rightPane;

      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === 'F7') {
        e.preventDefault();
        store.openModal('find_files', paneId);
        return;
      }

      if (e.key === 'F4' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        void store.openFileInEditor(paneId);
        return;
      }

      if (e.key === 'Tab') {
        if (store.interfaceMode === 'commander') {
          e.preventDefault();
          store.setActivePane(paneId === 'left' ? 'right' : 'left');
        }
        return;
      }

      // Ctrl / Cmd combinations
      if (e.ctrlKey || e.metaKey) {
        if (e.shiftKey && e.key.toLowerCase() === 'u') {
          e.preventDefault();
          store.openModal('generate_url', paneId);
          return;
        }
        if (!e.shiftKey && !e.altKey && e.key === ',') {
          e.preventDefault();
          store.openModal('preferences', paneId);
          return;
        }
        if (e.altKey && e.key.toLowerCase() === 'h') {
          e.preventDefault();
          void store.toggleShowHidden(paneId);
          return;
        }
        switch (e.key.toLowerCase()) {
          case 'a':
            e.preventDefault();
            store.selectAll(paneId);
            return;
          case 'r':
            e.preventDefault();
            void store.refreshPane(paneId);
            return;
          case 'o':
            e.preventDefault();
            store.openModal('opendir', paneId);
            return;
          case 'f':
            e.preventDefault();
            store.openModal('filter', paneId);
            return;
          case 's':
            e.preventDefault();
            store.openModal('synchronize', paneId);
            return;
          case 't':
            e.preventDefault();
            store.toggleTerminalDrawer();
            return;
          case 'u':
            e.preventDefault();
            store.swapPanes();
            return;
          case 'n':
            e.preventDefault();
            useSiteStore.getState().openLoginDialog();
            return;
        }
        if (e.key === 'F3') {
          e.preventDefault();
          store.setSort(paneId, 'name');
          return;
        }
        if (e.key === 'F4') {
          e.preventDefault();
          store.setSort(paneId, 'ext');
          return;
        }
        if (e.key === 'F5') {
          e.preventDefault();
          store.setSort(paneId, 'modified');
          return;
        }
        if (e.key === 'F6') {
          e.preventDefault();
          store.setSort(paneId, 'size');
          return;
        }
        if (e.key === 'F7') {
          e.preventDefault();
          store.setSort(paneId, 'attr');
          return;
        }
      }

      if (e.shiftKey && e.key === 'F4') {
        e.preventDefault();
        store.openModal('newfile', paneId);
        return;
      }

      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          store.moveFocus(paneId, -1, e.shiftKey);
          break;
        case 'ArrowDown':
          e.preventDefault();
          store.moveFocus(paneId, 1, e.shiftKey);
          break;
        case 'PageUp':
          e.preventDefault();
          store.moveFocus(paneId, -15, e.shiftKey);
          break;
        case 'PageDown':
          e.preventDefault();
          store.moveFocus(paneId, 15, e.shiftKey);
          break;
        case 'Home':
          e.preventDefault();
          store.moveFocus(paneId, -100000, e.shiftKey);
          break;
        case 'End':
          e.preventDefault();
          store.moveFocus(paneId, 100000, e.shiftKey);
          break;
        case ' ':
        case 'Insert':
          if (pane.focusedPath) {
            e.preventDefault();
            store.toggleSelect(paneId, pane.focusedPath);
            if (e.key === 'Insert') store.moveFocus(paneId, 1, false);
          }
          break;
        case 'Enter': {
          if (!pane.focusedPath) break;
          e.preventDefault();
          if (pane.focusedPath === '__PARENT__') {
            void store.goUp(paneId);
          } else {
            const focusedEntry = pane.entries.find((x) => x.path === pane.focusedPath);
            if (focusedEntry && isDirEntry(focusedEntry)) {
              void store.navigateTo(paneId, focusedEntry.path, true);
            } else if (focusedEntry) {
              store.openModal('properties', paneId);
            }
          }
          break;
        }
        case 'Backspace':
          e.preventDefault();
          void store.goUp(paneId);
          break;
        case 'F2':
          if (getTargetPathsForPane(pane).length > 0) {
            e.preventDefault();
            store.openModal('rename', paneId);
          }
          break;
        case 'F5':
          if (getTargetPathsForPane(pane).length > 0) {
            e.preventDefault();
            store.openModal('copy', paneId);
          }
          break;
        case 'F6':
          if (getTargetPathsForPane(pane).length > 0) {
            e.preventDefault();
            store.openModal('move', paneId);
          }
          break;
        case 'F7':
          e.preventDefault();
          store.openModal('mkdir', paneId);
          break;
        case 'F8':
        case 'Delete':
          if (getTargetPathsForPane(pane).length > 0) {
            e.preventDefault();
            store.openModal('delete', paneId);
          }
          break;
        case 'F9':
          if (getTargetPathsForPane(pane).length > 0) {
            e.preventDefault();
            store.openModal('properties', paneId);
          }
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
