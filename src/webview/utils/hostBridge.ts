type AxiomDesktopBridge = { postMessage: (message: unknown) => void };
const desktopBridge = (window as unknown as { axiomDesktop?: AxiomDesktopBridge }).axiomDesktop;
export const hasAxiomDesktopApi = typeof desktopBridge?.postMessage === "function";
const noopBridge: AxiomDesktopBridge = { postMessage: (_message: unknown) => {} };
export const hostBridge: AxiomDesktopBridge = desktopBridge ?? noopBridge;
