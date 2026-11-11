import { Capacitor, registerPlugin } from '@capacitor/core';

const NativeModels = registerPlugin('AxiomModels');

function requireAndroid() {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    throw new Error('Axiom native models are available in the Android app.');
  }
}

export async function getNativeDeviceCapabilities() {
  requireAndroid();
  return NativeModels.getDeviceCapabilities();
}
export async function listNativeModels() {
  requireAndroid();
  return (await NativeModels.listLocalModels()).models || [];
}
export async function importNativeModel() {
  requireAndroid();
  return NativeModels.importLocalModel();
}
export async function getNativeHuggingFaceFiles(repo) {
  requireAndroid();
  return (await NativeModels.getHuggingFaceModelFiles({ repo })).files || [];
}
export async function getHuggingFaceAuthStatus() {
  requireAndroid();
  return NativeModels.getHuggingFaceAuthStatus();
}
export async function setHuggingFaceToken(token) {
  requireAndroid();
  return NativeModels.setHuggingFaceToken({ token });
}
export async function clearHuggingFaceToken() {
  requireAndroid();
  return NativeModels.clearHuggingFaceToken();
}
export async function downloadNativeModel(options) {
  requireAndroid();
  return NativeModels.downloadHuggingFaceModel(options);
}
export async function cancelNativeModelDownload(id) {
  requireAndroid();
  return NativeModels.cancelModelDownload({ id });
}
export async function deleteNativeModel(id) {
  requireAndroid();
  return NativeModels.deleteLocalModel({ id });
}
export async function loadNativeModel(id, options = {}) {
  requireAndroid();
  return NativeModels.loadLocalModel({ id, ...options });
}
export async function unloadNativeModel() {
  requireAndroid();
  return NativeModels.unloadLocalModel();
}
export async function generateNativeText(prompt, options = {}) {
  requireAndroid();
  return NativeModels.generateLocal({ messages: prompt, ...options });
}
export async function cancelNativeGeneration() {
  requireAndroid();
  return NativeModels.cancelLocalGeneration();
}
export async function addNativeModelListener(event, callback) {
  requireAndroid();
  return NativeModels.addListener(event, callback);
}
