import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { layerBounds, type Layer, type Operation } from './engine';
import { layerUpdate, resizeLayer, translateLayer } from './interaction';
import type { Workspace } from './workspace-client';

type Corner = 'nw' | 'ne' | 'se' | 'sw';
type TextLayer = Extract<Layer, { kind: 'text' }>;
type Gesture = {
  base: Workspace;
  original: Layer;
  updated: Layer;
  kind: 'move' | 'resize' | 'nudge';
  corner?: Corner;
  x: number;
  y: number;
  scale: number;
  pointerId?: number;
  moved: boolean;
};
export type TextEdit = { base: Workspace; layer: TextLayer; value: string; conflict?: boolean };

type Options = {
  workspace: Workspace;
  selected?: string;
  scale: number;
  enabled: boolean;
  keyboardEnabled: boolean;
  select: (id?: string) => void;
  commit: (operations: Operation[], base: Workspace) => Promise<Workspace | undefined>;
  undo: () => void;
  redo: () => void;
  duplicate: () => void;
  remove: () => void;
  notify: (message: string) => void;
};

export function isTextInput(target: EventTarget | null) {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]');
}

export function useCanvasInteractions(options: Options) {
  const current = useRef(options);
  current.current = options;
  const gesture = useRef<Gesture | undefined>(undefined);
  const editor = useRef<TextEdit | undefined>(undefined);
  const saving = useRef(false);
  const savingLayer = useRef<Layer | undefined>(undefined);
  const pendingNudge = useRef<{ documentId?: string; id: string; x: number; y: number } | undefined>(undefined);
  const pressedArrows = useRef(new Set<string>());
  const [preview, setPreview] = useState<{ documentId?: string; layer: Layer }>();
  const [editing, setEditing] = useState<TextEdit>();

  function cancel() {
    const active = !!gesture.current || !!editor.current;
    gesture.current = undefined;
    pendingNudge.current = undefined;
    pressedArrows.current.clear();
    editor.current = undefined;
    setPreview(undefined);
    setEditing(undefined);
    return active;
  }

  async function finish() {
    const active = gesture.current;
    if (!active) return;
    gesture.current = undefined;
    if (!active.moved) { setPreview(undefined); return; }
    saving.current = true;
    savingLayer.current = active.updated;
    let saved: Workspace | undefined;
    try { saved = await current.current.commit([layerUpdate(active.original, active.updated)], active.base); }
    catch (error) { current.current.notify(error instanceof Error ? error.message : String(error)); }
    finally {
      saving.current = false;
      savingLayer.current = undefined;
      setPreview(undefined);
      if (saved) flushNudge(saved);
      else pendingNudge.current = undefined;
    }
  }

  function flushNudge(base: Workspace) {
    const pending = pendingNudge.current;
    if (!pending || saving.current || gesture.current) return;
    pendingNudge.current = undefined;
    if (pending.documentId !== base.documentId || pending.id !== current.current.selected) return;
    const layer = base.scene.layers.find((item) => item.id === pending.id);
    if (!layer) return;
    const updated = translateLayer(layer, pending.x, pending.y);
    gesture.current = { base, original: layer, updated, kind: 'nudge', x: pending.x, y: pending.y, scale: 1, moved: true };
    setPreview({ documentId: base.documentId, layer: updated });
    if (!pressedArrows.current.size) void finish();
  }

  function queueNudge(dx: number, dy: number) {
    const state = current.current;
    if (!state.selected) return;
    const pending = pendingNudge.current;
    const next = pending?.documentId === state.workspace.documentId && pending?.id === state.selected
      ? { ...pending, x: pending.x + dx, y: pending.y + dy }
      : { documentId: state.workspace.documentId, id: state.selected, x: dx, y: dy };
    pendingNudge.current = next;
    const layer = savingLayer.current?.id === next.id ? savingLayer.current : state.workspace.scene.layers.find((item) => item.id === next.id);
    if (layer) setPreview({ documentId: next.documentId, layer: translateLayer(layer, next.x, next.y) });
  }

  function begin(event: PointerEvent<HTMLElement>, layer: Layer, corner?: Corner) {
    const state = current.current;
    if (!state.enabled || saving.current || editor.current || event.button !== 0 || !event.isPrimary || isTextInput(event.target)) return;
    event.preventDefault();
    state.select(layer.id);
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { base: state.workspace, original: layer, updated: layer, kind: corner ? 'resize' : 'move', corner,
      x: event.clientX, y: event.clientY, scale: state.scale, pointerId: event.pointerId, moved: false };
  }

  function move(event: PointerEvent<HTMLElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const screenX = event.clientX - active.x;
    const screenY = event.clientY - active.y;
    if (!active.moved && Math.hypot(screenX, screenY) < 3) return;
    const dx = Math.round(screenX / active.scale * 100) / 100;
    const dy = Math.round(screenY / active.scale * 100) / 100;
    try {
      if (active.kind === 'resize') {
        const original = layerBounds(active.original);
        const west = active.corner!.includes('w');
        const north = active.corner!.includes('n');
        const x = west ? Math.min(original.x + dx, original.x + original.width - 1) : original.x;
        const y = north ? Math.min(original.y + dy, original.y + original.height - 1) : original.y;
        active.updated = resizeLayer(active.original, {
          x, y,
          width: west ? original.x + original.width - x : Math.max(1, original.width + dx),
          height: north ? original.y + original.height - y : Math.max(1, original.height + dy),
        }, { preserveAspect: event.shiftKey });
        const resized = layerBounds(active.updated);
        active.updated = translateLayer(active.updated,
          west ? original.x + original.width - resized.x - resized.width : 0,
          north ? original.y + original.height - resized.y - resized.height : 0);
      } else active.updated = translateLayer(active.original, dx, dy);
      active.moved = true;
      setPreview({ documentId: active.base.documentId, layer: active.updated });
    } catch (error) {
      cancel();
      current.current.notify(error instanceof Error ? error.message : String(error));
    }
  }

  function beginText(layer: Layer) {
    if (layer.kind !== 'text' || !current.current.enabled || saving.current) return;
    cancel();
    current.current.select(layer.id);
    const next = { base: current.current.workspace, layer, value: layer.text };
    editor.current = next;
    setEditing(next);
  }

  function changeText(value: string) {
    if (!editor.current) return;
    const next = { ...editor.current, value };
    editor.current = next;
    setEditing(next);
  }

  async function saveText() {
    const edit = editor.current;
    if (!edit || saving.current || edit.conflict) return false;
    saving.current = true;
    let saved = false;
    try {
      saved = edit.value === edit.layer.text || !!await current.current.commit([
        layerUpdate(edit.layer, { ...edit.layer, text: edit.value }),
      ], edit.base);
    } catch (error) { current.current.notify(error instanceof Error ? error.message : String(error)); }
    finally {
      saving.current = false;
      if (saved) { editor.current = undefined; setEditing(undefined); }
      else if (editor.current && edit.base.documentId === current.current.workspace.documentId && edit.base.revision !== current.current.workspace.revision) {
        const next = { ...editor.current, conflict: true };
        editor.current = next;
        setEditing(next);
      }
    }
    return saved;
  }

  useEffect(() => {
    const active = gesture.current?.base ?? editor.current?.base;
    if (active && (active.documentId !== options.workspace.documentId || active.revision !== options.workspace.revision)) {
      if (editor.current && active.documentId === options.workspace.documentId) {
        if (saving.current) return;
        const next = { ...editor.current, conflict: true };
        editor.current = next;
        setEditing(next);
        current.current.notify('The document changed. Your text draft is kept; copy it before closing the editor.');
      } else {
        cancel();
        if (active.documentId === options.workspace.documentId) current.current.notify('The document changed. Your unfinished move was cancelled; the latest revision is shown.');
      }
    }
  }, [options.workspace.documentId, options.workspace.revision]);

  useEffect(() => {
    const id = gesture.current?.original.id ?? editor.current?.layer.id;
    if (id && id !== options.selected) cancel();
    if (pendingNudge.current && pendingNudge.current.id !== options.selected) pendingNudge.current = undefined;
  }, [options.selected]);

  useEffect(() => { if (options.enabled) flushNudge(options.workspace); }, [options.enabled, options.workspace.revision, options.workspace.documentId]);

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || isTextInput(event.target) || (event.target instanceof Element && event.target.closest('[role="menu"], [role="dialog"]'))) return;
      if (event.key === 'Escape') { if (!cancel()) current.current.select(undefined); return; }
      if (editor.current || (event.target instanceof Element && event.target.closest('[data-canvas-editor]'))) return;
      const state = current.current;
      const modifier = event.ctrlKey || event.metaKey;
      const arrow = !event.altKey && !modifier && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key);
      if (arrow && state.keyboardEnabled && state.selected) {
        event.preventDefault();
        pressedArrows.current.add(event.key);
        const distance = event.shiftKey ? 10 : 1;
        const dx = event.key === 'ArrowLeft' ? -distance : event.key === 'ArrowRight' ? distance : 0;
        const dy = event.key === 'ArrowUp' ? -distance : event.key === 'ArrowDown' ? distance : 0;
        if (saving.current || !state.enabled) { queueNudge(dx, dy); return; }
        if (gesture.current && gesture.current.kind !== 'nudge') return;
        const layer = state.workspace.scene.layers.find((item) => item.id === state.selected);
        if (!layer) return;
        gesture.current ??= { base: state.workspace, original: layer, updated: layer, kind: 'nudge', x: 0, y: 0, scale: 1, moved: false };
        const active = gesture.current;
        active.x += dx;
        active.y += dy;
        active.updated = translateLayer(active.original, active.x, active.y);
        active.moved = true;
        setPreview({ documentId: active.base.documentId, layer: active.updated });
        return;
      }
      if (!state.enabled || saving.current) return;
      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault(); cancel(); if (event.shiftKey) state.redo(); else state.undo(); return;
      }
      if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); cancel(); state.redo(); return; }
      if (!state.selected) return;
      if (modifier && event.key.toLowerCase() === 'd') { event.preventDefault(); cancel(); state.duplicate(); return; }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); cancel(); state.remove(); return; }
    }
    function keyup(event: KeyboardEvent) {
      pressedArrows.current.delete(event.key);
      if (!pressedArrows.current.size && gesture.current?.kind === 'nudge') void finish();
    }
    function blur() {
      pressedArrows.current.clear(); pendingNudge.current = undefined;
      if (gesture.current) { gesture.current = undefined; setPreview(undefined); }
    }
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', blur);
    };
  }, []);

  return { preview, editing, begin, move, finish, cancel, beginText, changeText, saveText,
    release: () => { if (gesture.current) cancel(); } };
}
