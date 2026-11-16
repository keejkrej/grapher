import { z } from 'zod'
import { SVGPathData } from 'svg-pathdata'
import { diagramSchema } from './diagram-schema.ts'
import { plotSchema } from './plot-schema.ts'
import { measureText, missingGlyphs, needsComplexShaping, normalizeFontFamily, textInkBounds, textMetrics, textOutline, wrapText } from './typography.ts'

const number = z.number().finite()
const text = z.string().max(300)
const paint = z.string().max(160)
const boxSchema = z.strictObject({ x: number, y: number, width: number, height: number })
const layerFields = {
  id: z.string().min(1).max(100),
  name: text,
  visible: z.boolean().default(true),
  opacity: number.min(0).max(1).optional(),
  rotationDeg: number.optional().describe('Rotation about the layer center, in degrees.'),
}
const strokeFields = {
  stroke: paint.optional(), strokeWidth: number.optional(),
  strokeDasharray: z.array(number.min(0)).min(1).max(20).optional(),
  strokeLinecap: z.enum(['butt', 'round', 'square']).optional(),
}
const layerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...layerFields, ...boxSchema.shape, ...strokeFields, kind: z.literal('rect'), fill: paint, rx: number.optional() }),
  z.strictObject({
    ...layerFields,
    ...strokeFields,
    kind: z.literal('ellipse'),
    x: number.describe('Horizontal position of the center.'),
    y: number.describe('Vertical position of the center.'),
    rx: number,
    ry: number,
    fill: paint,
  }),
  z.strictObject({
    ...layerFields,
    kind: z.literal('text'),
    x: number,
    y: number.describe('Text baseline, in pixels.'),
    text: z.string().max(2000),
    fontSize: number,
    fill: paint,
    fontFamily: z.string().max(160).optional(),
    fontWeight: z.union([z.number().int().min(1).max(1000), z.enum(['normal', 'bold']), z.string().regex(/^[1-9]00$/)]).optional(),
    align: z.enum(['left', 'center', 'right', 'start', 'middle', 'end']).optional(),
    maxWidth: number.positive().optional().describe('Wrap text to this width in pixels.'),
    lineHeight: number.positive().max(10).optional().describe('Line spacing as a multiplier of font size; defaults to 1.2.'),
    letterSpacing: number.optional().describe('Additional space between glyphs in pixels.'),
  }),
  z.strictObject({
    ...layerFields,
    ...strokeFields,
    kind: z.literal('path'),
    d: z.string().max(50000),
    fill: paint,
    bounds: boxSchema.describe('Expected path bounds before translation and stroke expansion.'),
    offsetX: number.optional(),
    offsetY: number.optional(),
    markerStart: z.enum(['arrow', 'circle']).optional(),
    markerEnd: z.enum(['arrow', 'circle']).optional(),
  }),
  z.strictObject({
    ...layerFields,
    ...boxSchema.shape,
    kind: z.literal('raster'),
    src: z.string().max(8_000_000).describe('Embedded PNG or JPEG base64 data URL.'),
    fit: z.enum(['contain', 'cover', 'stretch']).optional(),
  }),
  z.strictObject({
    ...layerFields,
    ...boxSchema.shape,
    kind: z.literal('mesh'),
    shape: z.enum(['cube', 'sphere', 'torus']),
    color: paint,
    rotation: number.describe('Y-axis rotation in degrees.'),
  }),
])

const gradientFields = {
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/),
  stops: z.array(z.strictObject({ offset: number.min(0).max(1), color: paint, opacity: number.min(0).max(1).optional() })).min(2).max(32),
}
export const gradientSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...gradientFields, kind: z.literal('linear'), x1: number, y1: number, x2: number, y2: number }),
  z.strictObject({ ...gradientFields, kind: z.literal('radial'), cx: number, cy: number, r: number.positive() }),
])

export const sceneSchema = z.strictObject({
  name: text,
  width: number,
  height: number,
  background: paint,
  layers: z.array(layerSchema).max(750),
  gradients: z.array(gradientSchema).max(100).optional(),
  provenance: z.discriminatedUnion('generator', [
    z.strictObject({ generator: z.literal('diagram'), input: diagramSchema }),
    z.strictObject({ generator: z.literal('plot'), input: plotSchema }),
  ]).optional().describe('Validated source input at generation time. Subsequent layer edits do not rewrite this snapshot.'),
})

