import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode, ElkPoint, ElkPort } from 'elkjs/lib/elk-api';
import { sceneSchema, type Layer, type Scene } from './engine.ts';
import { measureText, textMetrics, wrapText, type TextStyle } from './typography.ts';
import { diagramSchema, type Diagram, type DiagramSpec } from './diagram-schema.ts';
export { diagramSchema, type DiagramSpec } from './diagram-schema.ts';

type DiagramNode = Diagram['nodes'][number];

const palettes = {
  paper: { background: '#FAF8F2', surface: '#FFFFFF', ink: '#253844', muted: '#566773', border: '#BCC9CB', edge: '#596F7A' },
  ocean: { background: '#EFF6F9', surface: '#FFFFFF', ink: '#163F59', muted: '#46687B', border: '#ACCAD8', edge: '#4B748A' },
  monochrome: { background: '#FFFFFF', surface: '#FFFFFF', ink: '#242424', muted: '#585858', border: '#AAAAAA', edge: '#656565' },
};

const labelStyle: TextStyle = { fontFamily: 'Source Sans 3', fontSize: 17, fontWeight: 700 };
const descriptionStyle: TextStyle = { fontFamily: 'Source Sans 3', fontSize: 13, fontWeight: 400 };
const edgeStyle: TextStyle = { fontFamily: 'Source Sans 3', fontSize: 12, fontWeight: 400 };
const labelLineHeight = 1.35;
const descriptionLineHeight = 1.45;

function blockHeight(lines: string[], style: TextStyle, lineHeight: number) {
  if (!lines.length) return 0;
  const metrics = textMetrics(style);
  return metrics.ascent + metrics.descent + Math.max(0, lines.length - 1) * style.fontSize * lineHeight;
}

function prepareNode(node: DiagramNode) {
  const width = node.width ?? (node.shape === 'diamond' ? 268 : node.shape === 'ellipse' ? 236 : 216);
  const textWidth = node.shape === 'diamond' ? width * 0.49 : node.shape === 'ellipse' ? width * 0.65 : width - 40;
  const title = wrapText(node.label, { ...labelStyle, maxWidth: textWidth });
  const description = node.description ? wrapText(node.description, { ...descriptionStyle, maxWidth: textWidth }) : [];
  const contentHeight = blockHeight(title, labelStyle, labelLineHeight)
    + (description.length ? 8 + blockHeight(description, descriptionStyle, descriptionLineHeight) : 0);
  const height = Math.ceil(node.shape === 'diamond' ? Math.max(120, contentHeight * 2.15 + 24)
    : node.shape === 'ellipse' ? Math.max(112, contentHeight * 1.6 + 28) : Math.max(88, contentHeight + 36));
  return { node, width, height, title, description, contentHeight };
}

function nodePorts(prepared: ReturnType<typeof prepareNode>, edgeIds: string[], outgoing: boolean, direction: Diagram['direction']): ElkPort[] {
  const { width, height } = prepared;
  return edgeIds.map((edgeId, index) => {
    // Distinct ports preserve individual causal relationships instead of merging arrows into a shared trunk.
    const fraction = (index + 1) / (edgeIds.length + 1);
    const offset = (fraction - 0.5) * 0.8;
    const side = direction === 'RIGHT' ? (outgoing ? 'EAST' : 'WEST') : outgoing ? 'SOUTH' : 'NORTH';
    return {
      id: `edge:${edgeId}:${outgoing ? 'out' : 'in'}`,
      x: direction === 'RIGHT' ? (outgoing ? width : 0) : width * (0.5 + offset),
      y: direction === 'RIGHT' ? height * (0.5 + offset) : outgoing ? height : 0,
      layoutOptions: { 'elk.port.side': side },
    };
  });
}

function colorLuminance(hex: string) {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function textOnFill(fill: string, normal: string) {
  const background = colorLuminance(fill);
  const foreground = colorLuminance(normal);
  const ratio = (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
  return ratio >= 4.5 ? normal : (background + 0.05) / 0.05 >= 1.05 / (background + 0.05) ? '#000000' : '#FFFFFF';
}

function textLayer(id: string, name: string, content: string, x: number, y: number, fill: string, style: TextStyle, lineHeight = 1.35): Extract<Layer, { kind: 'text' }> {
  return { id, name, kind: 'text', visible: true, text: content, x, y, fill, align: 'center', lineHeight, ...style };
}

function pathLayer(id: string, name: string, points: ElkPoint[], color: string, dashed: boolean): Layer {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    id, name, kind: 'path', visible: true,
    d: points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' '),
    fill: 'none', stroke: color, strokeWidth: 1.65, strokeLinecap: 'round',
    strokeDasharray: dashed ? [6, 5] : undefined, markerEnd: 'arrow',
    bounds: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
  };
}

