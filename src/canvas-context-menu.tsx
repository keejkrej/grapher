import { MenuContent, MenuItem, MenuSeparator, type MenuFinalFocus } from '@ui-sdk/react/menu';
import { BringToFront, Copy, SendToBack, Trash2, Type } from 'lucide-react';
import type { Layer } from './engine';

type Props = {
  selectedLayer?: Layer;
  working: boolean;
  finalFocus: MenuFinalFocus;
};

export function CanvasContextMenu({ selectedLayer, working, finalFocus }: Props) {
  return <MenuContent className="pop-menu canvas-context-menu" aria-label="Selection actions"
    side="bottom" align="start" sideOffset={6} collisionPadding={12} finalFocus={finalFocus}>
    <div className="context-menu-heading" title={selectedLayer?.name}>
      {selectedLayer?.name ?? 'Select an element to see actions'}
    </div>
    {selectedLayer && <>
      {selectedLayer.kind === 'text' && <MenuItem value="text" label="Edit text" disabled={working}>
        <Type size={15} aria-hidden="true" /><span className="context-item-label">Edit text</span>
      </MenuItem>}
      <MenuItem value="duplicate" label="Duplicate" shortcut="mod+d" disabled={working}>
        <Copy size={15} aria-hidden="true" /><span className="context-item-label">Duplicate</span>
      </MenuItem>
      <MenuSeparator className="context-separator" />
      <MenuItem value="front" label="Bring to front" disabled={working}>
        <BringToFront size={15} aria-hidden="true" /><span className="context-item-label">Bring to front</span>
      </MenuItem>
      <MenuItem value="back" label="Send to back" disabled={working}>
        <SendToBack size={15} aria-hidden="true" /><span className="context-item-label">Send to back</span>
      </MenuItem>
      <MenuSeparator className="context-separator" />
      <MenuItem value="delete" label="Delete" shortcut="Delete" destructive disabled={working}>
        <Trash2 size={15} aria-hidden="true" /><span className="context-item-label">Delete</span>
      </MenuItem>
    </>}
  </MenuContent>;
}