export const operationSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), layer: layerSchema }),
  z.strictObject({ op: z.literal('replace'), id: layerFields.id, layer: layerSchema }),
  z.strictObject({ op: z.literal('remove'), id: layerFields.id }),
  z.strictObject({ op: z.literal('move'), id: layerFields.id, x: number, y: number }),
  z.strictObject({ op: z.literal('update'), id: layerFields.id, patch: z.record(z.string(), z.unknown()) }),
  z.strictObject({ op: z.literal('reorder'), id: layerFields.id, index: z.number().int().min(0).describe('Final zero-based position in back-to-front layer order.') }),
  z.strictObject({ op: z.literal('gradients'), gradients: z.array(gradientSchema).max(100) }),
  z.strictObject({ op: z.literal('canvas'), name: text.optional(), width: number.optional(), height: number.optional(), background: paint.optional() }),
])

export const operationLimit = 150

export type Scene = z.infer<typeof sceneSchema>
export type Layer = z.infer<typeof layerSchema>
export type Operation = z.infer<typeof operationSchema>
type Box = z.infer<typeof boxSchema>
type TextLayer = Extract<Layer, { kind: 'text' }>
type MeshLayer = Extract<Layer, { kind: 'mesh' }>
type RGB = [number, number, number]

const canvasLimit = 8192
const gradientReference = /^url\(#([a-zA-Z][a-zA-Z0-9_.-]{0,99})\)$/
const pathBoundsCache = new Map<string, Box | undefined>()

function rgb(color: string): RGB | undefined {
  if (color.toLowerCase() === 'white') return [255, 255, 255]
  if (color.toLowerCase() === 'black') return [0, 0, 0]
  const hex = color.match(/^#([a-f\d]{3}|[a-f\d]{6})$/i)?.[1]
  if (!hex) return undefined
  const full = hex.length === 3 ? [...hex].map((digit) => digit.repeat(2)).join('') : hex
  return [0, 2, 4].map((index) => Number.parseInt(full.slice(index, index + 2), 16)) as RGB
}

function validPaint(color: string): boolean {
  return color === 'none' || color === 'transparent' || rgb(color) !== undefined || gradientReference.test(color)
}

function validRaster(source: string): boolean {
  const match = source.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/)
  if (!match || match[2].length % 4 !== 0) return false
  try {
    const bytes = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0))
    if (match[1] === 'jpeg') {
      return bytes.length > 100 && bytes[0] === 0xff && bytes[1] === 0xd8
        && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
    }
    if (bytes.length < 57 || [137, 80, 78, 71, 13, 10, 26, 10].some((value, index) => bytes[index] !== value)) return false
    const data = new DataView(bytes.buffer)
    let offset = 8
    let hasImage = false
    while (offset + 12 <= bytes.length) {
      const length = data.getUint32(offset)
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
      if (length > bytes.length - offset - 12) return false
      if (offset === 8 && (type !== 'IHDR' || length !== 13 || !data.getUint32(16) || !data.getUint32(20))) return false
      if (type === 'IDAT' && length) hasImage = true
      if (type === 'IEND') return length === 0 && hasImage && offset + 12 === bytes.length
      offset += length + 12
    }
    return false
  } catch {
    return false
  }
}

function textAnchor(layer: TextLayer): 'start' | 'middle' | 'end' {
  if (layer.align === 'center' || layer.align === 'middle') return 'middle'
  if (layer.align === 'right' || layer.align === 'end') return 'end'
  return 'start'
}

function pathBounds(d: string): Box | undefined {
  if (pathBoundsCache.has(d)) return pathBoundsCache.get(d)
  let box: Box | undefined
  try {
    const path = new SVGPathData(d)
    if (path.commands.some((command) => command.type !== SVGPathData.MOVE_TO && command.type !== SVGPathData.CLOSE_PATH)) {
      const { minX, minY, maxX, maxY } = path.getBounds()
      if ([minX, minY, maxX, maxY].every(Number.isFinite)) box = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    }
  } catch { /* Malformed path data is reported by verification. */ }
  if (pathBoundsCache.size >= 512) pathBoundsCache.delete(pathBoundsCache.keys().next().value!)
  pathBoundsCache.set(d, box)
  return box
}

export function textLayout(layer: TextLayer) {
  const anchor = textAnchor(layer)
  return wrapText(layer.text, layer).map((text, index) => {
    const width = measureText(text, layer)
    const offset = anchor === 'middle' ? width / 2 : anchor === 'end' ? width : 0
    return { text, x: layer.x - offset, y: layer.y + layer.fontSize * (layer.lineHeight ?? 1.2) * index, width }
  })
}

