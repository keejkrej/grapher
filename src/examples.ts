import type { Layer, Scene } from './engine';

const width = 960;
const height = 656;
const paper = '#F3ECDF';
const ink = '#22221E';
const secondary = '#625B4F';
const amber = '#A63F1F';
const mono = 'Courier New';
const serif = 'Georgia';

function rect(id: string, name: string, x: number, y: number, w: number, h: number, fill: string, rx?: number): Layer {
  return { id, name, visible: true, kind: 'rect', x, y, width: w, height: h, fill, rx };
}

function ellipse(
  id: string, name: string, x: number, y: number, rx: number, ry: number, fill: string, stroke?: string, strokeWidth?: number,
): Layer {
  return { id, name, visible: true, kind: 'ellipse', x, y, rx, ry, fill, stroke, strokeWidth };
}

function text(
  id: string, name: string, value: string, x: number, y: number, fontSize: number,
  fill = ink, fontFamily = mono, align: 'left' | 'center' | 'right' = 'left', fontWeight = 400,
): Layer {
  return { id, name, visible: true, kind: 'text', x, y, text: value, fontSize, fill, fontFamily, fontWeight, align };
}

function path(
  id: string, name: string, d: string, x: number, y: number, w: number, h: number, fill: string,
  stroke?: string, strokeWidth?: number,
): Layer {
  return { id, name, visible: true, kind: 'path', d, fill, stroke, strokeWidth, bounds: { x, y, width: w, height: h } };
}

function line(
  id: string, name: string, x1: number, y1: number, x2: number, y2: number, stroke: string, strokeWidth = 1,
) {
  return path(id, name, `M${x1} ${y1}L${x2} ${y2}`, Math.min(x1, x2), Math.min(y1, y2),
    Math.max(1, Math.abs(x2 - x1)), Math.max(1, Math.abs(y2 - y1)), 'none', stroke, strokeWidth);
}

const orbitalGrid = [
  ...Array.from({ length: 14 }, (_, i) => `M${487 + i * 32} 119V556`),
  ...Array.from({ length: 14 }, (_, i) => `M487 ${134 + i * 32}H923`),
].join(' ');

const orbitTilt = -27;
const orbitAngle = orbitTilt * Math.PI / 180;
const orbitColors = ['#9D7657', '#AD8669', '#AC9B82', '#B6A68D', '#8D785F', '#B9A88D'];
const orbits = [
  [695, 331, 222, 127], [686, 336, 187, 107], [676, 337, 151, 88],
  [672, 339, 122, 71], [665, 344, 95, 56], [660, 347, 71, 43],
];

function orbitPoint(index: number, degrees: number) {
  const [cx, cy, rx, ry] = orbits[index];
  const angle = degrees * Math.PI / 180;
  const x = rx * Math.cos(angle);
  const y = ry * Math.sin(angle);
  return [cx + x * Math.cos(orbitAngle) - y * Math.sin(orbitAngle), cy + x * Math.sin(orbitAngle) + y * Math.cos(orbitAngle)];
}

const orbitLayers = orbits.map(([cx, cy, rx, ry], i) => {
  const dx = rx * Math.cos(orbitAngle);
  const dy = rx * Math.sin(orbitAngle);
  const halfWidth = Math.hypot(dx, ry * Math.sin(orbitAngle));
  const halfHeight = Math.hypot(dy, ry * Math.cos(orbitAngle));
  const d = `M${cx + dx} ${cy + dy} A${rx} ${ry} ${orbitTilt} 1 1 ${cx - dx} ${cy - dy}`
    + ` A${rx} ${ry} ${orbitTilt} 1 1 ${cx + dx} ${cy + dy}`;
  return path(`orbit-${i + 1}`, `Orbit ${i + 1}`, d, cx - halfWidth, cy - halfHeight, halfWidth * 2, halfHeight * 2,
    'none', orbitColors[i], i === 0 ? 1.35 : 1);
});

const points = [[0, -24, 8], [1, 142, 5.5], [2, 34, 7.5], [3, 212, 3.6], [4, 130, 3.1]];
const planetLayers = points.flatMap(([index, angle, radius], i) => {
  const [x, y] = orbitPoint(index, angle);
  return [
    ellipse(`planet-halo-${i}`, `Planet ${i + 1} clearance`, x, y, radius + 3, radius + 3, paper),
    ellipse(`planet-${i}`, `Planet ${i + 1}`, x, y, radius, radius, i === 0 ? amber : ink),
  ];
});

