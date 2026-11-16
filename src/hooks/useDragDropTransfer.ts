import { createElement, useEffect } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { create } from 'zustand';
import { ArrowRight, Upload } from 'lucide-react';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import type { TransferDirection } from '../services/transferApi';
import type { PaneId } from '../types/fs';

interface InternalDragState {
  active: boolean;
  sourcePane: PaneId;
  sources: string[];
  startX: number;
  startY: number;
  curX: number;
  curY: number;
  dropTargetPane: PaneId | null;
  dropTargetDir: string | null;
}

interface DragDropStore {
  internalDrag: InternalDragState | null;
  osDropHoverPane: PaneId | null;
  setInternalDrag: (drag: InternalDragState | null) => void;
  setOsDropHoverPane: (pane: PaneId | null) => void;
}

export const useDragDropStore = create<DragDropStore>((set) => ({
  internalDrag: null,
  osDropHoverPane: null,
  setInternalDrag: (internalDrag) => set({ internalDrag }),
  setOsDropHoverPane: (osDropHoverPane) => set({ osDropHoverPane }),
}));

function resolveDropTargetAtPoint(
  clientX: number,
  clientY: number,
  sourcePane: PaneId,
): { pane: PaneId | null; dir: string | null } {
  const store = useWorkspaceStore.getState();
  const els = document.elementsFromPoint(clientX, clientY);
  let targetPane: PaneId | null = null;
  let targetRowDir: string | null = null;

  for (const el of els) {
    if (!targetRowDir) {
      const rowDir = el.getAttribute('data-drop-dir');
      if (rowDir) targetRowDir = rowDir;
    }
    const paneAttr = el.getAttribute('data-pane-drop-target');
    if (paneAttr === 'left' || paneAttr === 'right') {
      targetPane = paneAttr;
      break;
    }
  }

  if (!targetPane) return { pane: null, dir: null };
  if (targetPane === 'right' && store.rightPaneMode === 'remote_placeholder') {
    return { pane: null, dir: null };
  }

  // Require either opposite pane or dropping specifically into a subdirectory row
  if (targetPane === sourcePane && !targetRowDir) {
    return { pane: null, dir: null };
  }

  const paneState = targetPane === 'left' ? store.leftPane : store.rightPane;
  const resolvedDir = targetRowDir || paneState.currentPath;
  if (!resolvedDir) return { pane: null, dir: null };

  return { pane: targetPane, dir: resolvedDir };
}

function resolveOsDropPaneAtPosition(x: number, y: number): PaneId | null {
  const candidates = [
    { x, y },
    {
      x: x / (window.devicePixelRatio || 1),
      y: y / (window.devicePixelRatio || 1),
    },
  ];
  const paneEls = document.querySelectorAll<HTMLElement>('[data-pane-drop-target]');
  for (const pt of candidates) {
    for (const el of paneEls) {
      const rect = el.getBoundingClientRect();
      if (
        pt.x >= rect.left &&
        pt.x <= rect.right &&
        pt.y >= rect.top &&
        pt.y <= rect.bottom
      ) {
        const attr = el.getAttribute('data-pane-drop-target');
        if (attr === 'left' || attr === 'right') return attr;
      }
    }
  }
  const active = useWorkspaceStore.getState().activePane;
  return active;
}