function strokePadding(layer: Layer) {
  return 'stroke' in layer && layer.stroke && layer.stroke !== 'none' && layer.stroke !== 'transparent' ? (layer.strokeWidth ?? 1) / 2 : 0
}

function rawLayerBounds(layer: Layer): Box {
  switch (layer.kind) {
    case 'ellipse': {
      const padding = strokePadding(layer)
      return { x: layer.x - layer.rx - padding, y: layer.y - layer.ry - padding, width: (layer.rx + padding) * 2, height: (layer.ry + padding) * 2 }
    }
    case 'text': {
      const boxes = textLayout(layer).map((line) => {
        const ink = textInkBounds(line.text, layer)
        return { x: line.x + ink.x, y: line.y + ink.y, width: ink.width, height: ink.height }
      })
      const x = Math.min(...boxes.map((box) => box.x))
      const y = Math.min(...boxes.map((box) => box.y))
      return { x, y, width: Math.max(...boxes.map((box) => box.x + box.width)) - x, height: Math.max(...boxes.map((box) => box.y + box.height)) - y }
    }
    case 'path': {
      const { x, y, width, height } = pathBounds(layer.d) ?? layer.bounds
      const marker = layer.markerStart || layer.markerEnd ? Math.max(6, (layer.strokeWidth ?? 1) * 4) : 0
      const padding = Math.max(strokePadding(layer), marker)
      return { x: x + (layer.offsetX ?? 0) - padding, y: y + (layer.offsetY ?? 0) - padding, width: width + padding * 2, height: height + padding * 2 }
    }
    default:
      return { x: layer.x - strokePadding(layer), y: layer.y - strokePadding(layer), width: layer.width + 2 * strokePadding(layer), height: layer.height + 2 * strokePadding(layer) }
  }
}

export function layerBounds(layer: Layer): Box {
  const box = rawLayerBounds(layer)
  if (!layer.rotationDeg) return box
  const angle = layer.rotationDeg * Math.PI / 180
  const width = Math.abs(box.width * Math.cos(angle)) + Math.abs(box.height * Math.sin(angle))
  const height = Math.abs(box.width * Math.sin(angle)) + Math.abs(box.height * Math.cos(angle))
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height }
}

type Issue = { id: string; checkId: string; layerId?: string; message: string; fixable: boolean; severity: 'error' | 'warning' }
type Check = { id: string; label: string; status: 'pass' | 'fail' | 'warn'; detail: string }
export type VerificationReport = { checks: Check[]; issues: Issue[]; passed: number; total: number }

const checkDefinitions: ReadonlyArray<{ id: string; label: string; detail: string }> = [
  { id: 'canvas', label: 'Canvas dimensions', detail: 'The artboard has supported dimensions and a valid background.' },
  { id: 'bounds', label: 'Layer bounds', detail: 'Visible layer bounds fit inside the artboard using parsed paths and font metrics.' },
  { id: 'contrast', label: 'Text contrast', detail: 'Text meets contrast thresholds against sampled flat-color backgrounds.' },
  { id: 'labels', label: 'Layer names', detail: 'The artboard and every layer have names.' },
  { id: 'assets', label: 'Raster references', detail: 'Embedded raster containers have valid structure; the export preflight decodes their content.' },
  { id: 'geometry', label: 'Shape geometry', detail: 'Layer dimensions and paints are valid.' },
  { id: 'visibility', label: 'Visible content', detail: 'The artboard contains visible layers.' },
  { id: 'unique', label: 'Unique layer IDs', detail: 'Each layer has a unique identifier.' },
]

function validDimension(dimension: number): boolean {
  return Number.isInteger(dimension) && dimension >= 1 && dimension <= canvasLimit
}

function geometryProblem(layer: Layer): string | undefined {
  if ('fill' in layer && !validPaint(layer.fill)) return 'uses an unsupported fill color'
  if ('stroke' in layer && layer.stroke && !validPaint(layer.stroke)) return 'uses an unsupported stroke color'
  if ('strokeWidth' in layer && (layer.strokeWidth ?? 1) < 0) return 'has a negative stroke width'
  if ('width' in layer && (layer.width <= 0 || layer.height <= 0)) return 'needs a positive width and height'

  switch (layer.kind) {
    case 'rect':
      return (layer.rx ?? 0) < 0 ? 'has a negative corner radius' : undefined
    case 'ellipse':
      return layer.rx <= 0 || layer.ry <= 0 ? 'needs positive radii' : undefined
    case 'text':
      return layer.fontSize <= 0 || !layer.text.trim() ? 'needs text and a positive font size' : undefined
    case 'path':
      return !pathBounds(layer.d) || layer.bounds.width < 0 || layer.bounds.height < 0 ? 'has invalid or empty path data or bounds' : undefined
    case 'mesh':
      return !rgb(layer.color) ? 'uses an unsupported surface color' : undefined
    default:
      return undefined
  }
}

