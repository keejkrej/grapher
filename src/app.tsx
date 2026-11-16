import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import type { UIMessage } from 'ai';
import { Button } from '@ui-sdk/react/button';
import { Menu, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuTrigger } from '@ui-sdk/react/menu';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs';
import {
  ArrowDownToLine, ArrowUp, Box, Braces, Check, ChevronDown, Circle, CircleAlert, CircleCheck, CodeXml, Crosshair,
  Eye, EyeOff, Focus, Hand, Image, Layers3, Minus, MousePointer2, Orbit, Plus, Redo2, RotateCw, ScanLine, Shapes,
  Sparkles, Square, SquareTerminal, Type, Undo2, X,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent, ReactNode } from 'react';
import { layerBounds, sceneSvg, verifyScene } from './engine';
import type { Layer, Scene } from './engine';
import { examples, initialExample } from './examples';
import { useGrapherTools } from './webmcp';
import { workspaceClient } from './workspace-client';
import type { ExportFormat, Workspace } from './workspace-client';

const client = workspaceClient(location.origin);
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
};
const issueTitles: Record<string, string> = {
  bounds: 'Layer outside canvas', contrast: 'Low text contrast', labels: 'Missing label', assets: 'Invalid raster asset',
  geometry: 'Invalid layer geometry', unique: 'Duplicate layer ID', canvas: 'Invalid artboard', visibility: 'Empty canvas',
};
const formats: { format: ExportFormat; label: string; note: string }[] = [
  { format: 'svg', label: 'SVG', note: 'Editable vector artwork' },
  { format: 'png', label: 'PNG', note: 'Raster image' },
  { format: 'glb', label: 'GLB', note: '3D meshes' },
  { format: 'json', label: 'JSON', note: 'Scene source' },
];

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
  const detail = sampleAppearance[sampleKey as keyof typeof sampleAppearance];
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
  const [workspace, setWorkspace] = useState(starter);
  const [selected, setSelected] = useState<string>();
  const [sideTab, setSideTab] = useState<'layers' | 'examples'>('layers');
  const [inspector, setInspector] = useState<'verify' | 'properties'>('verify');
  const [mode, setMode] = useState<'canvas' | 'mesh' | 'source'>('canvas');
  const [menu, setMenu] = useState<'examples' | 'export'>();
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
  const latest = useRef(starter);
  const stage = useRef<HTMLDivElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const consoleInput = useRef<HTMLTextAreaElement>(null);
  const drag = useRef<{ x: number; y: number } | undefined>(undefined);
  const { scene, revision, report } = workspace;
  const selectedLayer = scene.layers.find((layer) => layer.id === selected);
  const hasMesh = scene.layers.some((layer) => layer.kind === 'mesh' && layer.visible);
  const fixable = report.issues.some((issue) => issue.fixable);
  const issueCount = report.issues.length;
  const art = useMemo(() => sceneSvg(scene), [scene]);
  const fit = Math.min(1, Math.max(0.15, (size.width - 90) / scene.width), Math.max(0.15, (size.height - 110) / scene.height));
  const scale = fit * zoom;
  const bounds = selectedLayer?.visible ? layerBounds(selectedLayer) : undefined;

  const accept = useCallback((next: Workspace, local = false) => {
    const previous = latest.current;
    const restarted = next.workspaceId !== previous.workspaceId;
    if (!restarted && next.revision < previous.revision) return false;
    if (restarted || next.revision > previous.revision) {
      latest.current = next;
      setWorkspace(next);
      if (!local) {
        setPast([]);
        setFuture([]);
      }
    }
    return true;
  }, []);
  const refresh = useCallback(async () => {
    try {
      const next = await client.inspect();
      accept(next);
      return next;
    } catch (error) {
      setNotice({ message: String(error), error: true });
    }
  }, [accept]);
  const onWebMcpChange = useCallback((next: Workspace) => { accept(next); }, [accept]);
  const webMcp = useGrapherTools(onWebMcpChange);
  const { messages, status, error, sendMessage, stop } = useChat({
    transport,
    onFinish: () => { void refresh(); },
  });
  const running = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    if (!hasMesh && mode === 'mesh') setMode('canvas');
  }, [hasMesh, mode]);

  useEffect(() => {
    void refresh();
    void fetch('/api/config').then((response) => response.json()).then((config) => setModelEnabled(config.modelEnabled)).catch(() => {});
    const interval = window.setInterval(() => {
      void client.inspect().then(accept).catch(() => {});
    }, 2400);
    return () => window.clearInterval(interval);
  }, [accept, refresh]);

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

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setSelected(undefined);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function mutate(input: Parameters<typeof client.edit>[0], remember = true) {
    if (working || !revision) return;
    setWorking(true);
    try {
      const next = await client.edit({ ...input, revision });
      if (!accept(next, true)) return;
      if (next.revision !== revision && remember) {
        setPast((history) => [...history.slice(-19), scene]);
        setFuture([]);
      }
      return next;
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'The canvas update failed.', error: true });
      void refresh();
    } finally {
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

  async function loadExample(key: string) {
    if (!await mutate({ action: 'replace', scene: examples[key] })) return;
    setSelected(undefined);
    setMode('canvas');
    setSideTab('layers');
    setInspector('verify');
    fitCanvas();
  }

  async function repair() {
    const next = await mutate({ action: 'repair' });
    if (!next) return;
    const changes = next.changes?.length ?? 0;
    setNotice({ message: changes ? `Applied ${changes} ${changes === 1 ? 'fix' : 'fixes'} · ${next.report.passed}/${next.report.total} checks passed` : 'No automatic fixes available.' });
  }

  async function exportScene(format: ExportFormat) {
    try {
      const response = await client.export(format);
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

  function pick(event: MouseEvent<HTMLDivElement>) {
    if (tool === 'pan') return;
    const element = (event.target as Element).closest('[data-layer-id]');
    setSelected(element?.getAttribute('data-layer-id') ?? undefined);
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
    if (!text || running) return;
    setBrief('');
    void sendMessage({ text }, { body: { revision: revision || undefined } }).catch(() => {});
  }

  const library = Object.entries(examples).map(([key, item]) =>
    <Button className="example-item" key={key} type="button" disabled={working || !revision} onClick={() => loadExample(key)}>
      <SampleLabel sampleKey={key} name={item.name} active={scene.name === item.name} />
    </Button>);

  return <div className="studio">
    <header className="app-header">
      <div className="header-left">
        <div className="brand"><BrandMark /><span>Grapher</span></div>
        <span className="header-divider" />
        <div className="menu-anchor">
          <Menu open={menu === 'examples'} onOpenChange={(open) => setMenu(open ? 'examples' : undefined)} onAction={loadExample}>
            <MenuTrigger className="document-button">
              <span>{scene.name}</span><ChevronDown size={13} />
            </MenuTrigger>
            <MenuContent className="pop-menu project-menu" aria-label="Load a sample scene" sideOffset={10} align="start">
              <MenuGroup>
                <MenuGroupLabel className="menu-caption">Load a sample scene</MenuGroupLabel>
                {Object.entries(examples).map(([key, item]) =>
                  <MenuItem className="example-item" key={key} value={key} label={item.name} disabled={working || !revision}>
                    <SampleLabel sampleKey={key} name={item.name} active={scene.name === item.name} />
                  </MenuItem>)}
              </MenuGroup>
            </MenuContent>
          </Menu>
        </div>
      </div>
      <div className="header-actions">
        <button className={`agent-button ${consoleOpen ? 'toggled' : ''}`} aria-expanded={consoleOpen} onClick={() => setConsoleOpen(!consoleOpen)}>
          <SquareTerminal size={16} /><span>Agent console</span>
        </button>
        <div className="menu-anchor">
          <Menu open={menu === 'export'} onOpenChange={(open) => setMenu(open ? 'export' : undefined)}
            onAction={(format) => exportScene(format as ExportFormat)}>
            <MenuTrigger className="export-button"><ArrowDownToLine size={15} /> Export <ChevronDown size={12} /></MenuTrigger>
            <MenuContent className="pop-menu export-menu" aria-label="Export scene" sideOffset={10} align="end">
              {formats.map(({ format, label, note }) => <MenuItem key={format} value={format} label={label} disabled={format === 'glb' && !hasMesh}>
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
                  onClick={() => void patchLayer(layer, { visible: !layer.visible })}>
                  {layer.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                </button>
              </div>;
            })}
          </div>
          <div className="layers-bottom"><span className="layer-dot" /> {scene.layers.filter((layer) => layer.visible).length} visible layers</div>
        </TabsPanel>
        <TabsPanel value="examples" className="example-library">{library}</TabsPanel>
      </Tabs>

      <section className="canvas-panel" aria-label="Canvas preview">
        <div className="canvas-toolbar">
          <div className="drawing-tools">
            <IconButton label="Select tool" onClick={() => setTool('select')} active={tool === 'select'}><MousePointer2 size={16} /></IconButton>
            <IconButton label="Pan tool" onClick={() => setTool('pan')} active={tool === 'pan'}><Hand size={16} /></IconButton>
            <span className="tool-divider" />
            <IconButton label="Add rectangle" onClick={() => void addLayer('rect')} disabled={working}><Square size={15} /></IconButton>
            <IconButton label="Add ellipse" onClick={() => void addLayer('ellipse')} disabled={working}><Circle size={15} /></IconButton>
            <IconButton label="Add text" onClick={() => void addLayer('text')} disabled={working}><Type size={16} /></IconButton>
            <IconButton label="Add 3D primitive" onClick={() => void addLayer('mesh')} disabled={working}><Box size={16} /></IconButton>
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
            <div className="artboard" style={{ height: scene.height * scale }} onClick={pick}>
              <div className="artwork" dangerouslySetInnerHTML={{ __html: art }} />
              {bounds && <div className="selection-box" style={{ left: bounds.x * scale, top: bounds.y * scale, width: bounds.width * scale, height: bounds.height * scale }} />}
            </div>
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
            {['Verify the canvas', 'Fix the current issues', 'Load Cryo Cache sample'].map((prompt) =>
              <button key={prompt} onClick={() => runPrompt(prompt)} disabled={running}>{prompt}</button>)}
          </div>
          <form className="composer" onSubmit={(event) => { event.preventDefault(); runPrompt(brief); }}>
            <textarea ref={consoleInput} value={brief} maxLength={4000} aria-label="Agent brief" placeholder="Describe a change or enter a command…"
              onChange={(event) => setBrief(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); runPrompt(brief); } }} />
            {running ? <button type="button" title="Stop agent" aria-label="Stop agent" onClick={() => { void stop(); void refresh(); }}><Square size={14} /></button>
              : <button type="submit" aria-label="Send to agent" disabled={!brief.trim()}><ArrowUp size={17} /></button>}
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
        </TabsList>
        <TabsPanel value="verify" className="verify-scroll">
          <div className="verify-heading"><h1>Verification</h1>
            <IconButton label="Run verification" onClick={async () => {
              const next = await refresh();
              if (next) setNotice({ message: `${next.report.passed}/${next.report.total} checks passed · revision ${next.revision}` });
            }}><RotateCw size={15} /></IconButton>
          </div>
          <div className={`report-card ${issueCount ? '' : 'all-pass'}`}>
            <span className="report-symbol">{issueCount ? <CircleAlert size={19} /> : <CircleCheck size={19} />}</span>
            <div><strong>{issueCount ? `${issueCount} ${issueCount === 1 ? 'issue' : 'issues'} found` : 'All checks passed'}</strong>
              <p>{report.passed} of {report.total} checks passed</p></div>
            <div className="report-meter" aria-label={`${report.passed} of ${report.total} checks passed`}>
              {report.checks.map((check) => <span key={check.id} className={check.status} />)}
            </div>
          </div>
          {issueCount > 0 && <section className="issue-section">
            <h2>Issues <span>{issueCount}</span></h2>
            <div className="issue-list">
              {report.issues.map((issue) => <button key={issue.id} className="issue-card" onClick={() => selectIssue(issue.layerId)}>
                <span className="issue-icon"><CircleAlert size={15} /></span>
                <span className="issue-content"><strong>{issueTitles[issue.checkId] || 'Canvas issue'}</strong><small>{issue.message}</small></span>
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
                <span>{check.label}</span><small className={check.status}>{check.status === 'pass' ? 'Pass' : 'Flagged'}</small>
              </div>)}
            </div>
          </section>
          <div className="verify-note"><ScanLine size={13} /> Revision {revision || '…'}</div>
        </TabsPanel>
        <TabsPanel value="properties" className="property-scroll">
          <h1>{selectedLayer ? 'Layer properties' : 'Artboard properties'}</h1>
          {selectedLayer ? <div className="properties" key={JSON.stringify(selectedLayer)}>
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
            {'fill' in selectedLayer && <label>Fill<input defaultValue={selectedLayer.fill} onBlur={(event) => {
              if (event.target.value !== selectedLayer.fill) void patchLayer(selectedLayer, { fill: event.target.value });
            }} /></label>}
            {selectedLayer.kind === 'mesh' && <label>Primitive<select value={selectedLayer.shape} onChange={(event) => void patchLayer(selectedLayer, { shape: event.target.value })}>
              <option value="cube">Cube</option><option value="sphere">Sphere</option><option value="torus">Torus</option>
            </select></label>}
            <button className="remove-layer" onClick={async () => {
              if (await mutate({ action: 'apply', operations: [{ op: 'remove', id: selectedLayer.id }] })) setSelected(undefined);
            }}>Delete layer</button>
          </div> : <div className="properties">
            <div className="property-kind">Select a layer to inspect its properties.</div>
            <div className="property-grid"><label>Width<input readOnly value={scene.width} /></label><label>Height<input readOnly value={scene.height} /></label></div>
            <label>Background<input key={scene.background} defaultValue={scene.background} onBlur={(event) => {
              if (event.target.value !== scene.background) void mutate({ action: 'replace', scene: { ...scene, background: event.target.value } });
            }} /></label>
          </div>}
        </TabsPanel>
      </Tabs>
    </main>
    <footer className="status-bar">
      <div><span className="status-led" /> {revision ? 'Workspace online' : 'Connecting…'} <span className="status-separator" /> <span className="status-revision">rev {revision || '—'}</span></div>
      <div><span className="protocol-status"><span className="protocol-dot" /> {webMcp ? 'WebMCP registered' : 'MCP / CLI ready'}</span>
        <button className="footer-console" onClick={() => setConsoleOpen(!consoleOpen)} aria-label="Toggle agent console"><SquareTerminal size={14} /></button></div>
    </footer>
  </div>;
}