function shapeEndpoint(positioned: ElkNode, node: DiagramNode, endpoint: ElkPoint, outgoing: boolean, direction: Diagram['direction']): ElkPoint {
  if (node.shape === 'rect') return endpoint;
  const horizontal = direction === 'RIGHT';
  const fraction = horizontal ? (endpoint.y - positioned.y!) / positioned.height! : (endpoint.x - positioned.x!) / positioned.width!;
  const offset = Math.max(-0.5, Math.min(0.5, fraction - 0.5));
  const inset = node.shape === 'ellipse' ? (1 - Math.sqrt(1 - (offset * 2) ** 2)) / 2 : Math.abs(offset);
  return horizontal
    ? { x: positioned.x! + positioned.width! * (outgoing ? 1 - inset : inset), y: endpoint.y }
    : { x: endpoint.x, y: positioned.y! + positioned.height! * (outgoing ? 1 - inset : inset) };
}

export async function composeDiagram(input: DiagramSpec): Promise<Scene> {
  const specification = diagramSchema.parse(input);
  const palette = palettes[specification.theme];
  const prepared = specification.nodes.map(prepareNode);
  const preparedById = new Map(prepared.map((node) => [node.node.id, node]));
  const identifiedEdges = specification.edges.map((edge, index) => ({ ...edge, id: edge.id ?? `auto-${index + 1}` }));
  const edgesById = new Map(identifiedEdges.map((edge) => [`edge:${edge.id}`, edge]));
  const children: ElkNode[] = prepared.map((preparedNode) => ({
    id: preparedNode.node.id, width: preparedNode.width, height: preparedNode.height,
    layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
    ports: [
      ...nodePorts(preparedNode, identifiedEdges.filter((edge) => edge.to === preparedNode.node.id).map((edge) => edge.id), false, specification.direction),
      ...nodePorts(preparedNode, identifiedEdges.filter((edge) => edge.from === preparedNode.node.id).map((edge) => edge.id), true, specification.direction),
    ],
  }));
  const edges: ElkExtendedEdge[] = identifiedEdges.map((edge) => {
    const { id } = edge;
    const lines = edge.label ? wrapText(edge.label, { ...edgeStyle, maxWidth: 160 }) : [];
    return {
      id: `edge:${id}`, sources: [`edge:${id}:out`], targets: [`edge:${id}:in`],
      labels: lines.length ? [{
        id: `${id}:label`, text: lines.join('\n'),
        width: Math.ceil(Math.max(...lines.map((line) => measureText(line, edgeStyle)))) + 16,
        height: Math.ceil(blockHeight(lines, edgeStyle, 1.35)) + 10,
      }] : undefined,
    };
  });

  const elk = new ELK();
  const graph: ElkNode = await elk.layout({
    id: 'graph:diagram', children, edges,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': specification.direction,
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=16,left=16,bottom=16,right=16]',
      'elk.spacing.nodeNode': '52',
      'elk.spacing.edgeNode': '28',
      'elk.spacing.edgeEdge': '20',
      'elk.spacing.componentComponent': '64',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.layered.spacing.edgeNodeBetweenLayers': '28',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
      'elk.randomSeed': '1',
    },
  });

  const padding = specification.padding;
  const width = Math.ceil(Math.max(640, (graph.width ?? 0) + padding * 2));
  const titleStyle: TextStyle = { fontFamily: 'Source Sans 3', fontSize: 30, fontWeight: 700 };
  const subtitleStyle: TextStyle = { fontFamily: 'Source Sans 3', fontSize: 14, fontWeight: 400 };
  const titleLines = specification.title ? wrapText(specification.title, { ...titleStyle, maxWidth: width - padding * 2 }) : [];
  const subtitleLines = specification.subtitle ? wrapText(specification.subtitle, { ...subtitleStyle, maxWidth: width - padding * 2 }) : [];
  const titleHeight = blockHeight(titleLines, titleStyle, 1.25);
  const subtitleHeight = blockHeight(subtitleLines, subtitleStyle, 1.5);
  const headerHeight = titleHeight + subtitleHeight + (titleLines.length && subtitleLines.length ? 12 : 0)
    + (titleLines.length || subtitleLines.length ? 48 : 0);
  const height = Math.ceil(Math.max(300, (graph.height ?? 0) + padding * 2 + headerHeight));
  if (width > 8192 || height > 8192) throw new Error('This graph exceeds the 8192 px artboard limit. Use fewer nodes or shorter labels.');
  const offset = { x: (width - (graph.width ?? 0)) / 2, y: padding + headerHeight };
  const layers: Layer[] = [];
  const positions = new Map((graph.children ?? []).map((node) => [node.id, node]));

  if (titleLines.length) {
    const title = textLayer('figure-title', 'Figure title', titleLines.join('\n'), padding, padding + textMetrics(titleStyle).ascent, palette.ink, titleStyle, 1.25);
    layers.push({ ...title, align: 'left' });
  }
  if (subtitleLines.length) {
    const subtitle = textLayer('figure-subtitle', 'Figure caption', subtitleLines.join('\n'), padding,
      padding + titleHeight + (titleLines.length ? 12 : 0) + textMetrics(subtitleStyle).ascent, palette.muted, subtitleStyle, 1.5);
    layers.push({ ...subtitle, align: 'left' });
  }

  for (const edge of graph.edges ?? []) {
    const source = edgesById.get(edge.id)!;
    if (!edge.sections?.length) throw new Error(`Layout did not produce a route for edge ${edge.id}.`);
    for (const [sectionIndex, section] of edge.sections.entries()) {
      // ELK routes to rectangular node boxes. Extend terminals onto curved/sloping shape boundaries.
      const start = shapeEndpoint(positions.get(source.from)!, preparedById.get(source.from)!.node, section.startPoint, true, specification.direction);
      const end = shapeEndpoint(positions.get(source.to)!, preparedById.get(source.to)!.node, section.endPoint, false, specification.direction);
      const points = [start, section.startPoint, ...(section.bendPoints ?? []), section.endPoint, end]
        .filter((point, index, all) => !index || point.x !== all[index - 1].x || point.y !== all[index - 1].y)
        .map((point) => ({ x: point.x + offset.x, y: point.y + offset.y }));
      layers.push(pathLayer(`edge-${source.id}-${sectionIndex}`, `${source.from} → ${source.to}`, points, palette.edge, source.dashed));
    }
    for (const [labelIndex, label] of (edge.labels ?? []).entries()) {
      const x = (label.x ?? 0) + offset.x;
      const y = (label.y ?? 0) + offset.y;
      const labelWidth = label.width ?? 0;
      const labelHeight = label.height ?? 0;
      layers.push({ id: `edge-${source.id}-label-bg-${labelIndex}`, name: `Label background for ${source.from} → ${source.to}`, kind: 'rect', visible: true,
        x, y, width: labelWidth, height: labelHeight, fill: palette.background, rx: 4 });
      layers.push(textLayer(`edge-${source.id}-label-${labelIndex}`, `Label for ${source.from} → ${source.to}`, label.text ?? '',
        x + labelWidth / 2, y + 5 + textMetrics(edgeStyle).ascent, palette.muted, edgeStyle));
    }
  }

  for (const positioned of graph.children ?? []) {
    const preparedNode = preparedById.get(positioned.id)!;
    const { node, title, description, contentHeight } = preparedNode;
    const x = (positioned.x ?? 0) + offset.x;
    const y = (positioned.y ?? 0) + offset.y;
    const nodeWidth = positioned.width!;
    const nodeHeight = positioned.height!;
    const fill = node.fill ?? palette.surface;
    const stroke = node.stroke ?? palette.border;
    const common = { id: `node-${node.id}-body`, name: node.label, visible: true, fill, stroke, strokeWidth: 1.35 };
    if (node.shape === 'ellipse') {
      layers.push({ ...common, kind: 'ellipse', x: x + nodeWidth / 2, y: y + nodeHeight / 2, rx: nodeWidth / 2, ry: nodeHeight / 2 });
    } else if (node.shape === 'diamond') {
      layers.push({ ...common, kind: 'path', d: `M ${x + nodeWidth / 2} ${y} L ${x + nodeWidth} ${y + nodeHeight / 2} L ${x + nodeWidth / 2} ${y + nodeHeight} L ${x} ${y + nodeHeight / 2} Z`,
        bounds: { x, y, width: nodeWidth, height: nodeHeight } });
    } else {
      layers.push({ ...common, kind: 'rect', x, y, width: nodeWidth, height: nodeHeight, rx: 10 });
    }
    const contentTop = y + (nodeHeight - contentHeight) / 2;
    const centerX = x + nodeWidth / 2;
    layers.push(textLayer(`node-${node.id}-label`, `${node.label} label`, title.join('\n'), centerX,
      contentTop + textMetrics(labelStyle).ascent, textOnFill(fill, palette.ink), labelStyle, labelLineHeight));
    if (description.length) {
      layers.push(textLayer(`node-${node.id}-description`, `${node.label} description`, description.join('\n'), centerX,
        contentTop + blockHeight(title, labelStyle, labelLineHeight) + 8 + textMetrics(descriptionStyle).ascent,
        textOnFill(fill, palette.muted), descriptionStyle, descriptionLineHeight));
    }
  }

  return sceneSchema.parse({ name: specification.title || 'Untitled diagram', width, height, background: palette.background, layers,
    provenance: { generator: 'diagram', input: specification } });
}
