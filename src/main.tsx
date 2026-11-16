import { createRoot } from 'react-dom/client';
import { App } from './app';
import { startUiAgent } from './ui-agent';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

startUiAgent();
createRoot(document.getElementById('root')!).render(<App />);
