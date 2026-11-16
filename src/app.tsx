import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import type { UIMessage } from 'ai';
import { Button } from '@ui-sdk/react/button';
import { Menu, MenuContent, MenuContextTrigger, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator, MenuTrigger } from '@ui-sdk/react/menu';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs';
import {
  ArrowDownToLine, ArrowUp, Box, Braces, Check, ChevronDown, Circle, CircleAlert, CircleCheck, CodeXml, Crosshair,
  Copy, Eye, EyeOff, FilePlus2, FileUp, Focus, Hand, History, Image, Layers3, Minus, MousePointer2, Orbit, Plus, Redo2, RotateCw, ScanLine, Shapes,
  Sparkles, Square, SquareTerminal, Type, Undo2, X,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent, ReactNode } from 'react';
import { layerBounds, sceneSvg, verifyScene } from './engine';
import type { Layer, Operation, Scene } from './engine';
import { duplicateLayers } from './interaction';
import { isTextInput, useCanvasInteractions } from './use-canvas-interactions';
import { examples, initialExample } from './examples';
import { useGrapherTools } from './webmcp';
import { workspaceClient } from './workspace-client';
import type { ExportFormat, Workspace } from './workspace-client';
import type { DocumentSummary, HistoryEntry } from './store';

const transport = new DefaultChatTransport({
  api: '/api/chat',
  prepareSendMessagesRequest: ({ body, messages }) => ({
    body: {
      ...body,
      messages: messages.slice(-10).map(({ role, parts }) => ({
        role,
        parts: parts.filter((part) => part.type === 'text').map(({ type, text }) => ({ type, text: text.slice(0, 4000) })),
      })),
    },
  }),
});
const MeshPreview = lazy(() => import('./mesh-preview').then((module) => ({ default: module.MeshPreview })));
const defaultScene = examples[initialExample];
const starter: Workspace = { scene: defaultScene, revision: 0, report: verifyScene(defaultScene) };
const layerIcons = { rect: Square, ellipse: Circle, text: Type, path: Shapes, raster: Image, mesh: Box };
const sampleAppearance = {
  orbital: { icon: Orbit, tone: 'orange' },
  web: { icon: CodeXml, tone: 'violet' },
  game: { icon: Box, tone: 'green' },
  poster: { icon: Type, tone: 'rose' },
  'single-cell-workflow': { icon: Shapes, tone: 'green' },
  'causal-pathways': { icon: Orbit, tone: 'violet' },
  'response-curve': { icon: Shapes, tone: 'orange' },
};
const samples = [
  { key: 'single-cell-workflow', name: 'Single-cell RNA-seq analysis' },
  { key: 'causal-pathways', name: 'Causal pathways and confounding' },
  { key: 'response-curve', name: 'Response curve · synthetic example' },
  ...Object.entries(examples).map(([key, scene]) => ({ key, name: scene.name })),
];
const issueTitles: Record<string, string> = {
  bounds: 'Layer outside canvas', contrast: 'Low text contrast', labels: 'Missing label', assets: 'Invalid raster asset',
  geometry: 'Invalid layer geometry', unique: 'Duplicate layer ID', canvas: 'Invalid artboard', visibility: 'Empty canvas',
  fonts: 'Typography needs review', decode: 'Asset could not be decoded', render: 'Rendered output needs review',
};
const formats: { key: string; format: ExportFormat; label: string; note: string; scale?: number; outlineText?: boolean }[] = [
  { key: 'svg', format: 'svg', label: 'SVG', note: 'Editable vector artwork' },
  { key: 'svg-outlined', format: 'svg', label: 'SVG · outlined text', note: 'Portable vector artwork', outlineText: true },
  { key: 'pdf', format: 'pdf', label: 'PDF', note: 'Vector document · outlined text' },
  { key: 'png', format: 'png', label: 'PNG · 1×', note: 'Artboard pixel size', scale: 1 },
  { key: 'png-2', format: 'png', label: 'PNG · 2×', note: 'Double resolution', scale: 2 },
  { key: 'png-4', format: 'png', label: 'PNG · 4×', note: 'Four times resolution', scale: 4 },
  { key: 'glb', format: 'glb', label: 'GLB', note: '3D meshes' },
  { key: 'json', format: 'json', label: 'JSON', note: 'Editable scene source' },
];

function rememberedDocument() {
  const fromUrl = new URL(location.href).searchParams.get('document');
  if (fromUrl) return fromUrl;
  try { return localStorage.getItem('grapher.documentId') ?? undefined; } catch { return undefined; }
}

function documentSummary(workspace: Workspace): DocumentSummary | undefined {
  if (!workspace.documentId || !workspace.updatedAt) return undefined;
  return { id: workspace.documentId, name: workspace.scene.name, width: workspace.scene.width, height: workspace.scene.height,
    revision: workspace.revision, updatedAt: workspace.updatedAt };
}

function IconButton({ label, onClick, children, active, disabled }: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
}) {
  return <Button type="button" className={`icon-button ${active ? 'active' : ''}`} onClick={onClick}
    title={label} aria-label={label} aria-pressed={active} disabled={disabled}>{children}</Button>;
}