function outOfBounds(scene: Scene, box: Box): boolean {
  const tolerance = 0.01
  return box.x < -tolerance || box.y < -tolerance || box.x + box.width > scene.width + tolerance || box.y + box.height > scene.height + tolerance
}

function luminance(color: RGB): number {
  const [r, g, b] = color.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(foreground: RGB, background: RGB): number {
  const values = [luminance(foreground), luminance(background)]
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05)
}

function backdropAt(scene: Scene, index: number): RGB | undefined {
  const box = layerBounds(scene.layers[index])
  const corners = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]
  for (let i = index - 1; i >= 0; i--) {
    const layer = scene.layers[i]
    if (!layer.visible || layer.opacity === 0 || layer.kind === 'text') continue
    const under = layerBounds(layer)
    if (box.x + box.width < under.x || box.y + box.height < under.y || box.x > under.x + under.width || box.y > under.y + under.height) continue
    if ('fill' in layer && (layer.fill === 'none' || layer.fill === 'transparent')) continue
    if (layer.rotationDeg || (layer.opacity ?? 1) < 1) return undefined

    if (layer.kind === 'ellipse') {
      if (!corners.every(([x, y]) => ((x - layer.x) / layer.rx) ** 2 + ((y - layer.y) / layer.ry) ** 2 <= 1)) return undefined
      const fill = rgb(layer.fill)
      if (fill) return fill
      if (gradientReference.test(layer.fill)) return undefined
    } else if (layer.kind === 'rect') {
      const radius = Math.min(layer.rx ?? 0, layer.width / 2, layer.height / 2)
      if (!corners.every(([x, y]) => {
        const dx = x - Math.min(Math.max(x, layer.x + radius), layer.x + layer.width - radius)
        const dy = y - Math.min(Math.max(y, layer.y + radius), layer.y + layer.height - radius)
        return dx * dx + dy * dy <= radius * radius
      })) return undefined
      const fill = rgb(layer.fill)
      if (fill) return fill
      if (gradientReference.test(layer.fill)) return undefined
    } else if (layer.kind !== 'path' || (layer.fill !== 'none' && layer.fill !== 'transparent')) {
      return undefined
    }
  }
  return rgb(scene.background)
}

