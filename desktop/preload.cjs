"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("axiomDesktop", Object.freeze({
  postMessage(message) {
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      throw new TypeError("Axiom messages must have a string type.");
    }
    ipcRenderer.send("axiom:webview-message", message);
  },
  project: Object.freeze({
    bootstrap: () => ipcRenderer.invoke("axiom:project-bootstrap"),
    readState: () => ipcRenderer.invoke("axiom:project-state-read"),
    saveContext: context => ipcRenderer.invoke("axiom:project-context-save", context),
    addChange: change => ipcRenderer.invoke("axiom:change-feed-add", change),
    chooseProject: () => ipcRenderer.invoke("axiom:choose-project"),
    listFiles: relativePath => ipcRenderer.invoke("axiom:fs-list", relativePath),
    readFile: relativePath => ipcRenderer.invoke("axiom:fs-read", relativePath),
    writeFile: (relativePath, content) => ipcRenderer.invoke("axiom:fs-write", relativePath, content)
  })
}));

ipcRenderer.on("axiom:host-message", (_event, message) => {
  window.dispatchEvent(new MessageEvent("message", { data: message }));
  if (message && message.type === "project-state-updated") {
    window.dispatchEvent(new Event("axiom-project-state-updated"));
  }
});
