import { layerBounds, textLayout, type Layer } from './engine';
import { measureText, normalizeFontFamily, textMetrics } from './typography';

type TextLayer = Extract<Layer, { kind: 'text' }>;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Layout the native editor around the same baseline and rotation pivot as the SVG. */
export function textEditorLayout(layer: TextLayer, value = layer.text) {
  const draft = { ...layer, text: value };
  const lines = textLayout(draft);
  const lineHeight = layer.fontSize * (layer.lineHeight ?? 1.2);
  const metrics = textMetrics(layer);
  const baseline = (lineHeight + metrics.ascent - metrics.descent) / 2;
  const align: 'left' | 'center' | 'right' = layer.align === 'center' || layer.align === 'middle' ? 'center'
    : layer.align === 'right' || layer.align === 'end' ? 'right' : 'left';
  const width = Math.max(layer.maxWidth ?? Math.max(...lines.map((line) => line.width), 0), layer.fontSize * 0.6) + 1;
  const left = layer.x - (align === 'center' ? width / 2 : align === 'right' ? width : 0);
  const top = layer.y - baseline;
  const measuredInk = layerBounds({ ...draft, rotationDeg: 0 });
  // Empty paragraphs can have no painted bounds while the user is deleting text.
  const ink = Object.values(measuredInk).every(Number.isFinite) ? measuredInk : {
    x: left, y: layer.y - metrics.ascent, width, height: metrics.ascent + metrics.descent,
  };
  const weight = layer.fontWeight === 'bold' ? 700 : Number(layer.fontWeight) || 400;
  return {
    left, top, width, lineHeight, baseline, align,
    height: Math.max(lineHeight, lines.length * lineHeight),
    fontFamily: normalizeFontFamily(layer.fontFamily), fontWeight: weight > 550 ? 700 : 400,
    pivotX: ink.x + ink.width / 2, pivotY: ink.y + ink.height / 2,
  };
}

/** Retain original UTF-16 positions through the renderer's NFC and whitespace normalization. */
function paragraphSource(paragraph: string, offset: number, wrap: boolean) {
  const characters: { text: string; start: number; end: number }[] = [];
  for (const part of graphemes.segment(paragraph)) {
    for (const text of part.segment.normalize('NFC')) {
      characters.push({ text, start: offset + part.index, end: offset + part.index + part.segment.length });
    }
  }
  let text = '';
  const positions: { start: number; end: number }[] = [];
  for (let index = 0; index < characters.length; index++) {
    let character = characters[index];
    if (wrap && /\s/.test(character.text)) {
      let end = character.end;
      while (index + 1 < characters.length && /\s/.test(characters[index + 1].text)) end = characters[++index].end;
      if (!text) continue;
      character = { text: ' ', start: character.start, end };
    }
    text += character.text;
    for (let unit = 0; unit < character.text.length; unit++) positions.push({ start: character.start, end: character.end });
  }
  return { text, positions };
}

function sourceLines(layer: TextLayer) {
  let paragraphOffset = 0;
  return layer.text.split('\n').flatMap((paragraph) => {
    const source = paragraphSource(paragraph, paragraphOffset, !!layer.maxWidth);
    const start = paragraphOffset;
    paragraphOffset += paragraph.length + 1;
    let cursor = 0;
    return textLayout({ ...layer, text: paragraph }).map((line) => {
      const found = source.text.indexOf(line.text, cursor);
      const offset = found < 0 ? cursor : found;
      cursor = offset + line.text.length;
      return { start, positions: source.positions.slice(offset, cursor) };
    });
  });
}

/** Place the initial caret near the double-click, instead of replacing all text. */
export function textCaretIndex(layer: TextLayer, point: { x: number; y: number }) {
  const layout = textEditorLayout(layer);
  const angle = -(layer.rotationDeg ?? 0) * Math.PI / 180;
  const dx = point.x - layout.pivotX;
  const dy = point.y - layout.pivotY;
  const x = layout.pivotX + dx * Math.cos(angle) - dy * Math.sin(angle);
  const y = layout.pivotY + dx * Math.sin(angle) + dy * Math.cos(angle);
  const lines = textLayout(layer);
  if (!lines.length) return layer.text.length;
  const lineIndex = Math.max(0, Math.min(lines.length - 1, Math.floor((y - layout.top) / layout.lineHeight)));
  const line = lines[lineIndex];
  const source = sourceLines(layer)[lineIndex];
  let prefix = '';
  for (const part of graphemes.segment(line.text)) {
    const next = prefix + part.segment;
    if (x - line.x < (measureText(prefix, layer) + measureText(next, layer)) / 2) break;
    prefix = next;
  }
  return prefix.length ? source.positions[prefix.length - 1]?.end ?? layer.text.length
    : source.positions[0]?.start ?? source.start;
}
