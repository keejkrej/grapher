import type { PlotSpec } from './plot-schema.ts';

export const plotExamples = {
  'response-curve': {
    kind: 'line',
    title: 'Response curve · synthetic example',
    xLabel: 'Time', xUnit: 'h', yLabel: 'Response', yUnit: 'a.u.',
    caption: 'Points and intervals are supplied values. This illustration does not represent an experiment or a statistical analysis.',
    source: 'Synthetic demonstration data created for Grapher.',
    series: [
      { id: 'reference', name: 'Reference', color: '#436D83', points: [
        { x: 0, y: 4, yLow: 2, yHigh: 6 }, { x: 2, y: 8, yLow: 5, yHigh: 11 },
        { x: 4, y: 12, yLow: 8, yHigh: 16 }, { x: 6, y: 14, yLow: 10, yHigh: 18 },
        { x: 8, y: 16, yLow: 12, yHigh: 20 }, { x: 12, y: 17, yLow: 13, yHigh: 21 },
      ] },
      { id: 'comparison', name: 'Comparison', color: '#A15B36', points: [
        { x: 0, y: 4, yLow: 2, yHigh: 6 }, { x: 2, y: 19, yLow: 15, yHigh: 23 },
        { x: 4, y: 35, yLow: 30, yHigh: 40 }, { x: 6, y: 46, yLow: 40, yHigh: 52 },
        { x: 8, y: 51, yLow: 46, yHigh: 56 }, { x: 12, y: 54, yLow: 49, yHigh: 59 },
      ] },
    ],
  },
} satisfies Record<string, PlotSpec>;
