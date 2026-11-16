import { z } from 'zod'

const number = z.number().finite()
const text = z.string().max(300)
const paint = z.string().max(32)
const boxSchema = z.strictObject({ x: number, y: number, width: number, height: number })
const layerFields = {
  id: z.string().min(1).max(100),
  name: text,
  visible: z.boolean().default(true),
}
const strokeFields = { stroke: paint.optional(), strokeWidth: number.optional() }
const layerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...layerFields, ...boxSchema.shape, kind: z.literal('rect'), fill: paint, rx: number.optional() }),
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
  }),
  z.strictObject({
    ...layerFields,
    ...boxSchema.shape,
    kind: z.literal('raster'),
    src: z.string().max(8_000_000).describe('Embedded PNG or JPEG base64 data URL.'),
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

export const sceneSchema = z.strictObject({
  name: text,
  width: number,
  height: number,
  background: paint,
  layers: z.array(layerSchema).max(750),
})

export const operationSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), layer: layerSchema }),
  z.strictObject({ op: z.literal('replace'), id: layerFields.id, layer: layerSchema }),
  z.strictObject({ op: z.literal('remove'), id: layerFields.id }),
  z.strictObject({ op: z.literal('move'), id: layerFields.id, x: number, y: number }),
  z.strictObject({ op: z.literal('update'), id: layerFields.id, patch: z.record(z.string(), z.unknown()) }),
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
const pathCommands = /^\s*[Mm][MmZzLlHhVvCcSsQqTtAaEe0-9\s,+.-]+$/
const rasterDataUrl = /^data:image\/(?:png;base64,iVBORw0KGgo|jpeg;base64,\/9j\/)[A-Za-z0-9+/]+={0,2}$/

