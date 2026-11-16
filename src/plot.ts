import { layerBounds, sceneSchema, type Layer, type Scene } from './engine.ts';
import { plotSchema, type Plot } from './plot-schema.ts';
import { measureText, wrapText } from './typography.ts';

type Domain = [number, number];
type XY = [number, number];
type TextLayer = Extract<Layer, { kind: 'text' }>;
const palette = ['#2563A6', '#C44E37', '#26836E', '#8455A5', '#996B19', '#B34879', '#3B7D92', '#626B78'];
const fontFamily = 'Source Sans 3';
const ink = '#18354A';
const muted = '#465F70';
const grid = '#DBE4E9';

function text(id: string, name: string, value: string, x: number, y: number, fontSize: number, options: Partial<TextLayer> = {}): TextLayer {
  return { id, name, kind: 'text', visible: true, text: value, x, y, fontSize, fill: ink, fontFamily, lineHeight: 1.25, ...options };
}

function pointString([x, y]: XY) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('The plot produced non-finite coordinates; rescale the data or domains.');
  return `${Number(x.toFixed(4))} ${Number(y.toFixed(4))}`;
}

function path(id: string, name: string, segments: XY[][], stroke: string, strokeWidth = 1): Extract<Layer, { kind: 'path' }> {
  const points = segments.flat();
  const x = Math.min(...points.map((point) => point[0]));
  const y = Math.min(...points.map((point) => point[1]));
  const right = Math.max(...points.map((point) => point[0]));
  const bottom = Math.max(...points.map((point) => point[1]));
  return {
    id, name, kind: 'path', visible: true, fill: 'none', stroke, strokeWidth, strokeLinecap: 'round',
    d: segments.map((segment) => segment.map((point, index) => `${index ? 'L' : 'M'}${pointString(point)}`).join(' ')).join(' '),
    bounds: { x, y, width: right - x, height: bottom - y },
  };
}

function niceStep(span: number, desired = 5) {
  const rough = span / desired;
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power;
  if (!Number.isFinite(step) || step <= 0) throw new Error('The numeric range is too large or small to plot; rescale the data.');
  return step;
}

function niceDomain(min: number, max: number): Domain {
  const step = niceStep(max - min);
  const domain: Domain = [Math.floor(min / step) * step, Math.ceil(max / step) * step];
  if (!Number.isFinite(domain[0]) || !Number.isFinite(domain[1]) || !(domain[0] < domain[1]) || !Number.isFinite(domain[1] - domain[0])) {
    throw new Error('The numeric domain cannot be represented safely; rescale the data.');
  }
  return domain;
}

function paddedDomain(min: number, max: number, padding: number): Domain {
  const span = max - min;
  if (!Number.isFinite(span)) throw new Error('The data span is too large; rescale the data.');
  const margin = span > 0 ? span * padding : Math.abs(min) * 0.1 || 1;
  const domain: Domain = [min - margin, max + margin];
  if (!Number.isFinite(domain[0]) || !Number.isFinite(domain[1]) || !(domain[0] < domain[1]) || !Number.isFinite(domain[1] - domain[0])) {
    throw new Error('The numeric domain cannot be represented safely; rescale the data.');
  }
  return domain;
}

function ticks(domain: Domain): number[] {
  const step = niceStep(domain[1] - domain[0]);
  const first = Math.ceil(domain[0] / step - 1e-10);
  const last = Math.floor(domain[1] / step + 1e-10);
  if (last - first > 30) throw new Error('The plot tick range is not representable.');
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => {
    const value = (first + index) * step;
    return Math.abs(value) < step * 1e-8 ? 0 : value;
  });
}

function numericLabel(value: number, precision = 8) {
  if (value === 0) return '0';
  const rounded = Number(value.toPrecision(precision));
  const magnitude = Math.abs(rounded);
  return magnitude >= 100_000 || magnitude < 0.001
    ? rounded.toExponential(precision - 1).replace(/\.?0+(?=e)/, '').replace('e+', 'e')
    : String(rounded);
}

