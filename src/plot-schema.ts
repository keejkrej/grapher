import { z } from 'zod';

const finite = z.number().finite();
const label = z.string().trim().min(1).max(160);
const domain = z.tuple([finite, finite]).refine(([min, max]) => min < max && Number.isFinite(max - min), 'A domain needs two increasing finite bounds with a finite span.');
const pointSchema = z.strictObject({
  x: finite,
  y: finite,
  yLow: finite.optional(),
  yHigh: finite.optional(),
  label: label.optional(),
}).superRefine((point, context) => {
  if ((point.yLow === undefined) !== (point.yHigh === undefined)) {
    context.addIssue({ code: 'custom', message: 'Supply both yLow and yHigh for an error interval.' });
  } else if (point.yLow !== undefined && point.yHigh !== undefined && (point.yLow > point.y || point.yHigh < point.y)) {
    context.addIssue({ code: 'custom', message: 'Error intervals must enclose their observed y value.' });
  }
});

export const plotSchema = z.strictObject({
  kind: z.enum(['line', 'scatter', 'bar']),
  title: label,
  xLabel: label.optional(),
  yLabel: label.optional(),
  xUnit: z.string().trim().min(1).max(48).optional(),
  yUnit: z.string().trim().min(1).max(48).optional(),
  caption: z.string().trim().min(1).max(1200).optional(),
  source: z.string().trim().min(1).max(600).optional(),
  width: z.number().int().min(480).max(4096).default(1000),
  height: z.number().int().min(360).max(4096).default(680),
  showLegend: z.boolean().default(true),
  xDomain: domain.optional(),
  yDomain: domain.optional(),
  series: z.array(z.strictObject({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
    name: label,
    color: z.string().regex(/^#[a-fA-F0-9]{6}$/).optional(),
    points: z.array(pointSchema).min(1).max(400),
  })).min(1).max(8),
}).superRefine((spec, context) => {
  const ids = new Set<string>();
  let count = 0;
  for (const series of spec.series) {
    if (ids.has(series.id)) context.addIssue({ code: 'custom', message: `Duplicate series ID: ${series.id}.` });
    ids.add(series.id);
    count += series.points.length;
    const categories = new Set<number>();
    for (const point of series.points) {
      if (spec.kind === 'bar' && categories.has(point.x)) {
        context.addIssue({ code: 'custom', message: `Bar series “${series.name}” has more than one observation at x=${point.x}.` });
      }
      categories.add(point.x);
      if (spec.xDomain && (point.x < spec.xDomain[0] || point.x > spec.xDomain[1])) {
        context.addIssue({ code: 'custom', message: 'The x domain cannot exclude supplied observations.' });
      }
      if (spec.yDomain && ((point.yLow ?? point.y) < spec.yDomain[0] || (point.yHigh ?? point.y) > spec.yDomain[1])) {
        context.addIssue({ code: 'custom', message: 'The y domain cannot exclude supplied observations or intervals.' });
      }
    }
  }
  if (count > 400) context.addIssue({ code: 'custom', message: 'Use at most 400 total observations to keep the figure editable.' });
  if (spec.kind === 'bar' && spec.yDomain && (spec.yDomain[0] > 0 || spec.yDomain[1] < 0)) {
    context.addIssue({ code: 'custom', message: 'Bar plots require a zero baseline inside the y domain.' });
  }
});

export type PlotSpec = z.input<typeof plotSchema>;
export type Plot = z.output<typeof plotSchema>;