const sunColors = [
  '#B83711', '#C43E0E', '#D1440C', '#DA4B0B', '#E2530D', '#E85B11', '#ED6415', '#EF6B17',
  '#F1731C', '#F37B20', '#F48426', '#F68D2A', '#F7952E', '#F89D34', '#F9A437', '#FAAA3C',
  '#FAB143', '#FBB649', '#FBBB4E', '#FCBF55', '#FCC35C', '#FCC662', '#FCC969', '#FDCB6E',
];

const sunLayers = sunColors.map((color, i) => {
  const radius = 62 - i * 2.33;
  return ellipse(`sun-tone-${i}`, i === 0 ? 'Solar disc' : `Solar shading ${i}`, 652 - i * 0.81,
    326 - i * 0.81, radius, radius, color);
});

const sunGrain = Array.from({ length: 145 }, (_, i) => {
  const angle = i * 2.39996;
  const r = Math.sqrt((i + 0.5) / 145) * 57;
  const x = 652 + Math.cos(angle) * r;
  const y = 326 + Math.sin(angle) * r;
  const size = 0.45 + ((i * 13) % 17) / 32;
  return `M${x.toFixed(2)} ${y.toFixed(2)}h${size.toFixed(2)}v${size.toFixed(2)}h-${size.toFixed(2)}z`;
}).join(' ');

const orbital: Scene = {
  name: 'Orbital Mechanics', width, height, background: paper,
  layers: [
    line('head-rule', 'Header rule', 46, 83, 914, 83, '#867B67'),
    text('masthead', 'Atlas masthead', 'ATLAS OF CELESTIAL MOTION', 48, 60, 13, ink, mono, 'left', 700),
    text('figure-number', 'Plate number', 'PLATE 01  /  DYNAMICS', 913, 60, 12, secondary, mono, 'right'),
    path('diagram-grid', 'Coordinate grid', orbitalGrid, 487, 119, 436, 437, 'none', '#DCD1BE', 0.55),
    path('crosshairs', 'Reference axes', 'M481 341H925M652 113V560M646 134H658M646 550H658M496 335V347M912 335V347',
      481, 113, 444, 447, 'none', '#BBAC91', 0.65),
    path('diagram-ticks', 'Diagram scale marks', 'M487 125V119H493 M897 119H903V125 M487 550V556H493 M897 556H903V550',
      487, 119, 416, 437, 'none', '#9A8B71', 0.9),
    ...orbitLayers,
    ellipse('solar-ring-outer', 'Solar perimeter guide', 652, 326, 76, 76, 'none', '#C19368', 0.8),
    ellipse('solar-ring-inner', 'Solar inner guide', 652, 326, 68, 68, 'none', '#BE7448', 0.7),
    ...sunLayers,
    path('solar-grain', 'Solar halftone', sunGrain, 594, 268, 116, 116, '#DB641C'),
    ...planetLayers,
    path('ascending-indicator', 'Ascending-node leader', 'M844 434h-28l-39-48', 777, 386, 67, 48, 'none', '#89775F', 1),
    ellipse('ascending-point', 'Ascending-node marker', 777, 386, 2.7, 2.7, '#725F49'),
    text('ascending-label', 'Ascending-node label', '02 / ASCENDING NODE', 905, 452, 11, secondary, mono, 'right'),
    path('periapsis-indicator', 'Periapsis leader', 'M869 175h-34l-23 22', 812, 175, 57, 22, 'none', '#89775F', 1),
    ellipse('periapsis-point', 'Periapsis marker', 812, 197, 2.5, 2.5, '#725F49'),
    text('periapsis-label', 'Periapsis label', '01 / PERIAPSIS', 902, 164, 11, secondary, mono, 'right'),
    text('node-caption', 'Figure coordinate annotation', 'REF.  03 / NODE', 906, 544, 11, '#D1C6B3', mono, 'right'),
    text('index', 'Subject index', 'FIG. 01  /  PRINCIPLES OF MOTION', 48, 132, 12, amber, mono, 'left', 700),
    text('headline-top', 'Headline first line', 'Orbital', 42, 231, 106, ink, serif),
    text('headline-bottom', 'Headline second line', 'Mechanics', 40, 324, 88, ink, serif),
    line('copy-rule', 'Introduction rule', 48, 366, 429, 366, '#9C907A'),
    text('intro-1', 'Introduction line one', 'A field guide to the paths drawn', 48, 405, 20, ink, serif),
    text('intro-2', 'Introduction line two', 'by bodies bound to a central mass.', 48, 434, 20, ink, serif),
    ellipse('key-marker', 'Legend orbit symbol', 54, 497, 5, 5, 'none', amber, 1.4),
    text('key-label', 'Legend orbit label', 'ORBITAL PLANE', 68, 501, 11, secondary),
    ellipse('point-symbol', 'Legend body symbol', 217, 497, 4, 4, ink),
    text('point-key', 'Legend body label', 'ORBITING BODY', 231, 501, 11, secondary),
    line('footer-rule', 'Footer rule', 46, 575, 914, 575, '#867B67'),
    text('folio', 'Atlas folio', 'VOL. 01   /   CELESTIAL MECHANICS', 48, 620, 12, ink, mono, 'left', 700),
    text('scale-note', 'Projection note', 'SCHEMATIC PROJECTION  /  NOT TO SCALE', 914, 620, 11, secondary, mono, 'right'),
    rect('registration-tab', 'Edge registration tab', 934, 613, 39, 7, '#B54A26'),
  ],
};