export function verifyScene(scene: Scene): VerificationReport {
  const issues: Issue[] = []
  const record = (checkId: string, message: string, fixable: boolean, layerId?: string, severity: Issue['severity'] = 'error') => {
    const key = `${checkId}:${layerId ?? 'scene'}`
    const existing = issues.filter((issue) => issue.id === key || issue.id.startsWith(`${key}#`)).length
    issues.push({ id: existing ? `${key}#${existing + 1}` : key, checkId, ...(layerId && { layerId }), message, fixable, severity })
  }

  if (!validDimension(scene.width) || !validDimension(scene.height) || (!rgb(scene.background) && scene.background !== 'transparent' && scene.background !== 'none')) {
    record('canvas', `Use whole-pixel dimensions between 1 and ${canvasLimit} and a solid or transparent background.`, true)
  }
  if (!scene.name.trim()) record('labels', 'Give the artboard a name.', true)
  if (!scene.layers.some((layer) => layer.visible && layer.opacity !== 0)) record('visibility', 'The artboard has no visible layers.', scene.layers.length > 0)

  const gradients = new Set<string>()
  for (const gradient of scene.gradients ?? []) {
    if (gradients.has(gradient.id)) record('unique', `Gradient ID “${gradient.id}” is already in use.`, false)
    gradients.add(gradient.id)
    if (gradient.stops.some((stop) => !rgb(stop.color))) record('geometry', `Gradient “${gradient.id}” has an invalid stop color.`, false)
    if (gradient.stops.some((stop, index) => index > 0 && stop.offset < gradient.stops[index - 1].offset)) {
      record('geometry', `Gradient “${gradient.id}” stops must be ordered by offset.`, false)
    }
  }

  const layerIds = new Set<string>()
  scene.layers.forEach((layer, index) => {
    const name = layer.name.trim() || layer.id
    if (layerIds.has(layer.id)) record('unique', `Layer ID “${layer.id}” is already in use.`, false, layer.id)
    layerIds.add(layer.id)
    if (!layer.name.trim()) record('labels', `Layer “${layer.id}” has no name.`, true, layer.id)
    if (layer.kind === 'raster' && !validRaster(layer.src)) record('assets', `“${name}” needs a complete embedded PNG or JPEG image.`, false, layer.id)
    const problem = geometryProblem(layer)
    if (problem) record('geometry', `“${name}” ${problem}.`, false, layer.id)
    for (const color of ['fill' in layer ? layer.fill : '', 'stroke' in layer ? layer.stroke ?? '' : '']) {
      const reference = color.match(gradientReference)?.[1]
      if (reference && !gradients.has(reference)) record('geometry', `“${name}” references missing gradient “${reference}”.`, false, layer.id)
    }
    if (!layer.visible || layer.opacity === 0 || problem) return

    const box = layerBounds(layer)
    if (validDimension(scene.width) && validDimension(scene.height) && outOfBounds(scene, box)) {
      record('bounds', `“${name}” extends outside the artboard.`, box.width <= scene.width && box.height <= scene.height, layer.id)
    }
    if (layer.kind !== 'text') return
    if (!textMetrics(layer).measured) {
      record('bounds', `“${name}” uses estimated text bounds because its bundled font has not loaded.`, false, layer.id, 'warning')
    }
    const missing = missingGlyphs(layer.text, layer)
    if (missing.length) record('geometry', `“${name}” uses glyphs absent from ${normalizeFontFamily(layer.fontFamily)}: ${missing.join(' ')}.`, false, layer.id)
    if (needsComplexShaping(layer.text)) {
      record('geometry', `“${name}” needs text shaping review: combining marks or bidirectional scripts exceed the portable renderer's simple glyph layout.`, false, layer.id, 'warning')
    }

    const background = backdropAt(scene, index)
    const foreground = rgb(layer.fill)
    if (!background || !foreground || (layer.opacity ?? 1) < 1) {
      record('contrast', `“${name}” needs rendered contrast review because its paint or background cannot be sampled as a solid color.`, false, layer.id, 'warning')
      return
    }
    const ratio = contrast(foreground, background)
    const bold = layer.fontWeight === 'bold' || Number(layer.fontWeight) >= 700
    const minimum = layer.fontSize >= 24 || (bold && layer.fontSize >= 18.66) ? 3 : 4.5
    if (ratio < minimum) {
      record('contrast', `“${name}” has ${ratio.toFixed(2)}:1 contrast against its solid backdrop and needs ${minimum}:1.`, true, layer.id)
    }
  })

  const checks = checkDefinitions.map<Check>((definition) => {
    const findings = issues.filter((issue) => issue.checkId === definition.id)
    const status = findings.some((issue) => issue.severity === 'error') ? 'fail' : findings.length ? 'warn' : 'pass'
    const detail = findings.length ? `${findings.length} ${status === 'warn' ? 'review items' : 'issues'} found.` : definition.detail
    return { ...definition, status, detail }
  })
  return { checks, issues, passed: checks.filter((check) => check.status === 'pass').length, total: checks.length }
}

