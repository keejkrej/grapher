import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { layerBounds, textLayout, type Layer } from './engine.ts';
import { textCaretIndex, textEditorLayout } from './text-editor-layout.ts';
import { measureText, registerFont } from './typography.ts';

for (const [file, weight] of [['SourceSans3-Regular.otf', 400], ['SourceSans3-Bold.otf', 700]] as const) {
  registerFont('Source Sans 3', new Uint8Array(readFileSync(new URL(`../public/fonts/${file}`, import.meta.url))).buffer, weight);
}

type TextLayer = Extract<Layer, { kind: 'text' }>;
const label: TextLayer = {
  id: 'label', name: 'Figure label', visible: true, kind: 'text', x: 200, y: 100,
  text: 'Human + agent', fontFamily: 'Source Sans 3', fontSize: 20, fill: '#123456',
};

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);
}

function pointAfter(layer: TextLayer, prefix: string, lineIndex = 0) {
  const line = textLayout(layer)[lineIndex];
  return { x: line.x + measureText(prefix, layer), y: line.y };
}

test('the editor preserves the saved text baseline and multiline spacing', () => {
  const layout = textEditorLayout({ ...label, text: 'Title\nSubtitle', lineHeight: 1.5 });
  // Source Sans 3 at 20px has a 20px ascent and a 6.52px descent.
  near(layout.baseline, 21.74);
  near(layout.top, 78.26);
  near(layout.top + layout.baseline, label.y);
  near(layout.height, 60);
  near(layout.lineHeight, 30);
});

test('growing labels keep their left, center or right text anchor fixed', () => {
  for (const align of ['left', 'start', 'center', 'middle', 'right', 'end'] as const) {
    const layer = { ...label, align };
    for (const value of ['Short', 'A substantially longer correction']) {
      const layout = textEditorLayout(layer, value);
      const anchor = layout.align === 'left' ? layout.left
        : layout.align === 'center' ? layout.left + layout.width / 2 : layout.left + layout.width;
      near(anchor, label.x);
    }
  }
  const wrapped = { ...label, maxWidth: 160 };
  near(textEditorLayout(wrapped, 'Short').width, textEditorLayout(wrapped, 'Many words that wrap over multiple lines').width);
});

test('rotation uses the rendered ink center and inverse-rotates caret hit tests', () => {
  const layer = { ...label, text: 'Rotate label', align: 'center' as const, rotationDeg: 37 };
  const raw = layerBounds({ ...layer, rotationDeg: 0 });
  const layout = textEditorLayout(layer);
  near(layout.pivotX, raw.x + raw.width / 2);
  near(layout.pivotY, raw.y + raw.height / 2);
  const unrotated = pointAfter(layer, 'Rotate');
  const angle = layer.rotationDeg * Math.PI / 180;
  const dx = unrotated.x - layout.pivotX;
  const dy = unrotated.y - layout.pivotY;
  const point = {
    x: layout.pivotX + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: layout.pivotY + dx * Math.sin(angle) + dy * Math.cos(angle),
  };
  assert.equal(textCaretIndex(layer, point), 6);
});

test('transient empty and whitespace drafts keep finite editor geometry', () => {
  for (const value of ['', ' ', '   \n  ']) {
    const layout = textEditorLayout({ ...label, maxWidth: 120, rotationDeg: 45 }, value);
    for (const value of Object.values(layout)) if (typeof value === 'number') assert.ok(Number.isFinite(value));
    assert.ok(layout.width > 0 && layout.height > 0);
  }
});

test('caret placement preserves UTF-16 grapheme boundaries after normalization', () => {
  const decomposed = { ...label, text: 'e\u0301AB' };
  assert.equal(textCaretIndex(decomposed, pointAfter(decomposed, 'é')), 2);
  assert.equal(textCaretIndex(decomposed, pointAfter(decomposed, 'éA')), 3);
  // Unavailable glyphs remain editable in a draft, including their surrogate pairs.
  const surrogate = { ...label, text: 'A😀B' };
  assert.equal(textCaretIndex(surrogate, pointAfter(surrogate, 'A😀')), 3);
  const joined = { ...label, text: 'A👩‍🔬B' };
  assert.equal(textCaretIndex(joined, pointAfter(joined, 'A👩‍🔬')), 6);
});

test('blank hard lines retain their own source offsets, including the trailing line', () => {
  const layer = { ...label, text: 'A\n\nB\n' };
  assert.equal(textCaretIndex(layer, pointAfter(layer, '', 1)), 2);
  assert.equal(textCaretIndex(layer, pointAfter(layer, '', 3)), 5);
  assert.equal(textCaretIndex(layer, pointAfter(layer, 'B', 2)), 4);
});

test('wrapped caret placement maps collapsed whitespace and repeated words to source', () => {
  const layer = { ...label, text: 'alpha   beta gamma', maxWidth: measureText('alpha beta', label) + 0.1 };
  assert.equal(textLayout(layer).length, 2);
  assert.equal(textCaretIndex(layer, pointAfter(layer, 'alpha b')), 9);
  assert.equal(textCaretIndex(layer, pointAfter(layer, 'gamma', 1)), layer.text.length);
  const repeated = { ...label, text: 'same same same', maxWidth: measureText('same same', label) + 0.1 };
  assert.equal(textCaretIndex(repeated, pointAfter(repeated, '', 1)), 10);
  assert.equal(textCaretIndex(repeated, pointAfter(repeated, 'same', 1)), 14);
});

test('caret hit testing clamps clicks before and after the text', () => {
  assert.equal(textCaretIndex(label, { x: -1000, y: -1000 }), 0);
  assert.equal(textCaretIndex(label, { x: 10000, y: 10000 }), label.text.length);
  assert.equal(textCaretIndex({ ...label, text: '  ', maxWidth: 120 }, { x: 0, y: 0 }), 2);
});