const leafInk = '#263B27';
const leafPanel = '#BCD1A3';
const web: Scene = {
  name: 'Field Notes', width, height, background: '#F5F4EA',
  layers: [
    text('brand', 'Field Notes logotype', 'FIELD NOTES', 49, 59, 22, leafInk, 'Arial', 'left', 700),
    text('nav', 'Navigation links', 'JOURNAL    SPECIES    ABOUT', 905, 58, 13, leafInk, mono, 'right'),
    line('header-rule', 'Header border', 48, 83, 911, 83, '#879379'),
    rect('botany-panel', 'Illustration panel', 520, 108, 390, 460, leafPanel, 4),
    ellipse('botany-halo', 'Pressed specimen halo', 715, 328, 146, 146, '#D1DEBE'),
    path('leaf-stem', 'Central stem', 'M666 469Q717 355 759 212 M707 370Q684 335 646 311 M720 339Q762 334 809 300 M731 299Q709 268 678 246',
      646, 212, 163, 257, 'none', leafInk, 2.2),
    path('left-leaves', 'Left leaf cluster', 'M706 370Q660 371 614 290Q676 276 706 370Z M726 306Q678 299 645 221Q700 225 726 306Z',
      614, 221, 112, 150, '#4B704B'),
    path('right-leaves', 'Right leaf cluster', 'M716 353Q734 298 836 281Q825 333 716 353Z M740 281Q730 221 799 173Q802 236 740 281Z',
      716, 173, 120, 180, '#466546'),
    path('leaf-veins', 'Specimen veins', 'M706 370Q663 313 628 301M726 306Q687 256 655 233M716 353Q774 320 820 296M740 281Q768 217 791 189',
      628, 189, 192, 181, 'none', '#BAD09F', 1),
    text('class', 'Specimen index', 'THE ONLINE HERBARIUM', 49, 181, 13, leafInk, mono, 'left', 700),
    text('title-1', 'Hero title first line', 'A closer', 42, 266, 87, leafInk, serif),
    text('title-2', 'Hero title second line', 'look at life.', 44, 346, 78, leafInk, serif),
    text('description-1', 'Hero description first line', 'An illustrated index of plants', 50, 405, 21, leafInk, serif),
    text('description-2', 'Hero description second line', 'in the places we call home.', 50, 434, 21, leafInk, serif),
    rect('cta', 'Primary action background', 50, 473, 208, 46, leafInk, 23),
    text('cta-text', 'Primary action label', 'EXPLORE THE INDEX', 154, 501, 13, '#F5F4EA', mono, 'center', 700),
    text('specimen-id', 'Specimen caption', 'FOLIO 012  /  PRESSED LEAF', 884, 542, 11, leafInk, mono, 'right'),
    line('footer-rule', 'Footer border', 48, 596, 911, 596, '#879379'),
    text('edition', 'Edition label', 'A FIELD GUIDE FOR EVERYDAY NATURALISTS', 50, 623, 11, leafInk),
  ],
};