function moveLayer(layer: Layer, x: number, y: number): Layer {
  if (layer.kind === 'path') {
    return {
      ...layer,
      offsetX: x - layer.bounds.x,
      offsetY: y - layer.bounds.y,
    }
  }
  return { ...layer, x, y }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function repairScene(original: Scene): { scene: Scene; report: VerificationReport; changes: string[] } {
  const scene = { ...original, layers: [...original.layers] }
  const changes: string[] = []

  if (!validDimension(scene.width) || !validDimension(scene.height)) {
    scene.width = clamp(Math.round(scene.width), 1, canvasLimit)
    scene.height = clamp(Math.round(scene.height), 1, canvasLimit)
    changes.push(`Set the artboard dimensions to ${scene.width} × ${scene.height}.`)
  }
  if (!rgb(scene.background) && scene.background !== 'none' && scene.background !== 'transparent') {
    scene.background = '#ffffff'
    changes.push('Set the artboard background to white.')
  }
  if (!scene.name.trim()) {
    scene.name = 'Untitled artboard'
    changes.push('Named the artboard.')
  }
  const first = scene.layers[0]
  if (first && !scene.layers.some((layer) => layer.visible && layer.opacity !== 0)) {
    scene.layers[0] = { ...first, visible: true, opacity: first.opacity === 0 ? 1 : first.opacity }
    changes.push(`Showed “${first.name || first.id}”.`)
  }

  // Establish the final geometry before evaluating text against its backdrop.
  scene.layers = scene.layers.map((layer, index) => {
    if (!layer.name.trim()) {
      const name = `${layer.kind[0].toUpperCase()}${layer.kind.slice(1)} ${index + 1}`
      layer = { ...layer, name }
      changes.push(`Named “${layer.id}” ${name}.`)
    }
    if (!layer.visible || geometryProblem(layer)) return layer
    const box = layerBounds(layer)
    if (outOfBounds(scene, box) && box.width <= scene.width && box.height <= scene.height) {
      const anchor = layer.kind === 'path'
        ? { x: layer.bounds.x + (layer.offsetX ?? 0), y: layer.bounds.y + (layer.offsetY ?? 0) }
        : layer
      const x = anchor.x + clamp(box.x, 0, scene.width - box.width) - box.x
      const y = anchor.y + clamp(box.y, 0, scene.height - box.height) - box.y
      changes.push(`Moved “${layer.name}” inside the artboard.`)
      return moveLayer(layer, x, y)
    }
    return layer
  })

  const contrastLayers = new Set(verifyScene(scene).issues.filter((issue) => issue.checkId === 'contrast' && issue.fixable).map((issue) => issue.layerId))
  scene.layers = scene.layers.map((layer, index) => {
    if (layer.kind !== 'text' || !layer.visible || !contrastLayers.has(layer.id)) return layer
    const background = backdropAt(scene, index)
    if (!background) return layer
    const fill = contrast([0, 0, 0], background) > contrast([255, 255, 255], background) ? '#000000' : '#ffffff'
    if (layer.fill !== fill) changes.push(`Increased contrast for “${layer.name}”.`)
    return { ...layer, fill }
  })

  return { scene, report: verifyScene(scene), changes }
}

export function applyOperations(original: Scene, operations: readonly unknown[]): Scene {
  const parsed = z.array(operationSchema).max(operationLimit).parse(operations)
  let scene = { ...original, layers: [...original.layers] }

  for (const operation of parsed) {
    if (operation.op === 'gradients') {
      scene = { ...scene, gradients: operation.gradients }
      continue
    }
    if (operation.op === 'canvas') {
      const { name, width, height, background } = operation
      scene = { ...scene, name: name ?? scene.name, width: width ?? scene.width, height: height ?? scene.height, background: background ?? scene.background }
      continue
    }
    if (operation.op === 'add') {
      if (scene.layers.some((layer) => layer.id === operation.layer.id)) throw new Error(`Layer ID “${operation.layer.id}” already exists.`)
      scene.layers.push(operation.layer)
      continue
    }

    const index = scene.layers.findIndex((layer) => layer.id === operation.id)
    if (index < 0) throw new Error(`Layer “${operation.id}” was not found.`)
    const layer = scene.layers[index]
    switch (operation.op) {
      case 'remove':
        scene.layers.splice(index, 1)
        break
      case 'replace':
        if (operation.layer.id !== layer.id) throw new Error('Use the existing layer ID when replacing a layer.')
        scene.layers[index] = operation.layer
        break
      case 'move':
        scene.layers[index] = moveLayer(layer, operation.x, operation.y)
        break
      case 'update':
        if ('id' in operation.patch || 'kind' in operation.patch) throw new Error('An update cannot change a layer’s ID or kind.')
        scene.layers[index] = layerSchema.parse({ ...layer, ...operation.patch })
        break
      case 'reorder':
        if (operation.index >= scene.layers.length) throw new Error('The target layer position is outside the layer list.')
        scene.layers.splice(index, 1)
        scene.layers.splice(operation.index, 0, layer)
        break
    }
  }
  return sceneSchema.parse(scene)
}

function xml(value: string): string {
  return value.replace(/[&<>"'\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[char] ?? '')
}

type Point3 = [number, number, number]
type Vertex = { position: Point3; normal: Point3 }
type Face = Vertex[]

function meshFaces(shape: MeshLayer['shape']): Face[] {
  if (shape === 'cube') {
    return [0, 1, 2].flatMap((axis) => [-1, 1].map((side) => {
      const normal: Point3 = [0, 0, 0]
      normal[axis] = side
      return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
        const position: Point3 = [0, 0, 0]
        position[axis] = side
        position[(axis + 1) % 3] = u
        position[(axis + 2) % 3] = v
        return { position, normal }
      })
    }))
  }

  const columns = 20
  const rows = shape === 'sphere' ? 10 : 14
  const vertex = (column: number, row: number): Vertex => {
    const u = (column / columns) * Math.PI * 2
    if (shape === 'sphere') {
      const v = (row / rows) * Math.PI
      const position: Point3 = [Math.sin(v) * Math.cos(u), Math.cos(v), Math.sin(v) * Math.sin(u)]
      return { position, normal: position }
    }
    const v = (row / rows) * Math.PI * 2
    const radius = 0.72 + 0.28 * Math.cos(v)
    return {
      position: [radius * Math.cos(u), radius * Math.sin(u), 0.28 * Math.sin(v)],
      normal: [Math.cos(v) * Math.cos(u), Math.cos(v) * Math.sin(u), Math.sin(v)],
    }
  }

  const faces: Face[] = []
  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < rows; row++) {
      faces.push([vertex(column, row), vertex(column + 1, row), vertex(column + 1, row + 1), vertex(column, row + 1)])
    }
  }
  return faces
}