function SampleLabel({ sampleKey, name, active }: { sampleKey: string; name: string; active: boolean }) {
  const detail = sampleAppearance[sampleKey as keyof typeof sampleAppearance] ?? { icon: Shapes, tone: 'orange' };
  const SampleIcon = detail.icon;
  return <>
    <span className={`example-icon ${detail.tone}`} aria-hidden="true"><SampleIcon size={16} /></span>
    <span><strong>{name}</strong></span>
    {active && <Check size={14} className="example-check" aria-hidden="true" />}
  </>;
}

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true">
    <svg viewBox="0 0 28 28" fill="none"><path d="M14 4.75 22.9 9.9v8.2L14 23.25 5.1 18.1V9.9L14 4.75Z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
      <path d="m5.6 10.2 8.4 4.9 8.4-4.9M14 15.1v7.55M9.55 7.35l8.9 5.15" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
    </svg>
  </span>;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function AgentPart({ part }: { part: UIMessage['parts'][number] }) {
  if (part.type === 'text') return <p>{part.text}</p>;
  if (!part.type.startsWith('tool-') || !('state' in part)) return null;
  const label = part.type.slice(5).replaceAll('-', ' ');
  const output = 'output' in part && part.output && typeof part.output === 'object' ? part.output : undefined;
  if (label === 'render' && output && 'pngBase64' in output && typeof output.pngBase64 === 'string') {
    const revision = 'revision' in output && typeof output.revision === 'number' ? output.revision : undefined;
    return <details className="render-message">
      <summary><Image size={13} /> {revision ? `Rendered revision ${revision}` : 'Rendered artboard'}</summary>
      <img src={`data:image/png;base64,${output.pngBase64}`} alt="Artboard snapshot inspected by the agent" />
    </details>;
  }
  if (part.state === 'output-error') return <span className="tool-message tool-error" title={part.errorText}>{label} failed</span>;
  return <span className="tool-message">{label}{part.state === 'output-available' ? ' ✓' : '…'}</span>;
}