export function beginPointerDrag(
  sourcePane: PaneId,
  sources: string[],
  startX: number,
  startY: number,
): void {
  if (sources.length === 0) return;
  useDragDropStore.getState().setInternalDrag({
    active: false,
    sourcePane,
    sources,
    startX,
    startY,
    curX: startX,
    curY: startY,
    dropTargetPane: null,
    dropTargetDir: null,
  });

  const onMove = (ev: MouseEvent) => {
    const cur = useDragDropStore.getState().internalDrag;
    if (!cur) return;
    const dist = Math.hypot(ev.clientX - cur.startX, ev.clientY - cur.startY);
    const active = cur.active || dist >= 8;
    const hit = active
      ? resolveDropTargetAtPoint(ev.clientX, ev.clientY, cur.sourcePane)
      : { pane: null, dir: null };

    useDragDropStore.getState().setInternalDrag({
      ...cur,
      active,
      curX: ev.clientX,
      curY: ev.clientY,
      dropTargetPane: hit.pane,
      dropTargetDir: hit.dir,
    });
  };

  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);

    const cur = useDragDropStore.getState().internalDrag;
    useDragDropStore.getState().setInternalDrag(null);
    if (!cur || !cur.active || !cur.dropTargetPane || !cur.dropTargetDir) {
      return;
    }

    const ws = useWorkspaceStore.getState();
    let direction: TransferDirection = 'local_copy';
    if (ws.rightPaneMode === 'remote_sftp') {
      if (cur.sourcePane === 'left' && cur.dropTargetPane === 'right') {
        direction = 'upload';
      } else if (cur.sourcePane === 'right' && cur.dropTargetPane === 'left') {
        direction = 'download';
      } else if (cur.sourcePane === 'right' && cur.dropTargetPane === 'right') {
        return;
      }
    }

    ws.openCopyDialogWithPreset({
      sourcePane: cur.sourcePane,
      sources: cur.sources,
      targetDir: cur.dropTargetDir,
      isMove: false,
      direction,
    });
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

/** Subscribe to Tauri native OS Desktop -> WebView file drop events. */
export function useDragDropTransfer(): void {
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const { setOsDropHoverPane } = useDragDropStore.getState();
        const payload = event.payload;

        if (payload.type === 'over' || payload.type === 'enter') {
          const hit = resolveOsDropPaneAtPosition(
            payload.position.x,
            payload.position.y,
          );
          const ws = useWorkspaceStore.getState();
          if (hit === 'right' && ws.rightPaneMode === 'remote_placeholder') {
            setOsDropHoverPane(null);
          } else {
            setOsDropHoverPane(hit);
          }
        } else if (payload.type === 'leave') {
          setOsDropHoverPane(null);
        } else if (payload.type === 'drop') {
          const targetPane =
            resolveOsDropPaneAtPosition(payload.position.x, payload.position.y) ??
            useWorkspaceStore.getState().activePane;
          setOsDropHoverPane(null);

          if (!payload.paths || payload.paths.length === 0) return;
          const ws = useWorkspaceStore.getState();
          if (targetPane === 'right' && ws.rightPaneMode === 'remote_placeholder') {
            ws.addQueueLog({
              operation: 'copy',
              source: `${payload.paths.length} OS file(s)`,
              target: 'Remote Panel',
              status: 'error',
              detail: 'Connect an SFTP session or drop onto the Local pane first.',
            });
            return;
          }

          const targetState = targetPane === 'left' ? ws.leftPane : ws.rightPane;
          if (!targetState.currentPath) return;

          const isRemoteTarget =
            targetPane === 'right' && ws.rightPaneMode === 'remote_sftp';

          ws.openCopyDialogWithPreset({
            sourcePane: targetPane === 'right' ? 'left' : 'right',
            sources: payload.paths,
            targetDir: targetState.currentPath,
            isMove: false,
            direction: isRemoteTarget ? 'upload' : 'local_copy',
            isDesktopDrop: true,
          });
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        // Ignore outside Tauri runtime
      });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);
}

export function DragDropOverlay() {
  const internalDrag = useDragDropStore((s) => s.internalDrag);
  if (!internalDrag || !internalDrag.active) return null;

  return createElement(
    'div',
    {
      style: {
        left: `${internalDrag.curX + 14}px`,
        top: `${internalDrag.curY + 12}px`,
      },
      className:
        'fixed z-[100] pointer-events-none flex items-center gap-1.5 px-2.5 py-1 rounded shadow-lg border text-xs font-medium bg-[#1e4b85] border-[#4da3ff] text-white',
    },
    createElement(Upload, { className: 'w-3.5 h-3.5 shrink-0' }),
    createElement('span', null, `${internalDrag.sources.length} item(s)`),
    internalDrag.dropTargetDir
      ? createElement(ArrowRight, { className: 'w-3 h-3 opacity-80' })
      : null,
    internalDrag.dropTargetDir
      ? createElement(
          'span',
          { className: 'font-mono text-[11px] max-w-[220px] truncate' },
          internalDrag.dropTargetDir,
        )
      : null,
  );
}