function meshSvg(layer: MeshLayer): string {
  const surface = rgb(layer.color)
  if (!surface) return ''
  const angle = ((layer.rotation % 360) * Math.PI) / 180
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  const tilt = -0.42
  const rotate = ([x, y, z]: Point3): Point3 => {
    const depth = -x * sine + z * cosine
    return [x * cosine + z * sine, y * Math.cos(tilt) - depth * Math.sin(tilt), y * Math.sin(tilt) + depth * Math.cos(tilt)]
  }
  const faces = meshFaces(layer.shape).map((face) => {
    const vertices = face.map((vertex) => rotate(vertex.position))
    const normal = face.map((vertex) => rotate(vertex.normal)).reduce<Point3>((sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]], [0, 0, 0])
    const depth = vertices.reduce((sum, point) => sum + point[2], 0) / vertices.length
    return { vertices, normal, depth }
  })
  const vertices = faces.flatMap((face) => face.vertices)
  const extentX = Math.max(...vertices.map((point) => Math.abs(point[0])))
  const extentY = Math.max(...vertices.map((point) => Math.abs(point[1])))
  const scale = Math.min(layer.width / (2 * extentX), layer.height / (2 * extentY))
  const centerX = layer.x + layer.width / 2
  const centerY = layer.y + layer.height / 2

  return faces.filter((face) => face.normal[2] > 0).sort((first, second) => first.depth - second.depth).map(({ vertices, normal }) => {
    const normalLength = Math.hypot(...normal)
    const light = (-0.46 * normal[0] + 0.47 * normal[1] + 0.75 * normal[2]) / normalLength
    const intensity = Math.max(light, 0)
    const shade = surface.map((channel) => Math.min(255, Math.round(channel * (0.49 + 0.45 * intensity) + 30 * intensity))).join(',')
    const points = vertices.map(([x, y]) => `${(centerX + x * scale).toFixed(2)},${(centerY - y * scale).toFixed(2)}`).join(' ')
    return `<polygon points="${points}" fill="rgb(${shade})" stroke="rgb(${shade})" stroke-width="0.35" stroke-linejoin="round"/>`
  }).join('')
}

function layerSvg(layer: Layer, index: number, outlineText: boolean): string {
  const problem = geometryProblem(layer)
  if (problem) throw new Error(`Cannot render “${layer.name || layer.id}”: it ${problem}.`)
  let stroke = 'stroke' in layer && layer.stroke ? ` stroke="${xml(layer.stroke)}" stroke-width="${layer.strokeWidth ?? 1}"` : ''
  if ('strokeDasharray' in layer && layer.strokeDasharray) stroke += ` stroke-dasharray="${layer.strokeDasharray.join(' ')}"`
  if ('strokeLinecap' in layer && layer.strokeLinecap) stroke += ` stroke-linecap="${layer.strokeLinecap}"`
  switch (layer.kind) {
    case 'rect':
      return `<rect x="${layer.x}" y="${layer.y}" width="${layer.width}" height="${layer.height}" rx="${layer.rx ?? 0}" fill="${xml(layer.fill)}"${stroke}/>`
    case 'ellipse':
      return `<ellipse cx="${layer.x}" cy="${layer.y}" rx="${layer.rx}" ry="${layer.ry}" fill="${xml(layer.fill)}"${stroke}/>`
    case 'text': {
      const lines = textLayout(layer)
      if (outlineText) {
        if (!textMetrics(layer).measured) throw new Error(`Load the bundled ${normalizeFontFamily(layer.fontFamily)} font before outlining text.`)
        if (missingGlyphs(layer.text, layer).length) throw new Error(`“${layer.name}” contains glyphs missing from its font.`)
        return `<g aria-label="${xml(layer.text)}" fill="${xml(layer.fill)}">${lines.map((line) => `<path d="${textOutline(line.text, layer, line.x, line.y) ?? ''}"/>`).join('')}</g>`
      }
      const content = lines.map((line) => `<tspan x="${line.x}" y="${line.y}">${xml(line.text)}</tspan>`).join('')
      return `<text fill="${xml(layer.fill)}" font-size="${layer.fontSize}" font-family="${normalizeFontFamily(layer.fontFamily)}" font-weight="${layer.fontWeight ?? 'normal'}" letter-spacing="${layer.letterSpacing ?? 0}" font-variant-ligatures="none" text-anchor="start" xml:space="preserve">${content}</text>`
    }
    case 'path': {
      const markers = (['Start', 'End'] as const).filter((side) => layer[`marker${side}`]).map((side) => ` marker-${side.toLowerCase()}="url(#__grapher_${index}_${side})"`).join('')
      return `<path d="${xml(layer.d)}" fill="${xml(layer.fill)}"${stroke}${markers} stroke-linejoin="round" transform="translate(${layer.offsetX ?? 0} ${layer.offsetY ?? 0})"/>`
    }
    case 'raster': {
      if (!validRaster(layer.src)) throw new Error(`Cannot render incomplete raster “${layer.name || layer.id}”.`)
      const aspect = layer.fit === 'stretch' ? 'none' : layer.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet'
      return `<image x="${layer.x}" y="${layer.y}" width="${layer.width}" height="${layer.height}" href="${xml(layer.src)}" preserveAspectRatio="${aspect}"/>`
    }
    case 'mesh':
      return meshSvg(layer)
  }
}