function tickLabels(values: number[]) {
  const gaps = values.slice(1).map((value, index) => Math.abs(value - values[index])).filter((gap) => gap > 0);
  const step = gaps.length ? Math.min(...gaps) : 0;
  for (let precision = 4; precision <= 17; precision++) {
    const labels = values.map((value) => numericLabel(value, precision));
    if (new Set(labels).size !== values.length) continue;
    if (!values.every((value, index) => Math.abs(Number(labels[index]) - value) <= Math.max(step * 1e-6, Math.abs(value) * Number.EPSILON * 2))) continue;
    return new Map(values.map((value, index) => [value, labels[index]]));
  }
  throw new Error('Distinct axis ticks cannot be labeled accurately at this numeric scale. Rescale the data or use an axis offset.');
}

function axisTitle(label?: string, unit?: string) {
  return label && unit ? `${label} (${unit})` : label ?? unit;
}

/** Compile explicit observations into editable vector layers. No data are generated or imputed. */
export function composePlot(input: unknown): Scene {
  const spec: Plot = plotSchema.parse(input);
  const points = spec.series.flatMap((series) => series.points);
  const xs = [...new Set(points.map((point) => point.x))].sort((a, b) => a - b);
  const minX = xs[0];
  const maxX = xs[xs.length - 1];
  const gaps = xs.slice(1).map((value, index) => value - xs[index]);
  const slot = gaps.length ? Math.min(...gaps) : Math.abs(minX) * 0.2 || 1;
  if (!Number.isFinite(slot) || slot <= 0) throw new Error('The x values cannot be represented safely; rescale the data.');
  let xDomain = spec.xDomain ?? (spec.kind === 'bar' ? niceDomain(minX - slot * 0.6, maxX + slot * 0.6) : paddedDomain(minX, maxX, 0.05));
  const minY = Math.min(...points.map((point) => point.yLow ?? point.y));
  const maxY = Math.max(...points.map((point) => point.yHigh ?? point.y));
  let yDomain: Domain;
  if (spec.yDomain) yDomain = spec.yDomain;
  else if (spec.kind === 'bar') {
    const low = Math.min(0, minY);
    const high = Math.max(0, maxY);
    const margin = (high - low) * 0.08;
    yDomain = low === high ? [0, 1] : niceDomain(low < 0 ? low - margin : 0, high > 0 ? high + margin : 0);
  } else yDomain = paddedDomain(minY, maxY, 0.08);
  if (spec.kind === 'bar' && (xDomain[0] > minX - slot * 0.4 || xDomain[1] < maxX + slot * 0.4)) {
    if (spec.xDomain) throw new Error('The x domain must leave room around complete bars, including their widths.');
    xDomain = niceDomain(minX - slot * 0.6, maxX + slot * 0.6);
  }

  const yTicks = ticks(yDomain);
  const yLabels = tickLabels(yTicks);
  const xTitle = axisTitle(spec.xLabel, spec.xUnit);
  const yTitle = axisTitle(spec.yLabel, spec.yUnit);
  const side = 44;
  const available = spec.width - side * 2;
  const title = text('plot-title', 'Figure title', spec.title, side, 58, 30, { maxWidth: available, fontWeight: 700 });
  const titleLines = wrapText(spec.title, title);
  const layers: Layer[] = [title];
  let headerBottom = 58 + (titleLines.length - 1) * 37.5 + 12;
  if (spec.showLegend) {
    let legendX = side;
    let legendY = headerBottom + 22;
    let rowHeight = 22;
    for (const [index, series] of spec.series.entries()) {
      const style = { fontFamily, fontSize: 14, maxWidth: available - 32 };
      const lines = wrapText(series.name, style);
      const width = Math.max(...lines.map((line) => measureText(line, style))) + 46;
      const height = lines.length * 18;
      if (legendX > side && legendX + width > spec.width - side) {
        legendX = side;
        legendY += rowHeight + 8;
        rowHeight = 22;
      }
      const color = series.color ?? palette[index];
      layers.push({ id: `legend-${series.id}-swatch`, name: `${series.name} legend key`, kind: 'rect', visible: true,
        x: legendX, y: legendY - 10, width: 19, height: 9, rx: 2, fill: color });
      layers.push(text(`legend-${series.id}-name`, `${series.name} legend label`, lines.join('\n'), legendX + 27, legendY, 14, { lineHeight: 18 / 14, fill: muted }));
      legendX += width;
      rowHeight = Math.max(rowHeight, height);
    }
    headerBottom = legendY + rowHeight - 8;
  }

  const yTickWidth = Math.max(...yTicks.map((value) => measureText(yLabels.get(value)!, { fontFamily, fontSize: 13 })));
  const left = Math.max(62, yTickWidth + (yTitle ? 78 : 28));
  const right = 44;
  const plotWidth = spec.width - left - right;
  const xTickCandidates = spec.kind === 'bar' ? xs : ticks(xDomain);
  const xLabels = tickLabels(xTickCandidates);
  const labels = new Map<number, string>();
  if (spec.kind === 'bar') {
    for (const point of points) {
      if (point.label && labels.has(point.x) && labels.get(point.x) !== point.label) throw new Error(`Conflicting category labels at x=${point.x}.`);
      if (point.label) labels.set(point.x, point.label);
    }
  }
  const numericTickWidth = Math.max(...xTickCandidates.filter((value) => !labels.has(value)).map((value) => measureText(xLabels.get(value)!, { fontFamily, fontSize: 13 })), 0);
  const maxTicks = Math.max(2, Math.floor(plotWidth / Math.max(95, numericTickWidth + 16)));
  const stride = Math.max(1, Math.ceil(xTickCandidates.length / maxTicks));
  const xTicks = xTickCandidates.filter((_, index) => index % stride === 0);
  const tickWidth = Math.min(120, plotWidth / Math.max(1, xTicks.length) - 12);
  const xTickLines = xTicks.map((value) => labels.has(value)
    ? wrapText(labels.get(value)!, { fontFamily, fontSize: 13, maxWidth: tickWidth })
    : [xLabels.get(value)!]);
  const xTickHeight = Math.max(1, ...xTickLines.map((lines) => lines.length)) * 16;
  const captionLines = spec.caption ? wrapText(spec.caption, { fontFamily, fontSize: 14, maxWidth: available }) : [];
  const sourceLines = spec.source ? wrapText(`Source: ${spec.source}`, { fontFamily, fontSize: 12, maxWidth: available }) : [];
  const footerHeight = (captionLines.length ? captionLines.length * 18 + 10 : 0) + (sourceLines.length ? sourceLines.length * 16 + 8 : 0);
  const xTitleLines = xTitle ? wrapText(xTitle, { fontFamily, fontSize: 15, maxWidth: plotWidth }) : [];
  const bottom = spec.height - 30 - footerHeight - xTickHeight - 18 - xTitleLines.length * 19;
  const top = headerBottom + 30;
  const plotHeight = bottom - top;
  if (plotWidth < 160 || plotHeight < 140) throw new Error('The figure is too small for its title, labels and caption. Increase its width or height, or shorten the text.');
  const xPosition = (value: number) => left + (value - xDomain[0]) / (xDomain[1] - xDomain[0]) * plotWidth;
  const yPosition = (value: number) => bottom - (value - yDomain[0]) / (yDomain[1] - yDomain[0]) * plotHeight;

  for (const [index, value] of yTicks.entries()) {
    const y = yPosition(value);
    const label = yLabels.get(value)!;
    layers.push(path(`y-grid-${index}`, `Horizontal grid at ${label}`, [[[left, y], [left + plotWidth, y]]], value === 0 ? '#A7BAC5' : grid, value === 0 ? 1.1 : 0.8));
    layers.push(path(`y-tick-${index}`, `Y tick ${label}`, [[[left - 5, y], [left, y]]], muted));
    layers.push(text(`y-tick-label-${index}`, `Y axis value ${label}`, label, left - 12, y + 4, 13, { align: 'right', fill: muted }));
  }
  layers.push(path('plot-axes', 'Numeric plot axes', [[[left, top], [left, bottom], [left + plotWidth, bottom]]], muted, 1.2));
  for (const [index, value] of xTicks.entries()) {
    const x = xPosition(value);
    layers.push(path(`x-tick-${index}`, `X tick ${xLabels.get(value)!}`, [[[x, bottom], [x, bottom + 5]]], muted));
    layers.push(text(`x-tick-label-${index}`, `X axis value ${labels.get(value) ?? xLabels.get(value)!}`, xTickLines[index].join('\n'), x, bottom + 21, 13, { align: 'center', lineHeight: 16 / 13, fill: muted }));
  }
  if (xTitle) layers.push(text('x-axis-title', 'X axis label and units', xTitleLines.join('\n'), left + plotWidth / 2, bottom + xTickHeight + 30, 15, { align: 'center', lineHeight: 19 / 15 }));
  if (yTitle) layers.push(text('y-axis-title', 'Y axis label and units', yTitle, 27, top + plotHeight / 2 + 5, 15, { align: 'center', maxWidth: plotHeight, rotationDeg: -90 }));

  for (const [seriesIndex, series] of spec.series.entries()) {
    const color = series.color ?? palette[seriesIndex];
    const ordered = [...series.points].sort((a, b) => a.x - b.x);
    const groupWidth = slot * 0.8 / (xDomain[1] - xDomain[0]) * plotWidth;
    const barWidth = groupWidth / spec.series.length;
    const errorSegments: XY[][] = [];
    if (spec.kind === 'line' && ordered.length > 1) {
      layers.push(path(`series-${series.id}-line`, `${series.name} observations`, [ordered.map((point) => [xPosition(point.x), yPosition(point.y)])], color, 2.4));
    }
    for (const [index, point] of ordered.entries()) {
      const x = xPosition(point.x) + (spec.kind === 'bar' ? barWidth * (seriesIndex - (spec.series.length - 1) / 2) : 0);
      const y = yPosition(point.y);
      const id = `series-${series.id}-point-${index}`;
      const name = `${series.name}: x=${String(point.x)}, y=${String(point.y)}`;
      if (spec.kind === 'bar') {
        const zero = yPosition(0);
        if (point.y === 0) layers.push(path(id, name, [[[x - barWidth * 0.42, zero], [x + barWidth * 0.42, zero]]], color, 1.5));
        else layers.push({ id, name, kind: 'rect', visible: true, x: x - barWidth * 0.42, y: Math.min(y, zero),
          width: barWidth * 0.84, height: Math.abs(zero - y), fill: color });
      } else if (spec.kind === 'scatter' || ordered.length <= 60) {
        layers.push({ id, name, kind: 'ellipse', visible: true, x, y, rx: spec.kind === 'scatter' ? 4 : 3.2, ry: spec.kind === 'scatter' ? 4 : 3.2, fill: color, stroke: '#FFFFFF', strokeWidth: 1 });
      }
      if (point.yLow !== undefined && point.yHigh !== undefined) {
        const low = yPosition(point.yLow);
        const high = yPosition(point.yHigh);
        const cap = spec.kind === 'bar' ? Math.min(5, barWidth * 0.3) : 4;
        errorSegments.push([[x, low], [x, high]], [[x - cap, low], [x + cap, low]], [[x - cap, high], [x + cap, high]]);
      }
    }
    if (errorSegments.length) layers.push(path(`series-${series.id}-intervals`, `${series.name} supplied yLow/yHigh intervals`, errorSegments, color, 1.4));
  }

  let footerY = spec.height - 24 - footerHeight + (captionLines.length ? 14 : 12);
  if (captionLines.length) {
    layers.push(text('plot-caption', 'Figure caption', captionLines.join('\n'), side, footerY, 14, { fill: muted, lineHeight: 18 / 14 }));
    footerY += captionLines.length * 18 + 8;
  }
  if (sourceLines.length) layers.push(text('plot-source', 'Data source', sourceLines.join('\n'), side, footerY, 12, { fill: muted, lineHeight: 16 / 12 }));
  const scene = sceneSchema.parse({ name: spec.title, width: spec.width, height: spec.height, background: '#FFFFFF', layers, provenance: { generator: 'plot', input: spec } });
  for (const layer of scene.layers) {
    const bounds = layerBounds(layer);
    if (bounds.x < -0.01 || bounds.y < -0.01 || bounds.x + bounds.width > scene.width + 0.01 || bounds.y + bounds.height > scene.height + 0.01) {
      throw new Error(`“${layer.name}” does not fit the figure. Increase its dimensions or shorten its labels.`);
    }
  }
  return scene;
}
