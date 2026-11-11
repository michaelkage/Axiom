import { Capacitor, registerPlugin } from '@capacitor/core';

const NativeRuntime = registerPlugin('AxiomRuntime');
export const isNativeAndroid = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

function requireNative() {
  if (!isNativeAndroid()) throw new Error('The native Axiom runtime is available in the Android APK, not in a browser PWA.');
}

export async function getRuntimeInfo() {
  requireNative();
  return NativeRuntime.getRuntimeInfo();
}
export async function listWorkspaces() {
  requireNative();
  return (await NativeRuntime.listWorkspaces()).workspaces || [];
}
export async function createWorkspace(name) {
  requireNative();
  return NativeRuntime.createWorkspace({ name });
}
export async function selectWorkspace(name) {
  requireNative();
  return NativeRuntime.selectWorkspace({ name });
}
export async function startTerminal(options = {}) {
  requireNative();
  return NativeRuntime.startTerminal(options);
}
export async function writeTerminal(sessionId, data) {
  requireNative();
  return NativeRuntime.writeTerminal({ sessionId, data });
}
export async function resizeTerminal(sessionId, rows, cols) {
  requireNative();
  return NativeRuntime.resizeTerminal({ sessionId, rows, cols });
}
export async function stopTerminal(sessionId, interrupt = false) {
  requireNative();
  return NativeRuntime.stopTerminal({ sessionId, interrupt });
}
export async function addRuntimeListener(event, callback) {
  requireNative();
  return NativeRuntime.addListener(event, callback);
}
export async function storeGatewayPairingToken(token) {
  requireNative();
  return NativeRuntime.setGatewayBootstrapToken({ token });
}
export async function registerGatewaySession(gatewayUrl) {
  requireNative();
  return NativeRuntime.registerGatewaySession({ gatewayUrl });
}
export async function consumeGatewayPairingIntent() {
  requireNative();
  return NativeRuntime.consumeGatewayPairingIntent({ gatewayUrl });
}
export async function startBackgroundService(options = {}) {
  requireNative();
  return NativeRuntime.startBackgroundService(options);
}
export async function stopBackgroundService() {
  requireNative();
  return NativeRuntime.stopBackgroundService();
}
export async function setKeepAwake(enabled) {
  requireNative();
  return NativeRuntime.setKeepAwake({ enabled });
}
