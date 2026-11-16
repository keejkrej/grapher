import { useLayoutEffect, useRef } from 'react';
import { textCaretIndex, textEditorLayout } from './text-editor-layout';
import type { TextEdit } from './use-canvas-interactions';

type Props = {
  edit: TextEdit;
  scale: number;
  saving: boolean;
  onChange: (value: string) => void;
  onFinish: () => void;
  onCancel: () => void;
  onCompositionChange: (active: boolean) => void;
};

export function CanvasTextEditor({ edit, scale, saving, onChange, onFinish, onCancel, onCompositionChange }: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const composition = useRef(false);
  const layout = textEditorLayout(edit.layer, edit.value);
  const layer = edit.layer;

  useLayoutEffect(() => {
    const field = input.current!;
    field.focus({ preventScroll: true });
    const board = field.closest('.artboard')!.getBoundingClientRect();
    const index = edit.point ? textCaretIndex(layer, {
      x: (edit.point.x - board.left) / scale, y: (edit.point.y - board.top) / scale,
    }) : edit.value.length;
    field.setSelectionRange(index, index);
    return () => onCompositionChange(false);
  }, []);

  useLayoutEffect(() => {
    const field = input.current!;
    field.style.height = `${layout.height}px`;
    field.style.height = `${Math.max(layout.height, field.scrollHeight)}px`;
  }, [edit.value, layout.width, layout.height]);

  return <div className="canvas-text-editor" data-canvas-editor="true" style={{
    left: layout.left * scale, top: layout.top * scale,
    width: layout.width, transform: `scale(${scale})`, transformOrigin: '0 0',
  }}>
    <textarea ref={input} aria-label="Edit text on canvas" aria-describedby="text-edit-help" spellCheck={false}
      maxLength={2000} value={edit.value} readOnly={saving} wrap={layer.maxWidth ? 'soft' : 'off'}
      style={{ width: layout.width, height: layout.height, fontFamily: `"${layout.fontFamily}"`,
        transform: `rotate(${layer.rotationDeg ?? 0}deg)`, transformOrigin: `${layout.pivotX - layout.left}px ${layout.pivotY - layout.top}px`,
        fontWeight: layout.fontWeight, fontSize: layer.fontSize, lineHeight: `${layout.lineHeight}px`,
        letterSpacing: layer.letterSpacing ?? 0, textAlign: layout.align,
        color: layer.fill.startsWith('url(') || layer.fill === 'none' || layer.fill === 'transparent' ? '#23614a' : layer.fill,
        opacity: Math.max(0.35, layer.opacity ?? 1), whiteSpace: layer.maxWidth ? 'pre-wrap' : 'pre',
      }}
      onChange={(event) => onChange(event.target.value)}
      onCompositionStart={() => { composition.current = true; onCompositionChange(true); }}
      onCompositionEnd={() => { composition.current = false; onCompositionChange(false); }}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || composition.current || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); if (!saving) onCancel(); }
        if ((event.key === 'Enter' && (event.ctrlKey || event.metaKey)) || event.key === 'Tab') {
          event.preventDefault(); if (!saving) onFinish();
        }
      }} />
  </div>;
}
