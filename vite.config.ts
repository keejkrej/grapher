import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { workspaceMiddleware } from './src/server.ts';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  return {
    plugins: [
      react(),
      {
        name: 'grapher-workspace',
        configureServer(server) {
          const workspace = workspaceMiddleware(env);
          server.middlewares.use(workspace);
          server.httpServer?.once('close', () => workspace.close());
        },
        configurePreviewServer(server) {
          const workspace = workspaceMiddleware(env);
          server.middlewares.use(workspace);
          server.httpServer.once('close', () => workspace.close());
        },
      },
    ],
    server: { host: 'localhost', port: 5173, strictPort: true },
    preview: { host: 'localhost', port: 5173, strictPort: true },
  };
});
