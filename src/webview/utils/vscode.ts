declare const acquireVsCodeApi: (() => { postMessage: (message: unknown) => void }) | undefined;

type AxiomDesktopBridge = { postMessage: (message: unknown) => void };
const desktopBridge = (window as unknown as { axiomDesktop?: AxiomDesktopBridge }).axiomDesktop;

export const hasVscodeApi = typeof acquireVsCodeApi !== "undefined";
export const hasAxiomDesktopApi = typeof desktopBridge?.postMessage === "function";

const noopVscode = {
  postMessage: (_message: unknown) => {},
};

export const vscode = hasVscodeApi
  ? acquireVsCodeApi!()
  : hasAxiomDesktopApi
    ? desktopBridge!
    : noopVscode;