function rgb(color: string): RGB | undefined {
  if (color.toLowerCase() === 'white') return [255, 255, 255]
  if (color.toLowerCase() === 'black') return [0, 0, 0]
  const hex = color.match(/^#([a-f\d]{3}|[a-f\d]{6})$/i)?.[1]
  if (!hex) return undefined
  const full = hex.length === 3 ? [...hex].map((digit) => digit.repeat(2)).join('') : hex
  return [0, 2, 4].map((index) => Number.parseInt(full.slice(index, index + 2), 16)) as RGB
}

function validPaint(color: string): boolean {
  return color === 'none' || color === 'transparent' || rgb(color) !== undefined
}

function validRaster(source: string): boolean {
  return rasterDataUrl.test(source)
}

function textAnchor(layer: TextLayer): 'start' | 'middle' | 'end' {
  if (layer.align === 'center' || layer.align === 'middle') return 'middle'
  if (layer.align === 'right' || layer.align === 'end') return 'end'
  return 'start'
}

function textWidth(text: string, fontFamily = ''): number {
  if (/^(?:["']?)(?:Courier(?: New)?|IBM Plex Mono|JetBrains Mono|Space Mono|ui-monospace|monospace)\b/i.test(fontFamily.trim())) {
    return Array.from(text).length * 0.6
  }
  return [...text].reduce((width, glyph) => {
    if (/[ilI.,|!':;\s]/.test(glyph)) return width + 0.28
    if (/[MWmw@%]/.test(glyph)) return width + 0.88
    return width + (/[^\u0000-\u00ff]/.test(glyph) ? 0.86 : 0.57)
  }, 0)
}

export function layerBounds(layer: Layer): Box {
  switch (layer.kind) {
    case 'ellipse': {
      const padding = layer.stroke && rgb(layer.stroke) ? (layer.strokeWidth ?? 1) / 2 : 0
      return { x: layer.x - layer.rx - padding, y: layer.y - layer.ry - padding, width: (layer.rx + padding) * 2, height: (layer.ry + padding) * 2 }
    }
    case 'text': {
      const lines = layer.text.split('\n')
      const width = Math.max(...lines.map((line) => textWidth(line, layer.fontFamily))) * layer.fontSize
      const anchor = textAnchor(layer)
      const offset = anchor === 'middle' ? width / 2 : anchor === 'end' ? width : 0
      return { x: layer.x - offset, y: layer.y - layer.fontSize * 0.82, width, height: layer.fontSize * (1 + (lines.length - 1) * 1.2) }
    }
    case 'path': {
      const { x, y, width, height } = layer.bounds
      const padding = layer.stroke && rgb(layer.stroke) ? (layer.strokeWidth ?? 1) / 2 : 0
      return { x: x + (layer.offsetX ?? 0) - padding, y: y + (layer.offsetY ?? 0) - padding, width: width + padding * 2, height: height + padding * 2 }
    }
    default:
      return { x: layer.x, y: layer.y, width: layer.width, height: layer.height }
  }
}

type Issue = { id: string; checkId: string; layerId?: string; message: string; fixable: boolean }
type Check = { id: string; label: string; status: 'pass' | 'fail'; detail: string }
export type VerificationReport = { checks: Check[]; issues: Issue[]; passed: number; total: number }

const checkDefinitions: ReadonlyArray<{ id: string; label: string; detail: string }> = [
  { id: 'canvas', label: 'Canvas dimensions', detail: 'The artboard has supported dimensions and an opaque background.' },
  { id: 'bounds', label: 'Layer bounds', detail: 'Visible layer bounds fit inside the artboard using declared path boxes and estimated text metrics.' },
  { id: 'contrast', label: 'Text contrast', detail: 'Text meets contrast thresholds against sampled flat-color backgrounds.' },
  { id: 'labels', label: 'Layer names', detail: 'The artboard and every layer have names.' },
  { id: 'assets', label: 'Raster references', detail: 'This check matches embedded PNG and JPEG signatures.' },
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
      return !pathCommands.test(layer.d) || layer.bounds.width < 0 || layer.bounds.height < 0 ? 'has invalid path data or bounds' : undefined
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
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  for (let i = index - 1; i >= 0; i--) {
    const layer = scene.layers[i]
    if (!layer.visible || layer.kind === 'text') continue
    const under = layerBounds(layer)
    if (x < under.x || y < under.y || x > under.x + under.width || y > under.y + under.height) continue

    if (layer.kind === 'ellipse') {
      if (((x - layer.x) / layer.rx) ** 2 + ((y - layer.y) / layer.ry) ** 2 > 1) continue
      const fill = rgb(layer.fill)
      if (fill) return fill
    } else if (layer.kind === 'rect') {
      const radius = Math.min(layer.rx ?? 0, layer.width / 2, layer.height / 2)
      const dx = x - Math.min(Math.max(x, layer.x + radius), layer.x + layer.width - radius)
      const dy = y - Math.min(Math.max(y, layer.y + radius), layer.y + layer.height - radius)
      if (dx * dx + dy * dy > radius * radius) continue
      const fill = rgb(layer.fill)
      if (fill) return fill
    } else if (layer.kind !== 'path' || rgb(layer.fill)) {
      return undefined
    }
  }
  return rgb(scene.background)
}

export function verifyScene(scene: Scene): VerificationReport {
  const issues: Issue[] = []
  const record = (checkId: string, message: string, fixable: boolean, layerId?: string) => {
    const key = `${checkId}:${layerId ?? 'scene'}`
    const existing = issues.filter((issue) => issue.id === key || issue.id.startsWith(`${key}#`)).length
    issues.push({ id: existing ? `${key}#${existing + 1}` : key, checkId, ...(layerId && { layerId }), message, fixable })
  }

  if (!validDimension(scene.width) || !validDimension(scene.height) || !rgb(scene.background)) {
    record('canvas', `Use whole-pixel dimensions between 1 and ${canvasLimit} and a solid background color.`, true)
  }
  if (!scene.name.trim()) record('labels', 'Give the artboard a name.', true)
  if (!scene.layers.some((layer) => layer.visible)) record('visibility', 'The artboard has no visible layers.', scene.layers.length > 0)

  const layerIds = new Set<string>()
  let unsampledText = 0
  scene.layers.forEach((layer, index) => {
    const name = layer.name.trim() || layer.id
    if (layerIds.has(layer.id)) record('unique', `Layer ID “${layer.id}” is already in use.`, false, layer.id)
    layerIds.add(layer.id)
    if (!layer.name.trim()) record('labels', `Layer “${layer.id}” has no name.`, true, layer.id)
    if (layer.kind === 'raster' && !validRaster(layer.src)) record('assets', `“${name}” needs an embedded PNG or JPEG data URL.`, false, layer.id)
    const problem = geometryProblem(layer)
    if (problem) record('geometry', `“${name}” ${problem}.`, false, layer.id)
    if (!layer.visible || problem) return

    const box = layerBounds(layer)
    if (validDimension(scene.width) && validDimension(scene.height) && outOfBounds(scene, box)) {
      record('bounds', `“${name}” extends outside the artboard.`, box.width <= scene.width && box.height <= scene.height, layer.id)
    }
    if (layer.kind !== 'text') return

    const background = backdropAt(scene, index)
    if (!background) {
      unsampledText++
      return
    }
    const foreground = rgb(layer.fill)
    const ratio = foreground ? contrast(foreground, background) : 1
    const bold = layer.fontWeight === 'bold' || Number(layer.fontWeight) >= 700
    const minimum = layer.fontSize >= 24 || (bold && layer.fontSize >= 18.66) ? 3 : 4.5
    if (ratio < minimum) {
      record('contrast', `“${name}” has ${ratio.toFixed(2)}:1 contrast at its center and needs ${minimum}:1.`, true, layer.id)
    }
  })

  const checks = checkDefinitions.map<Check>((definition) => {
    const count = issues.filter((issue) => issue.checkId === definition.id).length
    const status = count ? 'fail' : 'pass'
    let detail = count ? `${count} ${count === 1 ? 'issue' : 'issues'} found.` : definition.detail
    if (definition.id === 'contrast' && unsampledText) detail += ` ${unsampledText} ${unsampledText === 1 ? 'layer uses' : 'layers use'} a background this check can't sample.`
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
  if (!rgb(scene.background)) {
    scene.background = '#ffffff'
    changes.push('Set the artboard background to white.')
  }
  if (!scene.name.trim()) {
    scene.name = 'Untitled artboard'
    changes.push('Named the artboard.')
  }
  const first = scene.layers[0]
  if (first && !scene.layers.some((layer) => layer.visible)) {
    scene.layers[0] = { ...first, visible: true }
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

  const contrastLayers = new Set(verifyScene(scene).issues.filter((issue) => issue.checkId === 'contrast').map((issue) => issue.layerId))
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

function layerSvg(layer: Layer): string {
  if (geometryProblem(layer)) return ''
  const stroke = 'stroke' in layer && layer.stroke ? ` stroke="${xml(layer.stroke)}" stroke-width="${layer.strokeWidth ?? 1}"` : ''
  switch (layer.kind) {
    case 'rect':
      return `<rect x="${layer.x}" y="${layer.y}" width="${layer.width}" height="${layer.height}" rx="${layer.rx ?? 0}" fill="${xml(layer.fill)}"/>`
    case 'ellipse':
      return `<ellipse cx="${layer.x}" cy="${layer.y}" rx="${layer.rx}" ry="${layer.ry}" fill="${xml(layer.fill)}"${stroke}/>`
    case 'text': {
      const lines = layer.text.split('\n')
      const content = lines.length === 1 ? xml(lines[0]) : lines.map((line, index) => `<tspan x="${layer.x}" y="${layer.y + layer.fontSize * 1.2 * index}">${xml(line)}</tspan>`).join('')
      return `<text x="${layer.x}" y="${layer.y}" fill="${xml(layer.fill)}" font-size="${layer.fontSize}" font-family="${xml(layer.fontFamily ?? 'Inter, sans-serif')}" font-weight="${layer.fontWeight ?? 'normal'}" text-anchor="${textAnchor(layer)}" xml:space="preserve">${content}</text>`
    }
    case 'path':
      return `<path d="${xml(layer.d)}" fill="${xml(layer.fill)}"${stroke} stroke-linejoin="round" transform="translate(${layer.offsetX ?? 0} ${layer.offsetY ?? 0})"/>`
    case 'raster':
      return validRaster(layer.src) ? `<image x="${layer.x}" y="${layer.y}" width="${layer.width}" height="${layer.height}" href="${xml(layer.src)}" preserveAspectRatio="xMidYMid meet"/>` : ''
    case 'mesh':
      return meshSvg(layer)
  }
}

export function sceneSvg(scene: Scene): string {
  const width = clamp(Math.round(scene.width), 1, canvasLimit)
  const height = clamp(Math.round(scene.height), 1, canvasLimit)
  const background = rgb(scene.background) ? scene.background : '#ffffff'
  const layers = scene.layers.filter((layer) => layer.visible).map((layer) => `<g data-layer-id="${xml(layer.id)}">${layerSvg(layer)}</g>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" overflow="hidden"><title>${xml(scene.name)}</title><rect width="100%" height="100%" fill="${xml(background)}"/>${layers}</svg>`
}
