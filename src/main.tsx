import { createRoot } from 'react-dom/client';
import { startUiAgent } from './ui-agent';
import { fontCatalog } from './font-catalog';
import { registerFont } from './typography';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

async function start() {
  await Promise.all(fontCatalog.map(async ({ family, file, weight }) => {
    const response = await fetch(`/fonts/${file}`);
    if (!response.ok) throw new Error(`Could not load ${family}. Reload the studio to try again.`);
    const buffer = await response.arrayBuffer();
    registerFont(family, buffer, weight);
    const face = await new FontFace(family, buffer, { weight: String(weight) }).load();
    document.fonts.add(face);
  }));
  const { App } = await import('./app');
  startUiAgent();
  createRoot(document.getElementById('root')!).render(<App />);
}

void start().catch((error: unknown) => {
  document.getElementById('root')!.textContent = error instanceof Error ? error.message : 'The studio could not start.';
});