export function App() {
  const [documentId, setDocumentId] = useState(rememberedDocument);
  const client = useMemo(() => workspaceClient(location.origin, documentId), [documentId]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [documentsReady, setDocumentsReady] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [workspace, setWorkspace] = useState(starter);
  const [selected, setSelected] = useState<string>();
  const [sideTab, setSideTab] = useState<'layers' | 'examples'>('layers');
  const [inspector, setInspector] = useState<'verify' | 'properties' | 'history'>('verify');
  const [mode, setMode] = useState<'canvas' | 'mesh' | 'source'>('canvas');
  const [menu, setMenu] = useState<'documents' | 'export'>();
  const [contextOpen, setContextOpen] = useState(false);
  const [tool, setTool] = useState<'select' | 'pan'>('select');
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ width: 800, height: 640 });
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [brief, setBrief] = useState('');
  const [modelEnabled, setModelEnabled] = useState(false);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error?: boolean }>();
  const [past, setPast] = useState<Scene[]>([]);
  const [future, setFuture] = useState<Scene[]>([]);
  const [propertyReset, setPropertyReset] = useState(0);
  const latest = useRef(starter);
  const mutationBusy = useRef(false);
  const activeDocument = useRef(documentId);
  const importInput = useRef<HTMLInputElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const consoleInput = useRef<HTMLTextAreaElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const artboard = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | undefined>(undefined);
  const { scene, revision, report } = workspace;
  const selectedLayer = scene.layers.find((layer) => layer.id === selected);
  const hasMesh = scene.layers.some((layer) => layer.kind === 'mesh' && layer.visible);
  const fixable = report.issues.some((issue) => issue.fixable);
  const issueCount = report.issues.length;
  const needsReview = report.checks.some((check) => check.status === 'warn');
  const allPassed = report.passed === report.total;
  const fit = Math.min(1, Math.max(0.15, (size.width - 90) / scene.width), Math.max(0.15, (size.height - 110) / scene.height));
  const scale = fit * zoom;

  const rememberSummary = useCallback((next: Workspace) => {
    const summary = documentSummary(next);
    if (summary) setDocuments((items) => [summary, ...items.filter((item) => item.id !== summary.id)]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }, []);

  const openDocument = useCallback((id: string, loaded?: Workspace) => {
    activeDocument.current = id;
    setDocumentId(id);
    const next = loaded ?? { ...latest.current, documentId: id, revision: 0 };
    latest.current = next;
    setWorkspace(next);
    setSelected(undefined);
    setPast([]);
    setFuture([]);
    setHistoryEntries([]);
    setMode('canvas');
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    const url = new URL(location.href);
    url.searchParams.set('document', id);
    window.history.replaceState(null, '', url);
    try { localStorage.setItem('grapher.documentId', id); } catch { /* URL still retains the selected document. */ }
    if (loaded) rememberSummary(loaded);
  }, [rememberSummary]);

  const accept = useCallback((next: Workspace, local = false) => {
    if (next.documentId !== activeDocument.current) return false;
    const previous = latest.current;
    const restarted = next.workspaceId !== previous.workspaceId;
    if (!restarted && next.revision < previous.revision) return false;
    if (restarted || next.revision > previous.revision) {
      latest.current = next;
      setWorkspace(next);
      rememberSummary(next);
      if (!local) {
        setPast([]);
        setFuture([]);
      }
    }
    return true;
  }, [rememberSummary]);
  const refresh = useCallback(async () => {
    try {
      const next = await client.inspect();
      if (accept(next)) return next;
    } catch (error) {
      if (documentId === activeDocument.current) setNotice({ message: String(error), error: true });
    }
  }, [accept, client, documentId]);
  const onWebMcpChange = useCallback((next: Workspace) => { accept(next); }, [accept]);
  const webMcp = useGrapherTools(onWebMcpChange, documentId);
  const { messages, status, error, sendMessage, stop } = useChat({
    id: documentId,
    transport,
    onFinish: () => { void refresh(); },
  });
  const running = status === 'submitted' || status === 'streaming';
  const interaction = useCanvasInteractions({
    workspace, selected, scale, enabled: !!revision && !working && mode === 'canvas' && tool === 'select' && !contextOpen,
    keyboardEnabled: !!revision && mode === 'canvas' && tool === 'select' && !contextOpen,
    select: setSelected,
    commit: (operations, base) => mutate({ action: 'apply', operations }, true, base),
    undo: () => { void travel('undo'); }, redo: () => { void travel('redo'); },
    duplicate: () => { void duplicateSelection(); }, remove: () => { void deleteSelection(); },
    notify: (message) => setNotice({ message, error: true }),
  });
  const preview = interaction.preview && interaction.preview.documentId === documentId ? interaction.preview.layer : undefined;
  const displayScene = useMemo(() => preview ? { ...scene, layers: scene.layers.map((layer) => layer.id === preview.id ? preview : layer) } : scene, [scene, preview]);
  const art = useMemo(() => sceneSvg(displayScene, { outlineText: true }), [displayScene]);
  const shownSelection = preview?.id === selected ? preview : selectedLayer;
  const bounds = shownSelection?.visible ? layerBounds(shownSelection) : undefined;

  useEffect(() => {
    if (interaction.editing) { textInput.current?.focus(); textInput.current?.select(); }
  }, [interaction.editing?.layer.id]);

  useEffect(() => {
    if (!hasMesh && mode === 'mesh') setMode('canvas');
  }, [hasMesh, mode]);

  useEffect(() => {
    let cancelled = false;
    let retry: number | undefined;
    const connect = () => void workspaceClient(location.origin).documents().then(({ documents: saved, defaultDocumentId }) => {
      if (cancelled) return;
      setDocuments(saved);
      const requested = activeDocument.current;
      openDocument(saved.some((item) => item.id === requested) ? requested! : defaultDocumentId);
      setDocumentsReady(true);
    }).catch((error) => {
      if (!cancelled) {
        setNotice({ message: String(error), error: true });
        retry = window.setTimeout(connect, 3000);
      }
    });
    connect();
    void fetch('/api/config').then((response) => response.json()).then((config) => {
      if (!cancelled) setModelEnabled(config.modelEnabled);
    }).catch(() => {});
    return () => { cancelled = true; window.clearTimeout(retry); };
  }, [openDocument]);

  useEffect(() => {
    if (!documentsReady || !documentId) return;
    void refresh();
    const interval = window.setInterval(() => {
      void client.inspect().then(accept).catch(() => {});
    }, 2400);
    return () => window.clearInterval(interval);
  }, [accept, client, documentId, documentsReady, refresh]);

  useEffect(() => {
    if (inspector !== 'history' || !revision) return;
    const controller = new AbortController();
    setHistoryLoading(true);
    void client.history(controller.signal).then(({ entries }) => {
      if (documentId === activeDocument.current) setHistoryEntries(entries);
    }).catch((error) => {
      if (!controller.signal.aborted && documentId === activeDocument.current) setNotice({ message: String(error), error: true });
    }).finally(() => { if (!controller.signal.aborted) setHistoryLoading(false); });
    return () => controller.abort();
  }, [client, documentId, inspector, revision]);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (notice) {
      const timer = window.setTimeout(() => setNotice(undefined), notice.error ? 7500 : 3800);
      return () => window.clearTimeout(timer);
    }
  }, [notice]);

  useEffect(() => {
    if (consoleOpen) consoleInput.current?.focus();
  }, [consoleOpen]);

  useEffect(() => {
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [messages, consoleOpen, status]);

  async function mutate(input: Parameters<typeof client.edit>[0], remember = true, base = workspace) {
    if (mutationBusy.current || !base.revision || base.documentId !== activeDocument.current) return;
    mutationBusy.current = true;
    setWorking(true);
    try {
      const next = await workspaceClient(location.origin, base.documentId).edit({ ...input, documentId: base.documentId, revision: base.revision });
      if (!accept(next, true)) return;
      if (next.revision !== base.revision && remember) {
        setPast((history) => [...history.slice(-19), base.scene]);
        setFuture([]);
      }
      return next;
    } catch (error) {
      if (documentId === activeDocument.current) {
        setNotice({ message: error instanceof Error ? error.message : 'The canvas update failed.', error: true });
        setPropertyReset((value) => value + 1);
        void refresh();
      }
    } finally {
      mutationBusy.current = false;
      setWorking(false);
    }
  }

  async function travel(direction: 'undo' | 'redo') {
    const history = direction === 'undo' ? past : future;
    const next = history.at(-1);
    if (!next || !await mutate({ action: 'replace', scene: next }, false)) return;
    if (direction === 'undo') {
      setPast(history.slice(0, -1));
      setFuture((entries) => [...entries, scene]);
    } else {
      setFuture(history.slice(0, -1));
      setPast((entries) => [...entries, scene]);
    }
    setSelected(undefined);
  }

  function fitCanvas() {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }

  async function createDocument(input: Parameters<typeof client.create>[0]) {
    if (working || mutationBusy.current || !documentsReady) return;
    mutationBusy.current = true;
    setWorking(true);
    try {
      const next = await client.create(input);
      if (!next.documentId) throw new Error('The new document did not return an ID.');
      openDocument(next.documentId, next);
      setSideTab('layers');
      setInspector('verify');
      setNotice({ message: `Created ${next.scene.name}` });
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'Could not create the document.', error: true });
    } finally {
      mutationBusy.current = false;
      setWorking(false);
    }
  }

  function documentAction(action: string) {
    if (action === 'new') return createDocument({ name: 'Untitled document' });
    if (action === 'duplicate') return createDocument({ scene, name: `${scene.name.slice(0, 295)} copy` });
    if (action === 'import') return importInput.current?.click();
    if (action.startsWith('sample:')) return createDocument({ template: action.slice('sample:'.length) });
    if (action.startsWith('document:')) openDocument(action.slice('document:'.length));
  }

  function toggleDocumentMenu(open: boolean) {
    setMenu(open ? 'documents' : undefined);
    if (open) void client.documents().then(({ documents: saved }) => setDocuments((current) => {
      const merged = new Map(current.map((item) => [item.id, item]));
      for (const item of saved) {
        if (item.revision >= (merged.get(item.id)?.revision ?? 0)) merged.set(item.id, item);
      }
      return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }))
      .catch((error) => setNotice({ message: String(error), error: true }));
  }

  async function importDocument(file: File) {
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('Choose a scene JSON file smaller than 8 MB.');
      const source = JSON.parse(await file.text());
      await createDocument({ scene: source.scene ?? source });
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'The file could not be imported.', error: true });
    }
  }

  async function restoreRevision(targetRevision: number) {
    if (working || mutationBusy.current || !revision) return;
    mutationBusy.current = true;
    setWorking(true);
    try {
      const next = await client.restore(targetRevision, revision);
      if (!accept(next, true)) return;
      if (next.revision !== revision) {
        setPast((history) => [...history.slice(-19), scene]);
        setFuture([]);
      }
      setSelected(undefined);
      setNotice({ message: next.revision === revision ? 'This revision already matches the current document.'
        : `Restored revision ${targetRevision} as revision ${next.revision}` });
    } catch (error) {
      if (documentId === activeDocument.current) {
        setNotice({ message: String(error), error: true });
        void refresh();
      }
    } finally {
      mutationBusy.current = false;
      setWorking(false);
    }
  }

  async function repair() {
    const next = await mutate({ action: 'repair' });
    if (!next) return;
    const changes = next.changes?.length ?? 0;
    setNotice({ message: changes ? `Applied ${changes} ${changes === 1 ? 'fix' : 'fixes'} · ${next.report.passed}/${next.report.total} checks passed` : 'No automatic fixes available.' });
  }

  async function exportScene(format: ExportFormat, options: { scale?: number; outlineText?: boolean } = {}) {
    if (!revision) return;
    try {
      const response = await client.export(format, revision, undefined, options);
      const name = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? `grapher.${format}`;
      download(await response.blob(), name);
      setNotice({ message: `${format.toUpperCase()} exported · revision ${response.headers.get('x-grapher-revision') ?? revision}` });
    } catch (error) {
      setNotice({ message: String(error), error: true });
    }
  }

  async function addLayer(kind: 'rect' | 'ellipse' | 'text' | 'mesh') {
    const x = Math.max(0, Math.round(scene.width / 2 - 55));
    const y = Math.max(0, Math.round(scene.height / 2 - 35));
    const common = { id: crypto.randomUUID(), visible: true };
    const layer: Layer = kind === 'rect' ? { ...common, kind, name: 'Rectangle', x, y, width: 110, height: 70, fill: '#EAA63B', rx: 4 }
      : kind === 'ellipse' ? { ...common, kind, name: 'Ellipse', x: x + 55, y: y + 35, rx: 42, ry: 34, fill: '#EAA63B' }
      : kind === 'text' ? { ...common, kind, name: 'Text', x, y: y + 40, text: 'New text', fontSize: 24, fill: '#242320' }
      : { ...common, kind, name: '3D cube', x, y, width: 110, height: 110, shape: 'cube', color: '#EAA63B', rotation: 26 };
    if (await mutate({ action: 'apply', operations: [{ op: 'add', layer }] })) {
      setSelected(layer.id);
      setMode('canvas');
      setInspector('properties');
    }
  }

  function patchLayer(layer: Layer, patch: Record<string, unknown>) {
    return mutate({ action: 'apply', operations: [{ op: 'update', id: layer.id, patch }] });
  }

  function layerAt(target: EventTarget | null) {
    const id = target instanceof Element ? target.closest('[data-layer-id]')?.getAttribute('data-layer-id') : undefined;
    return scene.layers.find((layer) => layer.id === id);
  }

  function canvasPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (tool !== 'select' || event.button !== 0 || (event.target as Element).closest('[data-canvas-editor], [data-resize-handle]')) return;
    const layer = layerAt(event.target);
    if (layer) { setInspector('properties'); interaction.begin(event, layer); }
    else if (!interaction.editing) { setSelected(undefined); artboard.current?.focus({ preventScroll: true }); }
  }

  function canvasDoubleClick(event: MouseEvent<HTMLDivElement>) {
    if (tool !== 'select') return;
    const layer = layerAt(event.target) ?? layerAt(document.elementFromPoint(event.clientX, event.clientY));
    if (layer?.kind === 'text') { event.preventDefault(); interaction.beginText(layer); }
  }

  async function deleteSelection() {
    if (!selectedLayer) return;
    if (await mutate({ action: 'apply', operations: [{ op: 'remove', id: selectedLayer.id }] })) setSelected(undefined);
  }

  async function duplicateSelection() {
    if (!selectedLayer) return;
    const operations = duplicateLayers(scene, [selectedLayer.id]);
    if (await mutate({ action: 'apply', operations })) {
      const copy = operations.find((operation) => operation.op === 'add');
      if (copy?.op === 'add') setSelected(copy.layer.id);
    }
  }

  async function layerAction(action: string) {
    if (!selectedLayer) return;
    if (action === 'text') {
      setContextOpen(false);
      window.requestAnimationFrame(() => interaction.beginText(selectedLayer));
    } else if (action === 'duplicate') await duplicateSelection();
    else if (action === 'delete') await deleteSelection();
    else if (action === 'front' || action === 'back') {
      const operation: Operation = { op: 'reorder', id: selectedLayer.id, index: action === 'front' ? scene.layers.length - 1 : 0 };
      await mutate({ action: 'apply', operations: [operation] });
    } else if (action === 'agent') {
      setConsoleOpen(true);
      window.requestAnimationFrame(() => consoleInput.current?.focus());
    }
  }

  function panStart(event: PointerEvent<HTMLDivElement>) {
    if (tool !== 'pan' || mode !== 'canvas') return;
    drag.current = { x: event.clientX - offset.x, y: event.clientY - offset.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function panMove(event: PointerEvent<HTMLDivElement>) {
    if (drag.current) setOffset({ x: event.clientX - drag.current.x, y: event.clientY - drag.current.y });
  }

  function selectIssue(layerId?: string) {
    setMode('canvas');
    fitCanvas();
    setSelected(layerId);
    if (layerId) window.requestAnimationFrame(() => document.getElementById(`layer-${layerId}`)?.scrollIntoView({ block: 'nearest' }));
  }

  function runPrompt(value: string) {
    const text = value.trim();
    if (!text || running || !revision || !documentId) return;
    setBrief('');
    void sendMessage({ text }, { body: { documentId, revision, selectedLayerIds: selectedLayer ? [selectedLayer.id] : [] } }).catch(() => {});
  }

  const library = samples.map(({ key, name }) =>
    <Button className="example-item" key={key} type="button" disabled={working || !documentsReady} onClick={() => createDocument({ template: key })}>
      <SampleLabel sampleKey={key} name={name} active={false} />
    </Button>);

  return <div className="studio">
    <header className="app-header">
      <div className="header-left">
        <div className="brand"><BrandMark /><span>Grapher</span></div>
        <span className="header-divider" />
        <div className="menu-anchor">
          <Menu open={menu === 'documents'} onOpenChange={toggleDocumentMenu} onAction={documentAction}>
            <MenuTrigger className="document-button">
              <span>{scene.name}</span><ChevronDown size={13} />
            </MenuTrigger>
            <MenuContent className="pop-menu project-menu" aria-label="Documents" sideOffset={10} align="start">
              <MenuGroup className="saved-documents">
                <MenuGroupLabel className="menu-caption">Saved documents</MenuGroupLabel>
                {documents.map((item) =>
                  <MenuItem className="saved-document" key={item.id} value={`document:${item.id}`} label={item.name} disabled={working || item.id === documentId}>
                    <span><strong>{item.name}</strong><small>{item.width} × {item.height} · Revision {item.revision}</small></span>
                    {item.id === documentId && <Check size={14} aria-label="Current document" />}
                  </MenuItem>)}
              </MenuGroup>
              <MenuGroup className="document-actions">
                <MenuItem value="new" label="New blank document" disabled={working || !documentsReady}><FilePlus2 size={15} /> New blank document</MenuItem>
                <MenuItem value="import" label="Import scene JSON" disabled={working || !documentsReady}><FileUp size={15} /> Import scene JSON</MenuItem>
                <MenuItem value="duplicate" label="Duplicate document" disabled={working || !revision}><Copy size={15} /> Duplicate document</MenuItem>
              </MenuGroup>
              <MenuGroup className="document-samples">
                <MenuGroupLabel className="menu-caption">New from sample</MenuGroupLabel>
                {samples.map(({ key, name }) => <MenuItem className="example-item" key={key} value={`sample:${key}`} label={name}
                  disabled={working || !documentsReady}><SampleLabel sampleKey={key} name={name} active={false} /></MenuItem>)}
              </MenuGroup>
            </MenuContent>
          </Menu>
          <input ref={importInput} className="file-input" type="file" accept=".json,application/json" aria-label="Import scene JSON file"
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importDocument(file); }} />
        </div>
      </div>
      <div className="header-actions">
        <button className={`agent-button ${consoleOpen ? 'toggled' : ''}`} aria-expanded={consoleOpen} onClick={() => setConsoleOpen(!consoleOpen)}>
          <SquareTerminal size={16} /><span>Agent console</span>
        </button>
        <div className="menu-anchor">
          <Menu open={menu === 'export'} onOpenChange={(open) => setMenu(open ? 'export' : undefined)}
            onAction={(key) => { const option = formats.find((item) => item.key === key); if (option) void exportScene(option.format, option); }}>
            <MenuTrigger className="export-button"><ArrowDownToLine size={15} /> Export <ChevronDown size={12} /></MenuTrigger>
            <MenuContent className="pop-menu export-menu" aria-label="Export scene" sideOffset={10} align="end">
              {formats.map(({ key, format, label, note }) => <MenuItem key={key} value={key} label={label} disabled={!revision || (format === 'glb' && !hasMesh)}>
                <strong>{label}</strong><small>{note}</small>
              </MenuItem>)}
            </MenuContent>
          </Menu>
        </div>
      </div>
    </header>

    <main className="workspace">
      <Tabs render={<aside />} className="layers-panel" aria-label="Scene layers" value={sideTab}
        onValueChange={(value) => { if (value) setSideTab(value); }}>
        <TabsList className="panel-tabs" aria-label="Scene navigation">
          <TabsTab className="tab" value="layers"><Layers3 size={15} /> Layers</TabsTab>
          <TabsTab className="tab" value="examples">Samples</TabsTab>
        </TabsList>
        <TabsPanel value="layers" className="layer-panel-content">
          <div className="layer-heading"><div><span className="artboard-icon">#</span><strong>Artboard</strong></div>
            <span className="layer-total">{scene.layers.length}</span></div>
          <div className="layer-scroll">
            {[...scene.layers].reverse().map((layer) => {
              const LayerIcon = layerIcons[layer.kind];
              return <div key={layer.id} id={`layer-${layer.id}`} className={`layer-row ${selected === layer.id ? 'selected' : ''} ${layer.visible ? '' : 'muted'}`}>
                <button className="layer-select" type="button" onClick={() => { setSelected(layer.id); setInspector('properties'); setMode('canvas'); }}>
                  <LayerIcon size={14} /><span>{layer.name}</span>
                </button>
                <button className="visibility-button" aria-label={`${layer.visible ? 'Hide' : 'Show'} ${layer.name}`}
                  disabled={working || !revision}
                  onClick={() => void patchLayer(layer, { visible: !layer.visible })}>
                  {layer.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                </button>
              </div>;
            })}
          </div>
          <div className="layers-bottom"><span className="layer-dot" /> {scene.layers.filter((layer) => layer.visible).length} visible layers</div>
        </TabsPanel>
        <TabsPanel value="examples" className="example-library"><p className="sample-note">Start a new document from a sample.</p>{library}</TabsPanel>
      </Tabs>

      <section className="canvas-panel" aria-label="Canvas preview">
        <div className="canvas-toolbar">
          <div className="drawing-tools">
            <IconButton label="Select tool" onClick={() => setTool('select')} active={tool === 'select'}><MousePointer2 size={16} /></IconButton>
            <IconButton label="Pan tool" onClick={() => setTool('pan')} active={tool === 'pan'}><Hand size={16} /></IconButton>
            <span className="tool-divider" />
            <IconButton label="Add rectangle" onClick={() => void addLayer('rect')} disabled={working || !revision}><Square size={15} /></IconButton>
            <IconButton label="Add ellipse" onClick={() => void addLayer('ellipse')} disabled={working || !revision}><Circle size={15} /></IconButton>
            <IconButton label="Add text" onClick={() => void addLayer('text')} disabled={working || !revision}><Type size={16} /></IconButton>
            <IconButton label="Add 3D primitive" onClick={() => void addLayer('mesh')} disabled={working || !revision}><Box size={16} /></IconButton>
            <span className="tool-divider history-tool" />
            <span className="history-tool"><IconButton label="Undo" onClick={() => void travel('undo')} disabled={working || !past.length}><Undo2 size={15} /></IconButton></span>
            <span className="history-tool"><IconButton label="Redo" onClick={() => void travel('redo')} disabled={working || !future.length}><Redo2 size={15} /></IconButton></span>
          </div>
          <div className="view-tools">
            {hasMesh && <button className={`view-button ${mode === 'mesh' ? 'active' : ''}`} aria-label="3D view" aria-pressed={mode === 'mesh'} onClick={() => setMode(mode === 'mesh' ? 'canvas' : 'mesh')}><Box size={14} /> 3D</button>}
            <IconButton label="Scene source" active={mode === 'source'} onClick={() => setMode(mode === 'source' ? 'canvas' : 'source')}><Braces size={15} /></IconButton>
            <span className="tool-divider" />
            <IconButton label="Fit canvas" onClick={() => { setMode('canvas'); fitCanvas(); }}><Focus size={16} /></IconButton>
          </div>
        </div>
        <div className={`stage ${tool === 'pan' && mode === 'canvas' ? 'pan-stage' : ''}`} ref={stage}
          onPointerDown={panStart} onPointerMove={panMove} onPointerUp={() => { drag.current = undefined; }}
          onPointerCancel={() => { drag.current = undefined; }}>
          {mode === 'canvas' && <div className="board-wrap" style={{ width: scene.width * scale, transform: `translate(${offset.x}px, ${offset.y}px)` }}>
            <div className="board-meta"><span><Crosshair size={13} /> {scene.name}</span><span>{scene.width} × {scene.height}</span></div>
            <Menu open={contextOpen} onOpenChange={setContextOpen} onAction={layerAction}>
              <MenuContextTrigger ref={artboard} className={`artboard ${tool === 'select' ? 'selectable-artboard' : ''}`}
                style={{ height: scene.height * scale }} tabIndex={0} aria-label="Editable artboard" aria-describedby="canvas-keyboard-help"
                onPointerDown={canvasPointerDown} onPointerMove={interaction.move} onPointerUp={() => void interaction.finish()}
                onPointerCancel={() => interaction.cancel()} onLostPointerCapture={interaction.release} onDoubleClick={canvasDoubleClick}
                onKeyDown={(event) => {
                  if (!isTextInput(event.target) && ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu')) {
                    event.preventDefault(); event.stopPropagation();
                    event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 }));
                  }
                }}
                onContextMenuCapture={(event) => {
                  if (isTextInput(event.target)) { event.stopPropagation(); return; }
                  const layer = layerAt(event.target);
                  if (layer) { setSelected(layer.id); setInspector('properties'); }
                  else if (event.clientX || event.clientY) setSelected(undefined);
                }}>
                <div className="artwork" dangerouslySetInnerHTML={{ __html: art }} />
                {bounds && <div className="selection-box" style={{ left: bounds.x * scale, top: bounds.y * scale, width: bounds.width * scale, height: bounds.height * scale }}>
                  {!interaction.editing && !selectedLayer?.rotationDeg && tool === 'select' && (['nw', 'ne', 'se', 'sw'] as const).map((corner) =>
                    <button key={corner} type="button" className={`resize-handle handle-${corner}`} data-resize-handle={corner}
                      aria-label={`Resize ${corner === 'nw' ? 'top left' : corner === 'ne' ? 'top right' : corner === 'se' ? 'bottom right' : 'bottom left'}`}
                      disabled={working || !revision} onPointerDown={(event) => {
                        event.stopPropagation(); if (selectedLayer) interaction.begin(event, selectedLayer, corner);
                      }} />)}
                </div>}
                {interaction.editing && <div className="canvas-text-editor" data-canvas-editor="true" role="group" aria-label="Canvas text editor"
                  style={{ left: Math.max(0, Math.min((bounds?.x ?? 0) * scale, scene.width * scale - 250)),
                    top: Math.max(0, Math.min((bounds?.y ?? 0) * scale, scene.height * scale - 160)) }}>
                  <textarea ref={textInput} aria-label="Edit text on canvas" maxLength={10000} value={interaction.editing.value}
                    disabled={working} onChange={(event) => interaction.changeText(event.target.value)} onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Escape') { event.preventDefault(); interaction.cancel(); artboard.current?.focus(); }
                      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault(); void interaction.saveText().then((saved) => { if (saved) artboard.current?.focus(); });
                      }
                    }} />
                  <div><small>{interaction.editing.conflict ? 'Document changed. Copy your draft, then cancel and reopen.' : 'Enter saves · Shift + Enter adds a line'}</small><span>
                    <Button type="button" disabled={working} onClick={() => { interaction.cancel(); artboard.current?.focus(); }}>Cancel</Button>
                    <Button type="button" disabled={working || interaction.editing.conflict} onClick={() => void interaction.saveText().then((saved) => { if (saved) artboard.current?.focus(); })}>Save</Button>
                  </span></div>
                </div>}
              </MenuContextTrigger>
              <MenuContent className="pop-menu canvas-context-menu" aria-label="Selection actions" sideOffset={4} finalFocus={() => artboard.current}>
                <div className="menu-caption">{selectedLayer?.name ?? 'Select an element'}</div>
                <MenuItem value="text" label="Edit text" disabled={working || selectedLayer?.kind !== 'text'}><Type size={14} /> Edit text</MenuItem>
                <MenuItem value="duplicate" label="Duplicate" shortcut="mod+d" disabled={working || !selectedLayer}><Copy size={14} /> Duplicate</MenuItem>
                <MenuItem value="front" label="Bring to front" disabled={working || !selectedLayer}>Bring to front</MenuItem>
                <MenuItem value="back" label="Send to back" disabled={working || !selectedLayer}>Send to back</MenuItem>
                <MenuSeparator className="context-separator" />
                <MenuItem value="agent" label="Ask agent about selection" disabled={!selectedLayer}><Sparkles size={14} /> Ask agent about selection</MenuItem>
                <MenuItem value="delete" label="Delete" shortcut="Delete" destructive disabled={working || !selectedLayer}>Delete</MenuItem>
              </MenuContent>
            </Menu>
          </div>}
          {mode === 'mesh' && <Suspense fallback={<div className="view-loading">Opening 3D view…</div>}><MeshPreview scene={scene} /></Suspense>}
          {mode === 'source' && <div className="source-view">
            <div><strong>Scene source</strong><button onClick={() => void exportScene('json')}><ArrowDownToLine size={14} /> Download JSON</button></div>
            <pre>{JSON.stringify(scene, null, 2)}</pre>
          </div>}
          {mode === 'canvas' && <div className="zoom-widget">
            <IconButton label="Zoom out" onClick={() => setZoom((value) => Math.max(0.25, value / 1.2))}><Minus size={15} /></IconButton>
            <button className="zoom-value" onClick={fitCanvas} title="Reset zoom">{Math.round(scale * 100)}%</button>
            <IconButton label="Zoom in" onClick={() => setZoom((value) => Math.min(4, value * 1.2))}><Plus size={15} /></IconButton>
          </div>}
          {!revision && <div className="document-loading" role="status">Opening document…</div>}
          <p id="canvas-keyboard-help" className="sr-only">Drag an element to move it. Double-click text to edit it. Arrow keys move by one pixel; Shift and arrow keys move by ten. Escape cancels. Right-click or Shift F10 opens selection actions.</p>
          {notice && <div className={`toast ${notice.error ? 'toast-error' : ''}`} role={notice.error ? 'alert' : 'status'}>
            {notice.error ? <CircleAlert size={16} /> : <CircleCheck size={16} />}<span>{notice.message}</span>
          </div>}
        </div>
        {consoleOpen && <section className="agent-console" aria-label="Agent console">
          <div className="console-heading"><span><SquareTerminal size={16} /> Agent console</span>
            <div><small>{modelEnabled ? 'Model connected' : 'Demo mode'}</small><IconButton label="Close agent console" onClick={() => setConsoleOpen(false)}><X size={15} /></IconButton></div>
          </div>
          <div className="console-feed" ref={feed} aria-live="polite">
            {!messages.length && <p>{modelEnabled ? 'Give the agent a brief or ask it to revise the active scene.' : 'Try a workspace command or load a sample scene.'}</p>}
            {messages.map((message) => <div key={message.id} className={`message ${message.role}`}>
              {message.parts.map((part, index) => <AgentPart key={index} part={part} />)}
            </div>)}
            {status === 'submitted' && <p className="console-waiting">Running…</p>}
            {error && <p className="console-error" role="alert">{error.message}</p>}
          </div>
          <div className="prompt-buttons">
            {['Verify the canvas', 'Fix the current issues', 'Render this document'].map((prompt) =>
              <button key={prompt} onClick={() => runPrompt(prompt)} disabled={running || !revision}>{prompt}</button>)}
          </div>
          {selectedLayer && <div className="selection-context"><Crosshair size={12} /><span>Selected: {selectedLayer.name}</span>
            <button type="button" aria-label="Remove selection context" onClick={() => setSelected(undefined)}><X size={12} /></button></div>}
          <form className="composer" onSubmit={(event) => { event.preventDefault(); runPrompt(brief); }}>
            <textarea ref={consoleInput} value={brief} maxLength={4000} aria-label="Agent brief" placeholder="Describe a change or enter a command…"
              onChange={(event) => setBrief(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); runPrompt(brief); } }} />
            {running ? <button type="button" title="Stop agent" aria-label="Stop agent" onClick={() => { void stop(); void refresh(); }}><Square size={14} /></button>
              : <button type="submit" aria-label="Send to agent" disabled={!brief.trim() || !revision}><ArrowUp size={17} /></button>}
          </form>
        </section>}
      </section>

      <Tabs render={<aside />} className="inspector-panel" aria-label="Canvas inspector" value={inspector}
        onValueChange={(value) => { if (value) setInspector(value); }}>
        <TabsList className="panel-tabs inspector-tabs" aria-label="Inspector panels">
          <TabsTab className="tab" value="properties">Inspector</TabsTab>
          <TabsTab className="tab" value="verify"><ScanLine size={15} /> Verify
            {issueCount > 0 && <span className="tab-count">{issueCount}</span>}
          </TabsTab>
          <TabsTab className="tab" value="history">History</TabsTab>
        </TabsList>
        <TabsPanel value="verify" className="verify-scroll">
          <div className="verify-heading"><h1>Verification</h1>
            <IconButton label="Run verification" onClick={async () => {
              const next = await refresh();
              if (next) setNotice({ message: `${next.report.passed}/${next.report.total} checks passed · revision ${next.revision}` });
            }}><RotateCw size={15} /></IconButton>
          </div>
          <div className={`report-card ${allPassed ? 'all-pass' : ''}`}>
            <span className="report-symbol">{allPassed ? <CircleCheck size={19} /> : <CircleAlert size={19} />}</span>
            <div><strong>{allPassed ? 'All checks passed' : needsReview && !report.checks.some((check) => check.status === 'fail') ? 'Needs review'
              : `${issueCount} ${issueCount === 1 ? 'issue' : 'issues'} found`}</strong>
              <p>{report.passed} of {report.total} checks passed</p></div>
            <div className="report-meter" style={{ gridTemplateColumns: `repeat(${report.total}, 1fr)` }} aria-label={`${report.passed} of ${report.total} checks passed`}>
              {report.checks.map((check) => <span key={check.id} className={check.status} />)}
            </div>
          </div>
          {issueCount > 0 && <section className="issue-section">
            <h2>Findings <span>{issueCount}</span></h2>
            <div className="issue-list">
              {report.issues.map((issue) => <button key={issue.id} className="issue-card" onClick={() => selectIssue(issue.layerId)}>
                <span className="issue-icon"><CircleAlert size={15} /></span>
                <span className="issue-content"><strong>{issue.checkId === 'contrast' && issue.severity === 'warning'
                  ? 'Contrast needs review' : issueTitles[issue.checkId] || 'Canvas issue'}</strong><small>{issue.message}</small></span>
                <Crosshair className="issue-focus" size={14} aria-label="Locate layer" />
              </button>)}
            </div>
            {fixable && <button className="fix-button" disabled={working || !revision} onClick={() => void repair()}>
              <Sparkles size={15} /> {working ? 'Applying fixes…' : 'Auto-fix issues'}
            </button>}
          </section>}
          <section className="checks-section">
            <h2>Check results</h2>
            <div className="checks-list">
              {report.checks.map((check) => <div className="check-row" key={check.id} title={check.detail}>
                {check.status === 'pass' ? <CircleCheck size={15} className="check-pass" /> : <CircleAlert size={15} className="check-fail" />}
                <span>{check.label}</span><small className={check.status}>{check.status === 'pass' ? 'Pass' : check.status === 'warn' ? 'Needs review' : 'Flagged'}</small>
              </div>)}
            </div>
          </section>
          <div className="verify-note"><ScanLine size={13} /> Revision {revision || '…'}</div>
        </TabsPanel>
        <TabsPanel value="history" className="history-scroll">
          <div className="verify-heading"><h1>Version history</h1><History size={17} /></div>
          <p className="history-note">Every saved change is kept. Restoring a version creates a new revision.</p>
          {historyLoading && !historyEntries.length && <p className="history-note" role="status">Loading revisions…</p>}
          <ol className="revision-list">
            {historyEntries.map((entry) => <li key={entry.revision} className={entry.revision === revision ? 'current-revision' : ''}>
              <div className="revision-heading"><strong>Revision {entry.revision}</strong>{entry.revision === revision && <span>Current</span>}</div>
              <p>{entry.summary}</p>
              <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>
              {entry.revision !== revision && <Button type="button" className="restore-button" disabled={working || !revision}
                onClick={() => void restoreRevision(entry.revision)}><RotateCw size={13} /> Restore this version</Button>}
            </li>)}
          </ol>
        </TabsPanel>
        <TabsPanel value="properties" className="property-scroll">
          <h1>{selectedLayer ? 'Layer properties' : 'Artboard properties'}</h1>
          {selectedLayer ? <fieldset className="properties" disabled={working || !revision} key={`${JSON.stringify(selectedLayer)}:${propertyReset}`}>
            <div className="property-kind">{selectedLayer.kind} layer</div>
            <label>Name<input defaultValue={selectedLayer.name} onBlur={(event) => {
              if (event.target.value !== selectedLayer.name) void patchLayer(selectedLayer, { name: event.target.value });
            }} /></label>
            {selectedLayer.kind === 'text' && <label>Content<textarea defaultValue={selectedLayer.text} onBlur={(event) => {
              if (event.target.value !== selectedLayer.text) void patchLayer(selectedLayer, { text: event.target.value });
            }} /></label>}
            {'x' in selectedLayer && <div className="property-grid">
              {(['x', 'y'] as const).map((axis) => <label key={axis}>{axis.toUpperCase()}<input type="number" defaultValue={selectedLayer[axis]} onBlur={(event) => {
                const value = event.target.valueAsNumber;
                if (Number.isFinite(value) && value !== selectedLayer[axis]) void patchLayer(selectedLayer, { [axis]: value });
              }} /></label>)}
            </div>}
            {'width' in selectedLayer && 'height' in selectedLayer && <div className="property-grid">
              {(['width', 'height'] as const).map((dimension) => <label key={dimension}>{dimension === 'width' ? 'Width' : 'Height'}<input type="number" min="1" step="1" defaultValue={selectedLayer[dimension]} onBlur={(event) => {
                const value = event.target.valueAsNumber;
                if (Number.isFinite(value) && value > 0 && value !== selectedLayer[dimension]) void patchLayer(selectedLayer, { [dimension]: value });
              }} /></label>)}
            </div>}
            {selectedLayer.kind === 'text' && <label>Font size<input type="number" min="1" step="1" defaultValue={selectedLayer.fontSize} onBlur={(event) => {
              const value = event.target.valueAsNumber;
              if (Number.isFinite(value) && value > 0 && value !== selectedLayer.fontSize) void patchLayer(selectedLayer, { fontSize: value });
            }} /></label>}
            {'fill' in selectedLayer && <label>Fill<input defaultValue={selectedLayer.fill} onBlur={(event) => {
              if (event.target.value !== selectedLayer.fill) void patchLayer(selectedLayer, { fill: event.target.value });
            }} /></label>}
            {selectedLayer.kind === 'mesh' && <label>Primitive<select value={selectedLayer.shape} onChange={(event) => void patchLayer(selectedLayer, { shape: event.target.value })}>
              <option value="cube">Cube</option><option value="sphere">Sphere</option><option value="torus">Torus</option>
            </select></label>}
            <button className="remove-layer" onClick={async () => {
              if (await mutate({ action: 'apply', operations: [{ op: 'remove', id: selectedLayer.id }] })) setSelected(undefined);
            }}>Delete layer</button>
          </fieldset> : <fieldset className="properties" disabled={working || !revision} key={`${documentId}:${propertyReset}`}>
            <div className="property-kind">Select a layer to inspect its properties.</div>
            <label>Document name<input key={scene.name} defaultValue={scene.name} onBlur={(event) => {
              if (event.target.value.trim() && event.target.value !== scene.name) void mutate({ action: 'replace', scene: { ...scene, name: event.target.value } });
            }} /></label>
            <div className="property-grid"><label>Width<input readOnly value={scene.width} /></label><label>Height<input readOnly value={scene.height} /></label></div>
            <label>Background<input key={scene.background} defaultValue={scene.background} onBlur={(event) => {
              if (event.target.value !== scene.background) void mutate({ action: 'replace', scene: { ...scene, background: event.target.value } });
            }} /></label>
          </fieldset>}
        </TabsPanel>
      </Tabs>
    </main>
    <footer className="status-bar">
      <div><span className="status-led" /> {working ? 'Saving…' : revision ? 'Saved locally' : 'Connecting…'} <span className="status-separator" /> <span className="status-revision">rev {revision || '—'}</span></div>
      <div><span className="protocol-status"><span className="protocol-dot" /> {webMcp ? 'WebMCP registered' : 'MCP / CLI ready'}</span>
        <button className="footer-console" onClick={() => setConsoleOpen(!consoleOpen)} aria-label="Toggle agent console"><SquareTerminal size={14} /></button></div>
    </footer>
  </div>;
}
