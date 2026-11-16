import type { DiagramSpec } from './diagram-schema';

export const figureExamples = {
  'single-cell-workflow': {
    title: 'Single-cell RNA-seq analysis',
    subtitle: 'From gene counts to cell populations and expression programs. Filtering thresholds and biological interpretation require validation for each experiment.',
    direction: 'RIGHT',
    theme: 'paper',
    nodes: [
      { id: 'counts', label: 'Gene-count matrix', description: 'Sequenced cells × measured genes', shape: 'ellipse', fill: '#EDF3EF' },
      { id: 'quality', label: 'Quality control', description: 'Assess low-quality cells and doublets', shape: 'diamond', fill: '#F8EEDB' },
      { id: 'analysis', label: 'Expression analysis', description: 'Normalize, reduce dimensions and cluster', fill: '#E7F1F2' },
      { id: 'populations', label: 'Cell populations', description: 'Annotate with marker genes and reference evidence', fill: '#EDF3EF' },
      { id: 'programs', label: 'Expression programs', description: 'Compare gene signatures with validated methods', fill: '#EAF0F6' },
      { id: 'excluded', label: 'Excluded cells', description: 'Record filtering criteria and counts', fill: '#F7F2ED' },
    ],
    edges: [
      { from: 'counts', to: 'quality' },
      { from: 'quality', to: 'analysis', label: 'Retained cells' },
      { from: 'quality', to: 'excluded', label: 'Flagged cells', dashed: true },
      { from: 'analysis', to: 'populations', label: 'Cell identities' },
      { from: 'analysis', to: 'programs', label: 'Functional signals' },
    ],
  },
  'causal-pathways': {
    title: 'Causal pathways and confounding',
    subtitle: 'Illustrative directed acyclic graph. The arrows encode stated assumptions about causality; observed associations alone do not establish them.',
    direction: 'DOWN',
    theme: 'ocean',
    nodes: [
      { id: 'baseline', label: 'Baseline factors', description: 'Common causes of treatment and outcome', fill: '#DCECF3' },
      { id: 'treatment', label: 'Treatment', description: 'Exposure or intervention', fill: '#1F5B73' },
      { id: 'mediator', label: 'Mediator', description: 'Intermediate response', fill: '#E4F0EA' },
      { id: 'outcome', label: 'Outcome', description: 'Measured endpoint', fill: '#DCECF3' },
    ],
    edges: [
      { from: 'baseline', to: 'treatment' },
      { from: 'baseline', to: 'outcome', label: 'Confounding path', dashed: true },
      { from: 'treatment', to: 'mediator', label: 'Indirect pathway' },
      { from: 'mediator', to: 'outcome' },
      { from: 'treatment', to: 'outcome', label: 'Direct pathway' },
    ],
  },
} satisfies Record<string, DiagramSpec>;
