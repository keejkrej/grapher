import { createAgent, registerTools } from '@ui-sdk/react/agent';

export const uiAgent = createAgent();

let unregister: (() => void) | undefined;

export function startUiAgent() {
  unregister?.();
  unregister = registerTools(uiAgent, { allow: () => true });
  return unregister;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => unregister?.());
}