const ice = '#CFE4F6';
const mutedIce = '#A6C5E3';
const inventorySprite = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAADkSURBVFhH7ZPBCQIxEEW3Es/e7MGbl+3EJrzYgkexDRsQK7EGRSIRIsObxEncZFHZD++07rzHgl03bdqvbn+5OgmfN5uUbs/uySghMTFpEhITH293RfWQmDg3YFBIvzs5T0xcGiBDwl361OSPPTxWiryV9SWW64MLDAmR7877zQv61GTAJyEp8aCAnBBLXCUgFpIrrhrAEErk38/TLMBD+VcEvIM+NQosKLCgT40CCwos6FOjwIICC/rUZouV81CUgoIU4S59yeWGUESKxZwVQmE1MZcKaS7mGDKamAvC0cXT/m4PypVJN4fS0m8AAAAASUVORK5CYII=';
const game: Scene = {
  name: 'Cryo Cache', width, height, background: '#101A2A',
  layers: [
    rect('preview-field', 'Asset preview field', 45, 91, 870, 401, '#172940', 4),
    path('grid', 'Isometric floor', Array.from({ length: 12 }, (_, i) => `M${99 + i * 39} 466l333 -167 M${279 + i * 39} 299l-165 167`).join(' '),
      99, 299, 785, 167, 'none', '#2A4762', 0.95),
    ellipse('shadow', 'Cache contact shadow', 490, 410, 137, 27, '#122135'),
    { id: 'cache', name: 'Cryogenic cache', visible: true, kind: 'mesh', x: 322, y: 116, width: 330, height: 321,
      shape: 'cube', color: '#8DD5FC', rotation: 22 },
    { id: 'core', name: 'Detached energy core', visible: true, kind: 'mesh', x: 677, y: 276, width: 143, height: 143,
      shape: 'sphere', color: '#618BEE', rotation: 5 },
    rect('sprite-mat', 'Inventory sprite background', 803, 116, 84, 84, '#213852', 4),
    { id: 'sprite', name: 'Raster inventory sprite', visible: true, kind: 'raster', x: 812, y: 125, width: 66, height: 66, src: inventorySprite },
    text('asset-type', 'Asset library label', 'ARTIFACTS  /  GAME ASSET LIBRARY', 48, 59, 13, mutedIce, mono, 'left', 700),
    text('asset-version', 'Version label', 'CRYO SYSTEMS  //  02', 914, 59, 13, mutedIce, mono, 'right'),
    text('model-caption', 'Preview caption', 'PERSPECTIVE STUDY', 68, 123, 12, mutedIce),
    text('sprite-caption', 'Inventory sprite label', '32 × 32 PNG', 844, 219, 11, mutedIce, mono, 'center'),
    text('core-label', 'Energy core label', 'ENERGY CORE', 749, 448, 11, ice, mono, 'center'),
    text('title', 'Asset title', 'Cryo Cache', 48, 569, 62, ice, 'Arial', 'left', 700),
    text('inventory', 'Inventory classification', 'MESH KIT / COLD STORAGE', 911, 554, 13, mutedIce, mono, 'right'),
    line('footer-rule', 'Asset footer border', 48, 595, 912, 595, '#496884'),
    text('model-id', 'Asset identifier', 'ENVIRONMENT PROPS  /  OBJECT 003', 49, 624, 12, mutedIce),
  ],
};

const blue = '#1B2C9F';
const posterPaper = '#E9E5FE';
const signalPaths = Array.from({ length: 12 }, (_, index) => {
  const x = 494 + index * 11;
  const y = 119 + index * 9;
  const d = `M${x} ${y} C${x + 127} ${y - 70}, ${x + 276} ${y + 24}, ${x + 243} ${y + 136}`
    + ` S${x + 96} ${y + 220}, ${x + 120} ${y + 318} S${x + 248} ${y + 367}, ${x + 239} ${y + 397}`;
  return path(`signal-${index}`, `Harmonic wave ${index + 1}`, d, x, y - 70, 276, 467, 'none', blue, 1.9);
});

const poster: Scene = {
  name: 'Night Signal', width, height, background: posterPaper,
  layers: [
    rect('masthead', 'Program banner', 43, 37, 874, 47, blue),
    text('series', 'Program series', 'MUNICIPAL RADIO  /  LIVE FREQUENCIES', 62, 67, 13, posterPaper, mono, 'left', 700),
    text('edition', 'Program edition', 'SERIES 007', 899, 67, 13, posterPaper, mono, 'right', 700),
    ...signalPaths,
    rect('title-field', 'Headline field', 43, 158, 503, 267, posterPaper),
    text('title-top', 'Headline first line', 'NIGHT', 35, 280, 128, blue, 'Arial', 'left', 900),
    text('title-bottom', 'Headline second line', 'SIGNAL', 38, 395, 115, blue, 'Arial', 'left', 900),
    line('info-rule', 'Information rule', 45, 466, 439, 466, blue, 1.5),
    text('program', 'Program details', 'EXPERIMENTAL SOUND AFTER DARK', 46, 497, 13, blue, mono, 'left', 700),
    text('date', 'Broadcast date', '21 NOV  /  22:00', 45, 555, 25, blue, 'Arial', 'left', 700),
    line('footer-rule', 'Footer rule', 44, 600, 916, 600, blue, 1.5),
    text('band', 'Frequency band', '106.8 FM   /   LIVE FROM STUDIO B', 46, 628, 12, blue, mono, 'left', 700),
    text('access', 'Broadcast access', 'FREE BROADCAST', 915, 628, 12, blue, mono, 'right'),
  ],
};

export const examples: Record<string, Scene> = { orbital, web, game, poster };
export const initialExample = 'orbital';
