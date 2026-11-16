import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import sharp from 'sharp';
import { sceneSvg, verifyScene, type Scene } from './engine.ts';
import { fontCatalog } from './font-catalog.ts';
import { missingGlyphs, normalizeFontFamily, registerFont } from './typography.ts';

const fonts = fontCatalog.map((font) => ({
  ...font,
  path: fileURLToPath(new URL(`../public/fonts/${font.file}`, import.meta.url)),
  data: readFileSync(new URL(`../public/fonts/${font.file}`, import.meta.url)),
}));

for (const font of fonts) {
  registerFont(font.family, font.data.buffer.slice(font.data.byteOffset, font.data.byteOffset + font.data.byteLength), font.weight);
}

const fontOptions = {
  loadSystemFonts: false,
  fontFiles: fonts.map((font) => font.path),
  defaultFontFamily: 'Source Sans 3',
  sansSerifFamily: 'Source Sans 3',
  serifFamily: 'Crimson Text',
  monospaceFamily: 'Courier Prime',
};

export function portableSvg(scene: Scene, outlineText = false) {
  const svg = sceneSvg(scene, { outlineText });
  if (outlineText) return svg;
  const families = new Set(scene.layers.filter((layer) => layer.kind === 'text').map((layer) => normalizeFontFamily(layer.fontFamily)));
  const css = fonts.filter((font) => families.has(font.family)).map((font) =>
    `@font-face{font-family:'${font.family}';font-weight:${font.weight};src:url(data:font/${font.file.endsWith('.otf') ? 'otf' : 'ttf'};base64,${font.data.toString('base64')})}`).join('');
  return svg.replace(/(<svg[^>]*>)/, `$1<style>${css}</style>`);
}

export function renderPng(scene: Scene, scale = 1) {
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 4 || scene.width * scene.height * scale ** 2 > 64_000_000) {
    throw new Error('PNG output must use a scale from 0.1 to 4 and fit within 64 million pixels.');
  }
  return new Resvg(sceneSvg(scene, { outlineText: true }), { font: fontOptions, fitTo: { mode: 'zoom', value: scale } }).render().asPng();
}

export async function renderPdf(scene: Scene) {
  const doc = new PDFDocument({
    size: [scene.width * 0.75, scene.height * 0.75],
    margin: 0,
    info: { Title: scene.name, Creator: 'Grapher', Producer: 'Grapher' },
    compress: true,
  });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolveResult, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolveResult(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const warnings: string[] = [];
  SVGtoPDF(doc, sceneSvg(scene, { outlineText: true }), 0, 0, {
    width: scene.width * 0.75,
    height: scene.height * 0.75,
    warningCallback: (warning) => warnings.push(warning),
  });
  doc.end();
  const bytes = await result;
  if (warnings.length) throw new Error(`PDF export could not preserve the figure. ${warnings.join(' ')}`);
  return bytes;
}

export async function verifyArtifact(scene: Scene): Promise<ReturnType<typeof verifyScene>> {
  const report = verifyScene(scene);
  const extra: typeof report.issues = [];
  for (const layer of scene.layers) {
    if (!layer.visible || layer.opacity === 0) continue;
    if (layer.kind === 'raster') {
      try {
        const content = layer.src.split(',')[1] || '';
        await sharp(Buffer.from(content, 'base64'), { failOn: 'warning', limitInputPixels: 64_000_000 }).raw().toBuffer();
      } catch {
        extra.push({ id: `decode:${layer.id}`, checkId: 'decode', layerId: layer.id, severity: 'error', fixable: false,
          message: `“${layer.name}” cannot be decoded as a complete image. Replace the image data.` });
      }
    }
    if (layer.kind === 'text') {
      const absent = missingGlyphs(layer.text, layer);
      if (absent.length) extra.push({ id: `fonts:${layer.id}`, checkId: 'fonts', layerId: layer.id, severity: 'error', fixable: false,
        message: `“${layer.name}” uses characters absent from its font (${absent.join(' ')}). Choose a font containing these glyphs.` });
    }
  }
  if (!report.issues.some((issue) => issue.severity !== 'warning' && ['canvas', 'geometry', 'assets'].includes(issue.checkId)) && !extra.some((issue) => issue.checkId === 'decode')) {
    try {
      const scale = Math.min(1, 1200 / Math.max(scene.width, scene.height));
      const png = renderPng(scene, scale);
      const metadata = await sharp(png).metadata();
      if (!metadata.width || !metadata.height) throw new Error('The render has no dimensions.');
    } catch (error) {
      extra.push({ id: 'render:scene', checkId: 'render', severity: 'error', fixable: false,
        message: error instanceof Error ? error.message : 'Rendering failed.' });
    }
  } else {
    extra.push({ id: 'render:scene', checkId: 'render', severity: 'warning', fixable: false,
      message: 'Resolve invalid geometry and image data before the rendered artifact can be checked.' });
  }
  report.issues.push(...extra);
  for (const [id, label, detail] of [
    ['decode', 'Image decoding', 'Visible raster assets decoded successfully.'],
    ['fonts', 'Font coverage', 'Visible text uses glyphs present in the bundled fonts.'],
    ['render', 'Artifact rendering', 'The scene rasterized successfully with the bundled fonts.'],
  ]) {
    const findings = extra.filter((issue) => issue.checkId === id);
    report.checks.push({
      id, label,
      status: findings.some((issue) => issue.severity === 'error') ? 'fail' : findings.length ? 'warn' : 'pass',
      detail: findings.length ? findings.map((issue) => issue.message).join(' ') : detail,
    });
  }
  report.total = report.checks.length;
  report.passed = report.checks.filter((check) => check.status === 'pass').length;
  return report;
}