export function sceneSvg(scene: Scene, options: { outlineText?: boolean } = {}): string {
  const invalid = verifyScene(scene).issues.find((issue) => issue.severity === 'error' && ['geometry', 'assets', 'unique', 'canvas'].includes(issue.checkId))
  if (invalid) throw new Error(`Cannot render scene: ${invalid.message}`)
  const width = clamp(Math.round(scene.width), 1, canvasLimit)
  const height = clamp(Math.round(scene.height), 1, canvasLimit)
  const background = rgb(scene.background) ? scene.background : scene.background === 'transparent' || scene.background === 'none' ? 'none' : '#ffffff'
  const gradients = (scene.gradients ?? []).map((gradient) => {
    const stops = gradient.stops.map((stop) => `<stop offset="${stop.offset}" stop-color="${xml(stop.color)}" stop-opacity="${stop.opacity ?? 1}"/>`).join('')
    if (gradient.kind === 'linear') return `<linearGradient id="${gradient.id}" x1="${gradient.x1}" y1="${gradient.y1}" x2="${gradient.x2}" y2="${gradient.y2}">${stops}</linearGradient>`
    return `<radialGradient id="${gradient.id}" cx="${gradient.cx}" cy="${gradient.cy}" r="${gradient.r}">${stops}</radialGradient>`
  }).join('')
  const markers = scene.layers.map((layer, index) => {
    if (layer.kind !== 'path') return ''
    const size = Math.max(6, (layer.strokeWidth ?? 1) * 4)
    return (['Start', 'End'] as const).filter((side) => layer[`marker${side}`]).map((side) => {
      // Explicitly reverse start arrows: SVG 1.1 renderers do not implement auto-start-reverse.
      const base = side === 'Start' ? size : -size
      const geometry = layer[`marker${side}`] === 'circle'
        ? `<circle cx="0" cy="0" r="${size / 3}"/>`
        : `<path d="M ${base} ${-size * 0.45} L 0 0 L ${base} ${size * 0.45} Z"/>`
      return `<marker id="__grapher_${index}_${side}" markerUnits="userSpaceOnUse" markerWidth="${size * 2}" markerHeight="${size * 2}" refX="0" refY="0" viewBox="${-size} ${-size} ${size * 2} ${size * 2}" orient="auto" overflow="visible" fill="${xml(layer.stroke ?? '#000000')}">${geometry}</marker>`
    }).join('')
  }).join('')
  const layers = scene.layers.map((layer, index) => {
    if (!layer.visible || layer.opacity === 0) return ''
    const box = rawLayerBounds(layer)
    const transform = layer.rotationDeg ? ` transform="rotate(${layer.rotationDeg} ${box.x + box.width / 2} ${box.y + box.height / 2})"` : ''
    return `<g data-layer-id="${xml(layer.id)}" opacity="${layer.opacity ?? 1}"${transform}>${layerSvg(layer, index, options.outlineText ?? false)}</g>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" overflow="hidden"><title>${xml(scene.name)}</title><defs>${gradients}${markers}</defs><rect width="100%" height="100%" fill="${xml(background)}"/>${layers}</svg>`
}
