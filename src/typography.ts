import opentype, { type Font } from 'opentype.js';

export type TextStyle = {
  fontFamily?: string;
  fontSize: number;
  fontWeight?: number | string;
  letterSpacing?: number;
};

const fonts = new Map<string, Map<number, Font>>();

export function normalizeFontFamily(family = 'Source Sans 3') {
  if (/mono|courier|consolas/i.test(family)) return 'Courier Prime';
  if (/serif|crimson|georgia|times|baskerville|cambria/i.test(family) && !/sans/i.test(family)) return 'Crimson Text';
  if (/barlow/i.test(family)) return 'Barlow';
  return 'Source Sans 3';
}

export function registerFont(family: string, buffer: ArrayBuffer, weight = 400) {
  const name = normalizeFontFamily(family);
  const variants = fonts.get(name) ?? new Map<number, Font>();
  variants.set(weight, opentype.parse(buffer));
  fonts.set(name, variants);
}

function fontFor(style: TextStyle): Font | undefined {
  const variants = fonts.get(normalizeFontFamily(style.fontFamily));
  if (!variants?.size) return undefined;
  const weight = style.fontWeight === 'bold' ? 700 : Number(style.fontWeight) || 400;
  const nearest = [...variants.keys()].sort((a, b) => Math.abs(a - weight) - Math.abs(b - weight))[0];
  return variants.get(nearest);
}

// Use a shared cmap/kerning layout for preview metrics and exported outlines.
// opentype.js's full-text shaping throws on valid Crimson Text GSUB tables.
function glyphRun(text: string, style: TextStyle) {
  const font = fontFor(style);
  if (!font) return undefined;
  const glyphs = [...text.normalize('NFC')].map((character) => font.charToGlyph(character));
  const scale = style.fontSize / font.unitsPerEm;
  let width = 0;
  const positioned = glyphs.map((glyph, index) => {
    const x = width;
    width += (glyph.advanceWidth ?? 0) * scale;
    if (index < glyphs.length - 1) width += font.getKerningValue(glyph, glyphs[index + 1]) * scale + (style.letterSpacing ?? 0);
    return { glyph, x };
  });
  return { positioned, width: Math.max(0, width) };
}

function glyphPath(text: string, style: TextStyle, x: number, y: number) {
  const run = glyphRun(text, style);
  if (!run) return undefined;
  const path = new opentype.Path();
  for (const item of run.positioned) path.extend(item.glyph.getPath(x + item.x, y, style.fontSize));
  return path;
}

export function textMetrics(style: TextStyle) {
  const font = fontFor(style);
  if (!font) return { ascent: style.fontSize * 0.82, descent: style.fontSize * 0.22, measured: false };
  return {
    ascent: font.ascender / font.unitsPerEm * style.fontSize,
    descent: -font.descender / font.unitsPerEm * style.fontSize,
    measured: true,
  };
}

export function measureText(text: string, style: TextStyle): number {
  const run = glyphRun(text, style);
  if (run) return run.width;
  let width: number;
  if (normalizeFontFamily(style.fontFamily) === 'Courier Prime') width = Array.from(text).length * style.fontSize * 0.6;
  else {
    width = [...text].reduce((sum, glyph) => {
      if (/[ilI.,|!':;\s]/.test(glyph)) return sum + 0.28;
      if (/[MWmw@%]/.test(glyph)) return sum + 0.88;
      return sum + (/[^\u0000-\u00ff]/.test(glyph) ? 0.86 : 0.57);
    }, 0) * style.fontSize;
  }
  return Math.max(0, width + Math.max(0, Array.from(text).length - 1) * (style.letterSpacing ?? 0));
}

export function textInkBounds(text: string, style: TextStyle) {
  const path = glyphPath(text, style, 0, 0);
  if (!path || !text.trim()) {
    const metrics = textMetrics(style);
    return { x: 0, y: -metrics.ascent, width: measureText(text, style), height: metrics.ascent + metrics.descent };
  }
  const bounds = path.getBoundingBox();
  return { x: bounds.x1, y: bounds.y1, width: bounds.x2 - bounds.x1, height: bounds.y2 - bounds.y1 };
}

export function textOutline(text: string, style: TextStyle, x: number, y: number): string | undefined {
  const path = glyphPath(text, style, x, y);
  if (!path) return undefined;
  // opentype 2's serializer rounds tiny fractional parts through exponent strings,
  // which produces NaN for otherwise finite coordinates near whole pixels.
  const number = (value: number) => {
    if (!Number.isFinite(value)) throw new Error('A font produced non-finite glyph coordinates.');
    return String(Number(value.toFixed(3)));
  };
  return path.commands.map((command) => {
    switch (command.type) {
      case 'M': case 'L': return `${command.type}${number(command.x)} ${number(command.y)}`;
      case 'Q': return `Q${[command.x1, command.y1, command.x, command.y].map(number).join(' ')}`;
      case 'C': return `C${[command.x1, command.y1, command.x2, command.y2, command.x, command.y].map(number).join(' ')}`;
      case 'Z': return 'Z';
    }
  }).join('');
}

export function missingGlyphs(text: string, style: TextStyle): string[] {
  const font = fontFor(style);
  if (!font) return [];
  return [...new Set([...text.normalize('NFC')].filter((character) => !/\s/.test(character) && font.charToGlyphIndex(character) === 0))];
}

export function needsComplexShaping(text: string): boolean {
  return /[\p{Mark}\u0590-\u08ff\u200c-\u200f\u202a-\u202e\u2066-\u2069]/u.test(text.normalize('NFC'));
}

export function wrapText(text: string, style: TextStyle & { maxWidth?: number }): string[] {
  text = text.normalize('NFC');
  if (!style.maxWidth || style.maxWidth <= 0) return text.split('\n');
  const maxWidth = style.maxWidth;
  return text.split('\n').flatMap((paragraph) => {
    if (!paragraph) return [''];
    const lines: string[] = [];
    let current = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = current ? `${current} ${word}` : word;
      if (measureText(candidate, style) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      current = '';
      for (const character of word) {
        if (current && measureText(current + character, style) > maxWidth) {
          lines.push(current);
          current = '';
        }
        current += character;
      }
    }
    if (current) lines.push(current);
    return lines;
  });
}
