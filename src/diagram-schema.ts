import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,48}$/).describe('Stable identifier used by edges and generated layer IDs.');
const color = z.string().regex(/^#[\da-fA-F]{6}$/);

const nodeSchema = z.strictObject({
  id: identifier,
  label: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500).optional(),
  shape: z.enum(['rect', 'ellipse', 'diamond']).default('rect'),
  fill: color.optional(),
  stroke: color.optional(),
  width: z.number().min(140).max(480).optional(),
});

const edgeSchema = z.strictObject({
  id: identifier.optional(),
  from: identifier,
  to: identifier,
  label: z.string().trim().max(160).optional(),
  dashed: z.boolean().default(false),
});

export const diagramSchema = z.strictObject({
  title: z.string().trim().max(200).optional(),
  subtitle: z.string().trim().max(600).optional(),
  direction: z.enum(['RIGHT', 'DOWN']).default('RIGHT'),
  theme: z.enum(['paper', 'ocean', 'monochrome']).default('paper')
    .describe('paper: warm ivory with slate ink; ocean: pale blue with navy ink; monochrome: white with neutral ink.'),
  padding: z.number().int().min(28).max(160).default(48),
  nodes: z.array(nodeSchema).min(1).max(60),
  edges: z.array(edgeSchema).max(120).default([]),
}).superRefine((diagram, context) => {
  const ids = new Set<string>();
  diagram.nodes.forEach((node, index) => {
    if (ids.has(node.id)) context.addIssue({ code: 'custom', path: ['nodes', index, 'id'], message: 'Node identifiers must be unique.' });
    ids.add(node.id);
  });
  const edgeIds = new Set<string>();
  diagram.edges.forEach((edge, index) => {
    const id = edge.id ?? `auto-${index + 1}`;
    if (edgeIds.has(id)) context.addIssue({ code: 'custom', path: ['edges', index, 'id'], message: 'Edge identifiers must be unique, including generated auto-N identifiers.' });
    edgeIds.add(id);
    for (const endpoint of ['from', 'to'] as const) {
      if (!ids.has(edge[endpoint])) context.addIssue({ code: 'custom', path: ['edges', index, endpoint], message: `Unknown node ${edge[endpoint]}.` });
    }
  });
});

export type DiagramSpec = z.input<typeof diagramSchema>;
export type Diagram = z.output<typeof diagramSchema>;
