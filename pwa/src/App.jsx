import React, { useEffect, useMemo, useRef, useState } from 'react';
import { connectMcpHttp, connectMcpSse } from './lib/mcpClient.js';
import { runOllamaToolChat } from './lib/ollamaChat.js';
import { runNativeToolChat } from './lib/nativeChat.js';
import NativeModelStore from './components/NativeModelStore.jsx';
import { getNativeDeviceCapabilities, listNativeModels, getNativeHuggingFaceFiles, getHuggingFaceAuthStatus, setHuggingFaceToken, clearHuggingFaceToken, generateNativeText, cancelNativeGeneration, downloadNativeModel, cancelNativeModelDownload, deleteNativeModel, importNativeModel, loadNativeModel as loadNativeModelFile, unloadNativeModel, addNativeModelListener } from './lib/nativeModels.js';
import MarkdownMessage from './components/MarkdownMessage.jsx';
import TerminalPanel from './components/TerminalPanel.jsx';
import RuntimeControls from './components/RuntimeControls.jsx';
import ModelStore from './components/ModelStore.jsx';
import IntegrationGuide from './components/IntegrationGuide.jsx';
import VoiceCapture from './components/VoiceCapture.jsx';
import CodeEditor from './components/CodeEditor.jsx';
import SkillsMarketplace from './components/SkillsMarketplace.jsx';
import { buildSkillSystemPrompt } from './lib/skillRegistry.js';
import { prepareAttachments, buildAttachmentPrompt, buildOutcomeSummary, MAX_TOTAL_ATTACHMENT_BYTES } from './lib/workspaceCapture.js';
import { consumeSharedPayload, hasNativeIOSShareTarget } from './lib/shareTarget.js';
import { getPlatformAdapter } from './lib/platformAdapter.js';
import { redactSecrets, redactValue, redactForExternalContext } from './lib/securityRedaction.js';
import { parseContextMentions, buildContextMentionPrompt } from './lib/contextMentions.js';
import { enqueueOfflinePrompt, listOfflinePrompts, removeOfflinePrompt } from './lib/offlinePromptQueue.js';
import { consumeGatewayPairingIntent, registerGatewaySession } from './lib/axiomRuntime.js';
import { executeTool, listTools, registerTool, serializeToolResult, toOllamaTools } from './lib/toolRegistry.js';
import { registerGitHubTools } from './lib/githubTools.js';
import { registerSupabaseTools } from './lib/supabaseTools.js';
import { Activity, ArrowDown, ArrowUp, Bot, Check, ChevronDown, ChevronRight, CircleHelp, Code2, Copy, Cpu, Database, ExternalLink, FileCode2, Github, Globe2, HardDrive, KeyRound, Layers3, LoaderCircle, Menu, MessageSquare, MoreHorizontal, Plus, Radio, RefreshCw, Send, Server, Settings2, Shield, Smartphone, Sparkles, Square, Terminal, Trash2, Wrench, X, Zap, Paperclip, FileText } from 'lucide-react';

const STORE = 'axiom.mobile.v1';
const defaults = { baseUrl:'http://localhost:11434', model:'', activeTab:'chat', chats:[], tools:[{id:'github',name:'GitHub',description:'Read files, inspect repositories and publish commits.',enabled:false,icon:'github'},{id:'supabase',name:'Supabase',description:'Inspect schemas and run SQL against your project.',enabled:false,icon:'database'}], servers:[], logs:[], settings:{temperature:0.7,stream:true,gatewayUrl:'http://127.0.0.1:8787',githubToken:'',githubRepo:'michaelkage/Axiom',supabaseUrl:'',supabaseKey:'',theme:'dark',accentColor:'#d5ff35',retryAttempts:2} };
const uid = () => Math.random().toString(36).slice(2,10);
const stamp = () => new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
function loadState(){ try { const saved=JSON.parse(localStorage.getItem(STORE)||'{}'); const settings={...defaults.settings,...(saved.settings||{}),githubToken:'',supabaseKey:''}; const servers=(saved.servers||[]).map(({authToken,...server})=>({...server,authToken:''})); return {...defaults,...saved,servers,settings}; } catch { return defaults; } }
function Icon({name,...props}) { const map={github:Github,database:Database}; const C=map[name]||Wrench; return <C {...props}/>; }

export default function App(){
 const platformAdapter=useMemo(()=>getPlatformAdapter(),[]);
 const isNativeAndroidPlatform=platformAdapter.platform==='android';
 const [state,setState]=useState(loadState);
 const [tab,setTab]=useState(state.activeTab||'chat');
 const [draft,setDraft]=useState('');
 const [draftAttachments,setDraftAttachments]=useState([]);
 const [offlineQueuedCount,setOfflineQueuedCount]=useState(0);
 const [retryStatus,setRetryStatus]=useState(null);
 const [bootStatus,setBootStatus]=useState('initializing');
 const attachmentInputRef=useRef(null);
 const [busy,setBusy]=useState(false);
 const [models,setModels]=useState([]);
 const [pullingModel,setPullingModel]=useState('');
 const [pullProgress,setPullProgress]=useState(null);
 const [nativeModels,setNativeModels]=useState([]);
 const [nativeCapabilities,setNativeCapabilities]=useState(null);
 const [nativeLoadedModel,setNativeLoadedModel]=useState('');
 const [nativeProgress,setNativeProgress]=useState(null);
 const [nativeBusy,setNativeBusy]=useState(false);
 const [hfTokenConfigured,setHfTokenConfigured]=useState(false);
 const [nativeValidation,setNativeValidation]=useState(null);
 const [nativeLoadReport,setNativeLoadReport]=useState(null);
 const [nativeValidating,setNativeValidating]=useState(false);
 const nativeValidationCancelRef=useRef(false);
 const [connection,setConnection]=useState('unknown');
 const [diagnostics,setDiagnostics]=useState(null);
 const [diagnosticsBusy,setDiagnosticsBusy]=useState(false);
 const [providerConfig,setProviderConfig]=useState(null);
 const [githubTokenInput,setGithubTokenInput]=useState('');
 const [supabaseKeyInput,setSupabaseKeyInput]=useState('');
 const [supabaseUrlInput,setSupabaseUrlInput]=useState('');
 const [showSettings,setShowSettings]=useState(false);
 const [showOnboarding,setShowOnboarding]=useState(()=>{try{return localStorage.getItem('axiom.onboarding.v2.dismissed')!=='1';}catch{return true;}});
 const [showHistory,setShowHistory]=useState(false);
 const dismissOnboarding=()=>{setShowOnboarding(false);try{localStorage.setItem('axiom.onboarding.v2.dismissed','1');}catch{}};
 const [showLogs,setShowLogs]=useState(false);
 const [expanded,setExpanded]=useState({});
 const [serverUrl,setServerUrl]=useState('');
 const [serverName,setServerName]=useState('');
 const [serverTransport,setServerTransport]=useState('http');
 const [serverToken,setServerToken]=useState('');
 const [serverGatewayId,setServerGatewayId]=useState('');
 const [notice,setNotice]=useState('');
 const [gatewayToken,setGatewayToken]=useState('');
 const [pendingApproval,setPendingApproval]=useState(null);
 const approvalResolver=useRef(null);
 const pairingIntentBusy=useRef(false);
 const approvalDialogRef=useRef(null);
 const bottomRef=useRef(null);
 const settingsDialogRef=useRef(null);
 const settingsTriggerRef=useRef(null);
 const activeRunRef=useRef(null);
 const offlineDraftRef=useRef(null);
 const draftValueRef=useRef(draft);
 const draftAttachmentsValueRef=useRef(draftAttachments);
 draftValueRef.current=draft;
 draftAttachmentsValueRef.current=draftAttachments;
 const restoringOfflineDraftRef=useRef(false);
 const streamTimerRef=useRef(null);
 const integrationCleanup=useRef({});
 const mcpCleanup=useRef({});
 const mcpAttempts=useRef({});
 const mcpRestoreStarted=useRef(false);
 const currentChat=state.chats[0]||null;
 const registeredTools=listTools();
 const messages=currentChat?.messages||[];
 const selectedOllamaModel=models.includes(state.model)?state.model:'';
 const activeModel=nativeLoadedModel||selectedOllamaModel;
 const update=(patch)=>setState(s=>({...s,...patch}));
 useEffect(()=>{
  if(!isNativeAndroidPlatform||!state.settings?.gatewayUrl)return;
  let active=true;
  const consumePairing=async()=>{
   if(!active||pairingIntentBusy.current||document.visibilityState!=='visible')return;
   pairingIntentBusy.current=true;
   try{
    const result=await consumeGatewayPairingIntent(state.settings.gatewayUrl);
    if(result?.paired&&active){
     const session=await registerGatewaySession(state.settings.gatewayUrl);
     if(!active)return;
     setGatewayToken(session.token);
     setNotice('Gateway paired automatically. Its bootstrap credential is encrypted in Android Keystore.');
     log('success','Gateway paired automatically','Axiom validated the handoff, encrypted the bootstrap credential in Android Keystore, and registered the runtime session.');
    }
   }catch(error){if(active)setNotice('Gateway pairing could not complete: '+error.message);}
   finally{pairingIntentBusy.current=false;}
  };
  void consumePairing();
  const pairingPoll=setInterval(()=>{void consumePairing();},1500);
  const renew=()=>{if(document.visibilityState==='visible')registerGatewaySession(state.settings.gatewayUrl).then(result=>{if(active)setGatewayToken(result.token);}).catch(()=>{});};
  renew();
  document.addEventListener('visibilitychange',renew);
  window.addEventListener('online',renew);
  const interval=setInterval(renew,6*60*60*1000);
  return()=>{active=false;clearInterval(pairingPoll);document.removeEventListener('visibilitychange',renew);window.removeEventListener('online',renew);clearInterval(interval);};
 },[state.settings?.gatewayUrl]);
 useEffect(()=>{const timer=setTimeout(()=>{const settings={...state.settings,githubToken:'',supabaseKey:''};const servers=(state.servers||[]).map(({authToken,...server})=>({...server,authToken:''}));const chats=(state.chats||[]).slice(0,40).map(chat=>({...chat,messages:(chat.messages||[]).slice(-300)}));const persisted={...state,chats:chats.map(chat=>({...chat,messages:chat.messages.map(({images,...message})=>message)})),logs:(state.logs||[]).slice(0,100),settings,servers,activeTab:tab};try{localStorage.setItem(STORE,JSON.stringify(persisted));}catch(error){setNotice('Local storage is full. Export or remove older conversations to keep saving new messages.');}},650);return()=>clearTimeout(timer);},[state,tab]);
 useEffect(()=>{bottomRef.current?.scrollIntoView({behavior:busy?'auto':'smooth'});},[messages,busy]);
 useEffect(()=>()=>{activeRunRef.current?.abort(new DOMException('Axiom view closed','AbortError'));},[]);
 useEffect(()=>{
  let active=true;
  const refreshQueue=async()=>{
   try{
    const queued=await listOfflinePrompts();
    if(!active)return;
    setOfflineQueuedCount(queued.length);
    if(navigator.onLine&&queued.length&&!draftValueRef.current.trim()&&!draftAttachmentsValueRef.current.length&&!restoringOfflineDraftRef.current){
     const next=queued[0];
     restoringOfflineDraftRef.current=true;
     offlineDraftRef.current=next.id;
     setDraft(next.prompt);
     setDraftAttachments(next.attachments||[]);
     setNotice('Restored queued offline draft. Review it and press Send when ready.');
    }
   }catch(error){if(active)setNotice('Offline queue unavailable: '+error.message);}
  };
  refreshQueue();
  window.addEventListener('online',refreshQueue);
  return()=>{active=false;window.removeEventListener('online',refreshQueue);};
 },[]);

 const log=(kind,title,detail='')=>setState(s=>({...s,logs:[{id:uid(),kind,title:redactSecrets(String(title)),detail:typeof detail==='string'?redactSecrets(detail):JSON.stringify(redactValue(detail)),time:stamp()},...s.logs].slice(0,100)}));

 async function refreshNativeModels(){
  if(!isNativeAndroidPlatform)return;
  try{
   const [capabilities,installed,hfAuth]=await Promise.all([getNativeDeviceCapabilities(),listNativeModels(),getHuggingFaceAuthStatus()]);
   setNativeCapabilities(capabilities);
   setNativeModels(installed);
   setNativeLoadedModel(capabilities.loadedModel||'');
   setHfTokenConfigured(Boolean(hfAuth.configured));
  }catch(error){setNotice('Native model library could not be read: '+error.message);}
 }
 useEffect(()=>{
  if(!isNativeAndroidPlatform)return;
  let active=true;
  let progressListener=null;
  refreshNativeModels();
  addNativeModelListener('modelDownloadProgress',event=>{if(active)setNativeProgress(event);}).then(listener=>{progressListener=listener;}).catch(()=>{});
  return()=>{active=false;progressListener?.remove?.();};
 },[]);
 async function installNativeModel(options){
  if(nativeBusy)return;
  setNativeBusy(true);setNativeProgress({percent:0,status:'Preparing private download',downloadedBytes:0,totalBytes:options.sizeBytes||0});
  try{
   const installed=await downloadNativeModel(options);
   await refreshNativeModels();
   setNativeProgress({percent:100,status:'Installed',downloadedBytes:installed.sizeBytes,totalBytes:installed.sizeBytes});
   setNotice('Model installed and SHA-256 checked: '+installed.id);
   log('success','Native model installed',installed.id+' · SHA-256 '+installed.sha256);
  }catch(error){setNotice('Native model download failed: '+error.message);log('error','Native model download failed',error.message);}
  finally{setNativeBusy(false);}
 }
 async function importNativeModelFile(){
  if(nativeBusy)return;
  setNativeBusy(true);
  try{
   const imported=await importNativeModel();
   await refreshNativeModels();
   setNotice('GGUF model imported and SHA-256 checked: '+imported.id+'. Load it from the private model library when ready.');
   log('success','Native GGUF imported',imported.id+' · SHA-256 '+imported.sha256);
  }catch(error){
   if(!/cancelled/i.test(error.message||''))setNotice('Could not import GGUF model: '+error.message);
  }finally{setNativeBusy(false);}
 }
 async function activateNativeModel(id, requestedContext=2048){
  if(nativeBusy||nativeValidating)return;
  setNativeValidation(null);
  setNativeLoadReport(null);
  const model=nativeModels.find(item=>item.id===id);
  const available=Number(nativeCapabilities?.availableRamBytes||0);
  const estimated=Number(model?.sizeBytes||0)*1.4+512*1024*1024;
  if(available&&estimated>available*0.8){
   setNotice('This model is too large for the currently available RAM. Choose a smaller quantization or close other apps first.');
   return;
  }
  setNativeBusy(true);
  try{
   const effectiveContext=available&&available<3*1024*1024*1024?Math.min(requestedContext,1024):Math.min(requestedContext,4096);
   const gpuLayers=nativeCapabilities?.gpuOffloadSupported&&nativeCapabilities?.vulkanDeviceAvailable?-1:0;
   const beforeLoad=await getNativeDeviceCapabilities();
   const loadStarted=performance.now();
   const result=await loadNativeModelFile(id,{contextSize:effectiveContext,threads:Math.max(1,Math.min(nativeCapabilities?.cpuCores||4,6)),gpuLayers});
   const loadWallTimeMs=Math.round(performance.now()-loadStarted);
   const afterLoad=await getNativeDeviceCapabilities();
   setNativeLoadReport({model:id,wallTimeMs:loadWallTimeMs,before:beforeLoad,after:afterLoad,requestedGpuLayers:afterLoad.requestedGpuLayers??gpuLayers});
   setNativeLoadedModel(id);
   await refreshNativeModels();
   setNotice('Native model loaded. Chat will now use on-device llama.cpp inference.');
   log('success','Native model loaded',JSON.stringify({...result,loadWallTimeMs,before:beforeLoad,after:afterLoad}));
  }catch(error){setNotice('Could not load native model: '+error.message);log('error','Native model load failed',error.message);}
  finally{setNativeBusy(false);}
 }
 async function deactivateNativeModel(){
  if(nativeBusy||nativeValidating)return;
  setNativeBusy(true);
  try{await unloadNativeModel();setNativeLoadedModel('');setNativeLoadReport(null);setNativeValidation(null);await refreshNativeModels();setNotice('Native model unloaded and memory released.');}
  catch(error){setNotice('Could not unload native model: '+error.message);}
  finally{setNativeBusy(false);}
 }
 async function removeNativeModel(id){
  if(nativeBusy)return;
  setNativeBusy(true);
  try{await deleteNativeModel(id);await refreshNativeModels();setNotice('Model removed from Axiom private storage.');}
  catch(error){setNotice('Could not delete model: '+error.message);}
  finally{setNativeBusy(false);}
 }

 async function saveHuggingFaceToken(token){
  try{await setHuggingFaceToken(token);setHfTokenConfigured(true);setNotice('Hugging Face read token encrypted in Android Keystore.');}
  catch(error){setNotice('Could not save Hugging Face token: '+error.message);throw error;}
 }
 async function removeHuggingFaceToken(){
  try{await clearHuggingFaceToken();setHfTokenConfigured(false);setNotice('Hugging Face token removed from Android Keystore.');}
  catch(error){setNotice('Could not remove Hugging Face token: '+error.message);}
 }
 async function cancelNativeValidation(){
  nativeValidationCancelRef.current=true;
  try{await cancelNativeGeneration();}catch(error){setNotice('Could not cancel validation: '+error.message);}
 }
 async function runNativeValidation(){
  if(!nativeLoadedModel||nativeValidating)return;
  setNativeValidating(true);
  nativeValidationCancelRef.current=false;
  setNativeValidation(null);
  const rounds=[];
  const samples=[];
  const validationStarted=performance.now();
  let before=null;
  let after=null;
  let telemetryTimer=null;
  let telemetryBusy=false;
  const captureTelemetry=async()=>{
   if(telemetryBusy)return null;
   telemetryBusy=true;
   try{
    const snapshot=await getNativeDeviceCapabilities();
    samples.push({
     elapsedMs:Math.round(performance.now()-validationStarted),
     availableRamBytes:snapshot.availableRamBytes,
     processPssBytes:snapshot.processPssBytes,
     batteryTemperatureC:snapshot.batteryTemperatureC,
     thermalStatus:snapshot.thermalStatus,
     requestedGpuLayers:snapshot.requestedGpuLayers,
     vulkanDeviceName:snapshot.vulkanDeviceName||''
    });
    return snapshot;
   }finally{telemetryBusy=false;}
  };
  const prompts=[
   'Write a short checklist about keeping a mobile phone cool during on-device AI inference. Include several numbered points.',
   'Explain why available RAM can decrease during GGUF model inference. Use concise bullet points.',
   'Describe three ways to reduce memory pressure during local language model generation.',
   'Explain the difference between CPU inference and Vulkan GPU layer offload in a few sentences.',
   'Summarize what a developer should record when benchmarking on-device language model performance.'
  ];
  try{
   before=await getNativeDeviceCapabilities();
   samples.push({elapsedMs:0,availableRamBytes:before.availableRamBytes,processPssBytes:before.processPssBytes,batteryTemperatureC:before.batteryTemperatureC,thermalStatus:before.thermalStatus,requestedGpuLayers:before.requestedGpuLayers,vulkanDeviceName:before.vulkanDeviceName||''});
   telemetryTimer=setInterval(()=>{void captureTelemetry().catch(()=>{});},1500);
   for(let index=0;index<prompts.length;index++){
    if(nativeValidationCancelRef.current)break;
    let firstTokenAt=null;
    const started=performance.now();
    const tokenListener=await addNativeModelListener('nativeModelToken',()=>{if(firstTokenAt===null)firstTokenAt=performance.now();});
    try{
     const result=await generateNativeText([{role:'user',content:prompts[index]}],{maxTokens:96});
     const roundDevice=await captureTelemetry();
     rounds.push({
      round:index+1,
      wallTimeMs:Math.round(performance.now()-started),
      firstTokenMs:firstTokenAt===null?null:Math.round(firstTokenAt-started),
      outputChars:String(result.text||'').length,
      output:String(result.text||'').slice(0,160),
      cancelled:Boolean(result.cancelled),
      availableRamBytes:roundDevice?.availableRamBytes??null,
      processPssBytes:roundDevice?.processPssBytes??null,
      batteryTemperatureC:roundDevice?.batteryTemperatureC??null,
      thermalStatus:roundDevice?.thermalStatus??'unknown'
     });
     if(result.cancelled||nativeValidationCancelRef.current)break;
    }finally{await tokenListener?.remove?.();}
   }
   if(telemetryTimer!==null){clearInterval(telemetryTimer);telemetryTimer=null;}
   while(telemetryBusy)await new Promise(resolve=>setTimeout(resolve,50));
   after=await getNativeDeviceCapabilities();
   samples.push({elapsedMs:Math.round(performance.now()-validationStarted),availableRamBytes:after.availableRamBytes,processPssBytes:after.processPssBytes,batteryTemperatureC:after.batteryTemperatureC,thermalStatus:after.thermalStatus,requestedGpuLayers:after.requestedGpuLayers,vulkanDeviceName:after.vulkanDeviceName||''});
   const availableSamples=samples.map(sample=>sample.availableRamBytes).filter(Number.isFinite);
   const pssSamples=samples.map(sample=>sample.processPssBytes).filter(Number.isFinite);
   const temperatureSamples=samples.map(sample=>sample.batteryTemperatureC).filter(Number.isFinite);
   const telemetrySummary={
    sampleCount:samples.length,
    minAvailableRamBytes:availableSamples.length?Math.min(...availableSamples):null,
    maxProcessPssBytes:pssSamples.length?Math.max(...pssSamples):null,
    maxBatteryTemperatureC:temperatureSamples.length?Math.max(...temperatureSamples):null,
    thermalStatuses:[...new Set(samples.map(sample=>sample.thermalStatus).filter(Boolean))]
   };
   const report={
    timestamp:new Date().toISOString(),
    model:nativeLoadedModel,
    ok:!nativeValidationCancelRef.current&&rounds.length===5&&rounds.every(round=>round.outputChars>0&&!round.cancelled),
    cancelled:nativeValidationCancelRef.current,
    modelLoad:nativeLoadReport,
    rounds,
    samples,
    telemetrySummary,
    before,
    after
   };
   setNativeValidation(report);
   setNotice(report.ok?'On-device inference validation completed. Copy the report for diagnostics.':report.cancelled?'On-device validation was cancelled.':'Validation ran, but one or more rounds returned no output.');
   log(report.ok?'success':report.cancelled?'info':'error','Native device validation',JSON.stringify({model:report.model,rounds:report.rounds,telemetrySummary,before,after}));
  }catch(error){
   if(telemetryTimer!==null)clearInterval(telemetryTimer);
   while(telemetryBusy)await new Promise(resolve=>setTimeout(resolve,50));
   after=await getNativeDeviceCapabilities().catch(()=>null);
   const report={timestamp:new Date().toISOString(),model:nativeLoadedModel,ok:false,cancelled:nativeValidationCancelRef.current,error:error.message,rounds,samples,before,after};
   setNativeValidation(report);
   setNotice('Native validation failed: '+error.message);
   log('error','Native device validation failed',error.message);
  }finally{
   if(telemetryTimer!==null)clearInterval(telemetryTimer);
   setNativeValidating(false);
  }
 }

 const patchChat=(fn,chatId)=>setState(s=>{const chats=[...s.chats];let index=chatId?chats.findIndex(chat=>chat.id===chatId):0;if(index<0&&chatId){chats.unshift({id:chatId,title:'New conversation',messages:[]});index=0;}else if(index<0){chats.unshift({id:uid(),title:'New conversation',messages:[]});index=0;}chats[index]={...chats[index],messages:fn(chats[index].messages||[])};return {...s,chats};});
 const gatewayBase=()=>String(state.settings?.gatewayUrl||'').replace(/\/$/,'');
 const gatewayFetch=async(input,init={})=>{let token=gatewayToken;const requestUrl=typeof input==='string'?input:(input?.url||'');const isGatewayRequest=Boolean(gatewayBase())&&requestUrl.startsWith(gatewayBase()+'/');const send=()=>{const headers=new Headers(init.headers||{});if(token)headers.set('Authorization','Bearer '+token);return fetch(input,{...init,headers});};let response=await send();if(response.status===401&&isGatewayRequest&&isNativeAndroidPlatform){try{const session=await registerGatewaySession(gatewayBase());token=session.token;setGatewayToken(token);response=await send();}catch{}}return response;};

 async function refreshProviderConfig({silent=true}={}) {
  if(!gatewayToken||!gatewayBase()){setProviderConfig(null);return;}
  try {
   const response=await gatewayFetch(gatewayBase()+'/provider-config',{headers:{accept:'application/json'},cache:'no-store'});
   const payload=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error(payload.error||'Gateway returned HTTP '+response.status+'.');
   setProviderConfig(payload);
   if(payload.github?.repository&&payload.github.repository!==state.settings?.githubRepo)update({settings:{...state.settings,githubRepo:payload.github.repository}});
  } catch(error) {
   if(!silent)setNotice('Could not load provider configuration: '+error.message);
  }
 }

 async function saveProviderCredentials(provider) {
  if(!gatewayToken||!gatewayBase()){setNotice('Pair the gateway before saving provider credentials.');return;}
  try {
   const target=new URL(gatewayBase());
   const loopback=['localhost','127.0.0.1','[::1]'].includes(target.hostname);
   if(target.protocol!=='https:'&&!loopback)throw new Error('Provider secrets require an HTTPS gateway. Plain HTTP is allowed only for localhost.');
  } catch(error) {setNotice(error.message||'Enter a valid gateway URL.');return;}
  const payload={};
  if(provider==='github'){
   if(githubTokenInput.trim())payload.githubToken=githubTokenInput.trim();
   payload.githubRepository=(state.settings?.githubRepo||'').trim();
   if(!payload.githubToken&&!providerConfig?.github?.configured){setNotice('Enter a GitHub Personal Access Token first.');return;}
  } else {
   if(supabaseUrlInput.trim())payload.supabaseUrl=supabaseUrlInput.trim();
   if(supabaseKeyInput.trim())payload.supabaseKey=supabaseKeyInput.trim();
   if(!payload.supabaseUrl&&!providerConfig?.supabase?.url)payload.supabaseUrl='';
   if(!payload.supabaseKey&&!providerConfig?.supabase?.configured){setNotice('Enter the Supabase project URL and publishable key.');return;}
  }
  try {
   const response=await gatewayFetch(gatewayBase()+'/provider-config',{method:'PUT',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify(payload)});
   const result=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error(result.error||'Gateway returned HTTP '+response.status+'.');
   setGithubTokenInput('');setSupabaseKeyInput('');setSupabaseUrlInput('');
   await refreshProviderConfig({silent:false});
   const verification=await checkGatewayDiagnostics({silent:true});
   const providerStatus=verification?.services?.[provider];
   if(providerStatus?.status==='connected'){
    setNotice(provider==='github'
     ?'GitHub PAT verified successfully. Enable GitHub in Tools to make repository capabilities available to the local model.'
     :'Supabase credentials verified successfully. Enable Supabase in Tools to make database capabilities available to the local model.');
    log('success',provider+' credentials verified',providerStatus.message);
   }else{
    const detail=providerStatus?.message||'The gateway did not return a verification result. Check the gateway connection and retry.';
    setNotice(provider+' credentials were saved, but verification failed: '+detail);
    log('error',provider+' credential verification failed',detail);
   }
  } catch(error) {setNotice('Could not save '+provider+' credentials: '+error.message);}
 }

 async function clearProviderCredentials(provider) {
  if(!gatewayToken||!gatewayBase())return;
  try {
   const response=await gatewayFetch(gatewayBase()+'/provider-config',{method:'PUT',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify(provider==='github'?{clearGithub:true}:{clearSupabase:true})});
   const result=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error(result.error||'Gateway returned HTTP '+response.status+'.');
   if(provider==='github')setGithubTokenInput('');else{setSupabaseKeyInput('');setSupabaseUrlInput('');}
   await refreshProviderConfig();await checkGatewayDiagnostics({silent:true});
   setNotice(provider+' credentials removed from the gateway.');
  } catch(error){setNotice('Could not remove '+provider+' credentials: '+error.message);}
 }

  async function checkGatewayDiagnostics({silent=false}={}){
   if(!gatewayToken||!gatewayBase()){if(!silent)setNotice('Pair the authenticated gateway before testing provider integrations.');return null;}
   setDiagnosticsBusy(true);
   try{
    const response=await gatewayFetch(gatewayBase()+'/diagnostics',{headers:{accept:'application/json'},cache:'no-store'});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(payload.error||'Gateway returned HTTP '+response.status+'.');
    setDiagnostics(payload);
    const failed=['github','supabase'].filter(id=>payload.services?.[id]?.status!=='connected');
    if(!silent)setNotice(failed.length?'Diagnostics finished. Review the provider status details below.':'Gateway, GitHub and Supabase checks passed.');
    return payload;
   }catch(error){setDiagnostics(null);if(!silent)setNotice('Integration diagnostics failed: '+error.message);return null;}
   finally{setDiagnosticsBusy(false);}
  }
  useEffect(()=>{if(gatewayToken){checkGatewayDiagnostics({silent:true});refreshProviderConfig();}else{setDiagnostics(null);setProviderConfig(null);}},[gatewayToken,state.settings?.gatewayUrl]);
  useEffect(()=>{if(!diagnostics)return;setState(current=>({...current,tools:current.tools.map(tool=>tool.enabled&&diagnostics.services?.[tool.id]?.status!=='connected'?{...tool,enabled:false}:tool)}));},[diagnostics]);
  async function checkOllama({silent=false,direct=false,gateway=false}={}){
  const useGateway=gateway?Boolean(gatewayToken):!direct&&state.settings?.ollamaConnectionMode!=='direct'&&Boolean(gatewayToken);const base=useGateway?gatewayBase()+'/api/ollama':state.baseUrl.replace(/\/$/,'');
  const previous=connection;
  try { const r=await gatewayFetch(base+'/api/tags'); if(!r.ok) throw new Error('HTTP '+r.status); const data=await r.json(); const installed=(data.models||[]).map(m=>m.name).filter(Boolean); setModels(installed); setState(current=>current.model&&!installed.includes(current.model)?{...current,model:''}:current); setConnection('online'); if(previous!=='online')log('success','Ollama connected',base); return installed; }
  catch(e){setModels([]);setConnection('offline');if(previous!=='offline')log('error','Ollama connection failed',e.message);if(!silent)setNotice('Could not reach Ollama. Check the gateway, URL, and network access.');return []; }
 }
 async function pullModel(name){
  const model=String(name||'').trim();
  if(!model||pullingModel)return;
  const configuredBase=(state.settings?.ollamaConnectionMode==='direct'||!gatewayToken)?state.baseUrl:gatewayBase()+'/api/ollama';const base=configuredBase.endsWith('/')?configuredBase.slice(0,-1):configuredBase;
  setPullingModel(model);setPullProgress({status:'Connecting to model registry',percent:0});setNotice('');
  log('request','Model download started',model);
  try{
   const response=await gatewayFetch(base+'/api/pull',{method:'POST',headers:{'content-type':'application/json',accept:'application/x-ndjson'},body:JSON.stringify({model,stream:true})});
   if(!response.ok){const payload=await response.json().catch(()=>({}));throw new Error(payload.error||'Ollama pull failed with HTTP '+response.status+'.');}
   if(!response.body)throw new Error('Ollama did not return a download stream.');
   const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';let lastStatus='Downloading';let completed=false;
   while(true){
    const {value,done}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});
    const chunks=buffer.split(String.fromCharCode(10));buffer=chunks.pop()||'';
    for(const line of chunks){
     if(!line.trim())continue;
     let event;try{event=JSON.parse(line);}catch{continue;}
     if(event.error)throw new Error(event.error);
     lastStatus=event.status||lastStatus;
     const total=Number(event.total||0),current=Number(event.completed||0);
     const percent=total>0?Math.min(100,Math.round(current/total*100)):event.status==='success'?100:0;
     setPullProgress({status:lastStatus,percent,detail:total>0?Math.round(current/1048576)+' / '+Math.round(total/1048576)+' MB':''});
     if(event.status==='success')completed=true;
    }
    if(done)break;
   }
   if(buffer.trim()){try{const event=JSON.parse(buffer);if(event.error)throw new Error(event.error);if(event.status==='success')completed=true;}catch(error){if(error.message!=='Unexpected end of JSON input')throw error;}}
   if(!completed)throw new Error('Model download ended before Ollama confirmed installation.');
   const installedModels=await checkOllama({silent:true});
   if(!installedModels.includes(model))throw new Error('Ollama completed the pull, but the model is not present in its installed-model list. Refresh the library and try again.');
   update({model});
   log('success','Model installed and selected',model);
   setNotice('Model installed and selected for chat: '+model);
  }catch(error){log('error','Model download failed',error.message);setNotice('Model install failed: '+error.message);}
  finally{setPullingModel('');setPullProgress(null);}
 }
 useEffect(()=>{let active=true;setBootStatus('checking');const timeout=setTimeout(()=>{if(active)setBootStatus('offline');},8000);checkOllama({silent:true}).then(()=>{if(active){clearTimeout(timeout);setBootStatus('ready');}}).catch(()=>{if(active){clearTimeout(timeout);setBootStatus('offline');}});return()=>{active=false;clearTimeout(timeout);};},[state.baseUrl,state.settings?.gatewayUrl,gatewayToken]);
 useEffect(()=>{
  const retry=()=>{if(document.visibilityState==='visible')checkOllama({silent:true});};
  const interval=setInterval(retry,connection==='online'?30000:8000);
  window.addEventListener('online',retry);
  document.addEventListener('visibilitychange',retry);
  return()=>{clearInterval(interval);window.removeEventListener('online',retry);document.removeEventListener('visibilitychange',retry);};
 },[connection,state.baseUrl,state.settings?.gatewayUrl,gatewayToken]);
 useEffect(()=>{if(!pendingApproval)return;const previous=document.activeElement;const dialog=approvalDialogRef.current;dialog?.querySelector('button')?.focus();const onKeyDown=event=>{if(event.key==='Escape'){event.preventDefault();approvalResolver.current?.(false);}};window.addEventListener('keydown',onKeyDown);return()=>{window.removeEventListener('keydown',onKeyDown);previous?.focus?.();};},[pendingApproval]);
 useEffect(()=>{
  if(!showSettings)return;
  const dialog=settingsDialogRef.current;
  const focusable=()=>Array.from(dialog?.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')||[]).filter(element=>element.getAttribute('aria-hidden')!=='true');
  focusable()[0]?.focus();
  const handleKeyDown=event=>{
   if(event.key==='Escape'){event.preventDefault();setShowSettings(false);return;}
   if(event.key!=='Tab')return;
   const items=focusable();
   if(!items.length){event.preventDefault();return;}
   const first=items[0],last=items[items.length-1];
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  };
  window.addEventListener('keydown',handleKeyDown);
  return()=>{window.removeEventListener('keydown',handleKeyDown);settingsTriggerRef.current?.focus();};
 },[showSettings]);
 useEffect(()=>{
  const enabled=new Set(state.tools.filter(item=>item.enabled&&diagnostics?.services?.[item.id]?.status==='connected').map(item=>item.id));
  const signatureFor=id=>id==='github'?`${gatewayToken}|${gatewayBase()}|${state.settings?.githubRepo||''}`:`${gatewayToken}|${gatewayBase()}`;
  for(const [id,entry] of Object.entries(integrationCleanup.current)){
   if(!enabled.has(id)||entry.signature!==signatureFor(id)){entry.cleanup();delete integrationCleanup.current[id];}
  }
  if(!gatewayToken)return;
  for(const id of enabled){
   if(integrationCleanup.current[id])continue;
   try{
    const settings=state.settings||{};
    const cleanup=id==='github'?registerGitHubTools({token:gatewayToken,repository:settings.githubRepo,baseUrl:gatewayBase()+'/api/github'}):registerSupabaseTools({url:gatewayBase()+'/api/supabase',key:gatewayToken});
    integrationCleanup.current[id]={signature:signatureFor(id),cleanup};
    log('success',id+' integration ready',listTools().filter(tool=>tool.name.startsWith(id==='github'?'github_':'supabase_')).length+' tools registered');
   }catch(error){log('error',id+' integration setup failed',error.message);setState(current=>({...current,tools:current.tools.map(tool=>tool.id===id?{...tool,enabled:false}:tool)}));}
  }
 },[gatewayToken,state.tools,state.settings?.githubRepo,state.settings?.gatewayUrl,diagnostics]);

 function stopGeneration(){
  const controller=activeRunRef.current;
  if(!controller||controller.signal.aborted)return;
  controller.abort(new DOMException('Stopped by user','AbortError'));
 }
 async function sendMessage(){
  const prompt=(draft.trim()+buildAttachmentPrompt(draftAttachments)).trim(); if((!draft.trim()&&!draftAttachments.length)||busy)return;
  if(!navigator.onLine&&!nativeLoadedModel&&state.settings?.ollamaConnectionMode!=='direct'){
   try{
    const queued=await enqueueOfflinePrompt({prompt:draft,attachments:draftAttachments});
    const items=await listOfflinePrompts();
    setOfflineQueuedCount(items.length);
    setDraft('');
    setDraftAttachments([]);
    restoringOfflineDraftRef.current=false;
    setNotice('Prompt saved to the offline queue. It will be restored when connectivity returns; review and send it then.');
   }catch(error){setNotice('Could not queue offline prompt: '+error.message);}
   return;
  }
  if(!nativeLoadedModel&&!selectedOllamaModel){setNotice(models.length?'Select an installed model before starting chat.':connection==='online'?'No models installed. Open Models to connect a server, import a GGUF file, or install a model before chatting.':'Connect to a model runtime before starting chat.');return;}
  if(nativeValidating){setNotice('Wait for the on-device validation run to finish before starting chat.');return;}
  const controller=new AbortController();
  activeRunRef.current=controller;
  const signal=controller.signal;
  const chatId=currentChat?.id||uid();
  if(!currentChat)setState(s=>({...s,chats:[{id:chatId,title:'New conversation',messages:[]},...s.chats]}));
  setDraft(''); setBusy(true);
  const imageAttachments=draftAttachments.filter(item=>item.kind==='image');
  const userMsg={id:uid(),role:'user',content:prompt,time:stamp(),attachments:draftAttachments.map(({id,name,type,size,kind})=>({id,name,type,size,kind})),...(!nativeLoadedModel&&imageAttachments.length?{images:imageAttachments.map(item=>item.base64)}:{})};
  if(nativeLoadedModel&&imageAttachments.length)userMsg.content+='\n\nNote: the active native model currently accepts text only; image pixels were not sent to it.';
  setDraftAttachments([]);
  const priorMessages=(currentChat?.messages||[]).slice(-12);
  patchChat(old=>[...old,userMsg],chatId);
  setState(s=>({...s,chats:s.chats.map(chat=>chat.id===chatId?{...chat,title:chat.title==='New conversation'?prompt.slice(0,36):chat.title}:chat)}));
  const base=(state.settings?.ollamaConnectionMode==='direct'||!gatewayToken)?state.baseUrl.replace(/\/$/,''):gatewayBase()+'/api/ollama';
  const assistantId=uid();
  patchChat(old=>[...old,{id:assistantId,role:'assistant',content:'',time:stamp()}],chatId);
  let answer='';
  try{
   const availableTools=toOllamaTools();
   const activeSkills=(currentChat?.skillIds||[]).map(id=>(state.skills||[]).find(skill=>skill.id===id)).filter(Boolean);
   const skillPrompt=buildSkillSystemPrompt(activeSkills,listTools());
   const mentions=parseContextMentions(draft);
   const resolvedMentions=await Promise.all(mentions.map(async mention=>{
    try{
     if(mention.kind==='file'&&platformAdapter.capabilities.projectFiles){
      const file=await platformAdapter.files.read(mention.target);
      return {content:file.content};
     }
     if(mention.kind==='folder'&&platformAdapter.capabilities.projectFiles){
      const entries=await platformAdapter.files.list(mention.target);
      return {content:entries.slice(0,100).map(entry=>(entry.type==='directory'?'[dir] ':'[file] ')+entry.path).join('\\n')};
     }
    }catch(error){return {content:'Unable to resolve: '+redactSecrets(error.message||String(error))};}
    return null;
   }));
   const mentionPrompt=buildContextMentionPrompt(mentions,resolvedMentions);
   const promptMessages=[...(skillPrompt?[{role:'system',content:skillPrompt}]:[]),...priorMessages,userMsg];
   const externalPromptMessages=redactForExternalContext([...(skillPrompt?[{role:'system',content:skillPrompt}]:[]),...(mentionPrompt?[{role:'system',content:mentionPrompt}]:[]),...priorMessages,userMsg]);
   const chatRunner=nativeLoadedModel?runNativeToolChat:runOllamaToolChat;
   const runResult=await chatRunner({
    ...(nativeLoadedModel?{}:{baseUrl:base,fetchImpl:gatewayFetch}),
    model:nativeLoadedModel||selectedOllamaModel,
    messages:externalPromptMessages,
    tools:availableTools,
    signal,
    executeTool,
    serializeToolResult,
    getToolMeta:name=>listTools().find(tool=>tool.name===name),
    confirmTool:(name,args,{signal}={})=>new Promise(resolve=>{const finish=allowed=>{signal?.removeEventListener('abort',onAbort);approvalResolver.current=null;setPendingApproval(null);resolve(allowed);};const onAbort=()=>finish(false);approvalResolver.current=finish;setPendingApproval({name,args});if(signal?.aborted)onAbort();else signal?.addEventListener('abort',onAbort,{once:true});}),
    onText:value=>{answer=value;if(streamTimerRef.current===null)streamTimerRef.current=setTimeout(()=>{streamTimerRef.current=null;patchChat(old=>old.map(m=>m.id===assistantId?{...m,content:answer}:m),chatId);},100);},
    maxRetries:Math.max(0,Math.min(5,Number(state.settings?.retryAttempts??2))),
    onRetry:event=>setRetryStatus(event),
    onEvent:event=>{
     if(event.type==='request')log('request',nativeLoadedModel?'Native llama.cpp inference':'Ollama /api/chat',JSON.stringify({model:event.model,toolCount:event.toolCount,turn:event.turn,stream:true},null,2));
     else if(event.type==='metrics')log('info','Model performance',JSON.stringify(event.metrics,null,2));
     else if(event.type==='tool.request')log('request','Tool: '+event.name,JSON.stringify(event.args,null,2));
     else if(event.type==='tool.completed')log('success','Tool completed: '+event.name,event.result);
     else if(event.type==='tool.failed')log('error','Tool failed: '+event.name,event.error);
     else if(event.type==='tool.declined')log('info','Tool action declined: '+event.name);
    }
   });
   answer=runResult.answer;
   if(offlineDraftRef.current){
    await removeOfflinePrompt(offlineDraftRef.current);
    offlineDraftRef.current=null;
    restoringOfflineDraftRef.current=false;
    setOfflineQueuedCount((await listOfflinePrompts()).length);
   }
   if(streamTimerRef.current!==null){clearTimeout(streamTimerRef.current);streamTimerRef.current=null;}
   patchChat(old=>old.map(m=>m.id===assistantId?{...m,content:answer,metrics:runResult.metrics||null}:m),chatId);
   log('success','Generation complete',(nativeLoadedModel?'Native · ':'Ollama · ')+(nativeLoadedModel||selectedOllamaModel));
  }catch(e){if(streamTimerRef.current!==null){clearTimeout(streamTimerRef.current);streamTimerRef.current=null;}if(answer)patchChat(old=>old.map(m=>m.id===assistantId?{...m,content:answer}:m),chatId);if(signal.aborted){if(!answer)patchChat(old=>old.map(m=>m.id===assistantId?{...m,content:'Generation stopped.'}:m),chatId);log('info','Generation cancelled','Partial assistant output was preserved.');}else{const failureHeading=e?.code==='NATIVE_INFERENCE_FAILED'?'**Local inference error**':e?.code==='INTEGRATION_NOT_ENABLED'?'**Integration unavailable**':'**Generation error**';patchChat(old=>old.map(m=>m.id===assistantId?{...m,content:(answer?answer+'\n\n':'')+failureHeading+'\n\n'+e.message}:m),chatId);log('error',e?.code==='NATIVE_INFERENCE_FAILED'?'Local inference failed':e?.code==='INTEGRATION_NOT_ENABLED'?'Integration unavailable':'Generation failed',e.message);}}
  finally{if(activeRunRef.current===controller)activeRunRef.current=null;setBusy(false);setRetryStatus(null);}
 }
 async function addPromptAttachments(fileList){
  try{const prepared=await prepareAttachments(fileList);const total=[...draftAttachments,...prepared].reduce((sum,item)=>sum+item.size,0);if(draftAttachments.length+prepared.length>8)throw new Error('A prompt can contain at most 8 attachments.');if(total>MAX_TOTAL_ATTACHMENT_BYTES)throw new Error('Combined attachments must stay within 1 MiB per prompt to fit the secure gateway request limit.');setDraftAttachments(current=>[...current,...prepared]);if(prepared.length)setNotice(prepared.length+' attachment(s) ready. Combined size is within the 1 MiB prompt limit.');}
  catch(error){setNotice(error.message||'Could not attach the selected file.');}
  if(attachmentInputRef.current)attachmentInputRef.current.value='';
 }
 function removePromptAttachment(id){setDraftAttachments(items=>items.filter(item=>item.id!==id));}
 function summarizeCurrentThread(){
  if(!currentChat||messages.length<2)return;
  const summary=buildOutcomeSummary(messages,[]);
  patchChat(old=>[...old,{id:uid(),role:'assistant',content:summary,time:stamp(),summary:true}],currentChat.id);
  log('info','Conversation summarized','Generated a structured summary from recorded messages and execution logs. No verification was rerun.');
 }
 useEffect(()=>{
  const shareParams=new URLSearchParams(window.location.search);
  if(shareParams.has('shareError')){setNotice('The operating system could not hand shared content to Axiom. Try sharing text or a smaller file.');window.history.replaceState({},'',window.location.pathname+window.location.hash);return;}
  if(!shareParams.has('shared')&&!hasNativeIOSShareTarget())return;
  let active=true;
  let consuming=false;
  const consume=()=>{
   if(consuming||(!shareParams.has('shared')&&!hasNativeIOSShareTarget()))return;
   consuming=true;
   consumeSharedPayload().then(async payload=>{
    if(!active||!payload)return;
    const sharedText=[payload.title,payload.text,payload.url].filter(Boolean).join('\\n');
    if(sharedText)setDraft(current=>current?current+'\\n'+sharedText:sharedText);
    if(payload.files?.length)await addPromptAttachments(payload.files);
    setTab('chat');setNotice('Shared content loaded into a new Axiom prompt. Review it before sending.');
   }).catch(error=>{if(active)setNotice('Could not load shared content: '+error.message);})
    .finally(()=>{consuming=false;});
  };
  consume();
  const onVisible=()=>{if(document.visibilityState==='visible')consume();};
  window.addEventListener('focus',consume);
  document.addEventListener('visibilitychange',onVisible);
  window.history.replaceState({},'',window.location.pathname+window.location.hash);
  return()=>{active=false;window.removeEventListener('focus',consume);document.removeEventListener('visibilitychange',onVisible);};
 },[]);
 function installSkill(skill){
  if(!skill||!skill.id)return;
  update({skills:[...(state.skills||[]).filter(item=>item.id!==skill.id),skill].slice(-20)});
  log('success','Skill installed',skill.name+' v'+skill.version);
 }
 function toggleTaskSkill(id){
  const skill=(state.skills||[]).find(item=>item.id===id);
  if(!skill)return;
  const available=new Set(listTools().map(tool=>tool.name));
  const missing=(skill.requiredTools||[]).filter(name=>!available.has(name));
  if(missing.length){setNotice('Cannot activate '+skill.name+'. Required tools are unavailable: '+missing.join(', '));return;}
  const chatId=currentChat?.id||uid();
  setState(current=>{
   const chats=[...current.chats];
   const index=chats.findIndex(chat=>chat.id===chatId);
   if(index<0)chats.unshift({id:chatId,title:'New conversation',messages:[],skillIds:[id]});
   else{const active=new Set(chats[index].skillIds||[]);if(active.has(id))active.delete(id);else active.add(id);chats[index]={...chats[index],skillIds:[...active]};}
   return {...current,chats};
  });
  log('info','Task skill toggled',skill.name+' · '+((currentChat?.skillIds||[]).includes(id)?'disabled':'enabled'));
 }
 function toggleIntegration(id){
  if(!gatewayToken){setNotice('Connect the authenticated gateway in Settings before enabling integrations.');return;}
  if(!state.tools.find(tool=>tool.id===id)?.enabled&&diagnostics?.services?.[id]?.status!=='connected'){setNotice('Configure '+(id==='github'?'GitHub PAT and repository':'Supabase project URL and publishable key')+' in Settings, then run Integration health checks.');setShowSettings(true);return;}
  update({tools:state.tools.map(tool=>tool.id===id?{...tool,enabled:!tool.enabled}:tool)});
  log('info',id+' integration '+(state.tools.find(tool=>tool.id===id)?.enabled?'disabled':'requested'));
 }
 function newChat(){setState(s=>({...s,chats:[{id:uid(),title:'New conversation',messages:[]},...s.chats]}));setTab('chat');}
 function deleteCurrentChat(){if(!currentChat)return;setState(s=>({...s,chats:s.chats.filter(chat=>chat.id!==currentChat.id)}));setShowHistory(false);log('info','Conversation deleted',currentChat.title||'New conversation');}
 function addServer(){
  if(!serverUrl.trim()&&!serverGatewayId.trim())return;
  try{
   const parsed=serverUrl.trim()?new URL(serverUrl.trim()):new URL(gatewayBase()+'/api/mcp/'+encodeURIComponent(serverGatewayId.trim()));
   if(!['http:','https:'].includes(parsed.protocol))throw new Error('Use an HTTP or HTTPS MCP endpoint.');
   const gatewayId=serverGatewayId.trim();if(gatewayId&&!/^[a-zA-Z0-9_-]{1,64}$/.test(gatewayId))throw new Error('Invalid gateway MCP server ID.');if(gatewayId&&serverTransport==='sse')throw new Error('Gateway MCP connections require Streamable HTTP.');
   const item={id:uid(),name:serverName.trim()||parsed.host,url:parsed.toString(),transport:serverTransport,authToken:'',gatewayId,status:'unverified',tools:[]};
   update({servers:[item,...state.servers]});log('info','MCP endpoint added',item.url);setServerName('');setServerUrl('');setServerToken('');setServerGatewayId('');
  }catch(error){setNotice(error.message==='Invalid URL'?'Enter a valid MCP endpoint URL.':error.message);}
 }
 async function discoverServer(id){
  const server=state.servers.find(s=>s.id===id); if(!server)return;
  const attempt=(mcpAttempts.current[id]||0)+1;
  mcpAttempts.current[id]=attempt;
  log('request','MCP tools/list',server.url);
  try{
   if(server.gatewayId&&server.transport==='sse')throw new Error('Gateway-managed MCP connections require Streamable HTTP.');
   if(server.transport==='sse'&&server.authToken)throw new Error('Legacy SSE cannot send custom authorization headers in browsers. Use Streamable HTTP or a trusted proxy.');
   const endpoint=server.gatewayId?gatewayBase()+'/api/mcp/'+encodeURIComponent(server.gatewayId):server.url;
   const connection=server.transport==='sse'?await connectMcpSse(server.url):await connectMcpHttp(endpoint,server.gatewayId?{fetchImpl:gatewayFetch}:{token:server.authToken||''});
   if(mcpAttempts.current[id]!==attempt||!state.servers.some(item=>item.id===id)){await connection.close?.();return;}
   mcpCleanup.current[id]?.();
   const tools=connection.tools;
   const cleanups=[];
   try {
    for(const tool of tools){
     const safeName='mcp_'+id.replace(/[^a-zA-Z0-9_]/g,'_')+'_'+tool.name.replace(/[^a-zA-Z0-9_]/g,'_');
     cleanups.push(registerTool({name:safeName,description:tool.description||('MCP tool '+tool.name),inputSchema:tool.inputSchema||{type:'object',properties:{}},requiresApproval:true},async (args,{signal}={})=>{
      const result=server.transport==='sse'
       ?await connection.call('tools/call',{name:tool.name,arguments:args},{signal})
       :await connection.call('tools/call',{name:tool.name,arguments:args},undefined,{signal});
      if(result?.isError)throw new Error((result.content||[]).map(x=>x.text||'').join('\n')||'MCP tool returned an error');
      return result;
     }));
    }
   } catch(error) {
    cleanups.forEach(cleanup=>cleanup());
    connection.close?.();
    throw error;
   }
   mcpCleanup.current[id]=()=>{cleanups.forEach(fn=>fn());connection.close?.();};
   setState(current=>({...current,servers:current.servers.map(s=>s.id===id?{...s,status:'connected',tools}:s)}));
   log('success','MCP discovery',tools.length+' tools registered with Ollama');
  }catch(e){if(mcpAttempts.current[id]!==attempt)return;setState(current=>({...current,servers:current.servers.map(s=>s.id===id?{...s,status:'error'}:s)}));log('error','MCP discovery failed',e.message+' — browser CORS and server transport support may require a local proxy.');}
 }
 useEffect(()=>{if(mcpRestoreStarted.current)return;mcpRestoreStarted.current=true;for(const server of state.servers.filter(s=>s.status==='connected'))discoverServer(server.id);},[]);
 useEffect(()=>{const reconnect=()=>{if(document.visibilityState!=='visible'||!navigator.onLine)return;for(const server of state.servers.filter(item=>item.status==='error'))discoverServer(server.id);};window.addEventListener('online',reconnect);document.addEventListener('visibilitychange',reconnect);return()=>{window.removeEventListener('online',reconnect);document.removeEventListener('visibilitychange',reconnect);};},[state.servers]);
 const nav=[{id:'chat',label:'Chat',icon:MessageSquare},{id:'models',label:'Models',icon:Cpu},{id:'workspace',label:'Files',icon:Code2},{id:'skills',label:'Skills',icon:Sparkles},{id:'terminal',label:'Terminal',icon:Terminal},{id:'tools',label:'Tools',icon:Wrench},{id:'mcp',label:'MCP',icon:NetworkIcon},{id:'logs',label:'Logs',icon:Activity}];
 const theme=state.settings?.theme||'dark';
 const accentColor=/^#[0-9a-f]{6}$/i.test(state.settings?.accentColor||'')?state.settings.accentColor:'#d5ff35';
 return <div data-theme={theme} style={{'--acid':accentColor}} className="min-h-[100dvh] text-slate-100 flex flex-col max-w-3xl mx-auto relative">
  <header className="safe-top sticky top-0 z-30 glass border-b border-white/[.07]">
   <div className="h-[66px] px-4 flex items-center justify-between">
    <button onClick={()=>setTab('chat')} className="flex items-center gap-3 text-left"><div className="w-9 h-9 rounded-xl bg-lime-300 text-slate-950 grid place-items-center shadow-[0_0_28px_rgba(163,230,53,.2)]"><Zap size={21} fill="currentColor"/></div><div><div className="font-bold tracking-[.18em] text-[15px]">AXIOM</div><div className="text-[10px] tracking-[.16em] text-slate-500 uppercase">LOCAL-FIRST / PERSONAL COMPUTING</div></div></button>
    <div className="flex items-center gap-2"><span className={'w-2 h-2 rounded-full '+(connection==='online'?'bg-lime-400 shadow-[0_0_10px_#a3e635]':'bg-slate-600')}/><span className="text-xs text-slate-400 hidden sm:block">{connection==='online'?'Ollama online':connection==='offline'?'Offline':'Connecting'}</span>{busy&&<button onClick={stopGeneration} aria-label="Stop generation" title="Stop generation" className="w-11 h-11 grid place-items-center rounded-xl border border-red-400/30 bg-red-400/10 text-red-300 active:scale-95"><Square size={16} fill="currentColor"/></button>}<button type="button" onClick={()=>setShowOnboarding(true)} aria-label="Open setup guide" title="Setup guide" className="w-11 h-11 grid place-items-center rounded-xl border border-white/10 bg-white/[.04] text-lime-300 active:scale-95"><CircleHelp size={18}/></button><button ref={settingsTriggerRef} onClick={()=>setShowSettings(true)} aria-label="Open settings" className="w-11 h-11 grid place-items-center rounded-xl border border-white/10 bg-white/[.04] active:scale-95"><Settings2 size={18}/></button></div>
   </div>
  </header>
  <main className="flex-1 px-4 pt-5 pb-[calc(11rem+env(safe-area-inset-bottom))]">
   {tab==='chat'&&<section className="flex flex-col min-h-[65vh]">
    <div className="flex items-center justify-between mb-5"><div><p className="text-xs text-lime-300 font-semibold tracking-widest uppercase">Workspace / Chat</p><h1 className="text-2xl font-semibold mt-1 tracking-tight">Think. Build. Verify.</h1></div><div className="flex gap-2">{messages.length>=2&&<button type="button" onClick={summarizeCurrentThread} disabled={busy} title="Summarize this conversation" aria-label="Summarize conversation" className="min-h-11 w-11 grid place-items-center border border-white/10 bg-white/[.04] text-slate-300"><FileText size={15}/></button>}<button onClick={()=>setShowHistory(v=>!v)} className="min-h-11 flex items-center gap-1.5 text-sm rounded-xl px-3 py-2 border border-white/10 bg-white/[.04] text-slate-300"><MessageSquare size={15}/> History</button>{currentChat&&<button onClick={deleteCurrentChat} aria-label="Delete current conversation" title="Delete conversation" className="min-h-11 w-11 grid place-items-center rounded-xl border border-red-400/20 bg-red-400/[.06] text-red-300"><Trash2 size={15}/></button>}<button onClick={newChat} className="min-h-11 flex items-center gap-1.5 text-sm rounded-xl px-3 py-2 bg-lime-300 text-slate-950 font-semibold"><Plus size={16}/> New</button></div></div>{showHistory&&<div className="rounded-2xl border border-white/[.08] bg-[#11151d] p-2 mb-4 space-y-1">{state.chats.length===0?<p className="text-xs text-slate-500 p-3">No saved conversations yet.</p>:state.chats.map(chat=><button key={chat.id} onClick={()=>{setState(current=>{const selected=current.chats.find(item=>item.id===chat.id);return selected?{...current,chats:[selected,...current.chats.filter(item=>item.id!==chat.id)]}:current;});setShowHistory(false);}} className={'w-full text-left p-3 rounded-xl '+(currentChat?.id===chat.id?'bg-lime-300/10 text-lime-200':'hover:bg-white/[.04] text-slate-300')}><div className="text-sm truncate">{chat.title||'New conversation'}</div><div className="text-[10px] text-slate-500 mt-1">{chat.messages?.length||0} messages</div></button>)}</div>}
    <div className="rounded-2xl border border-white/[.08] bg-white/[.025] p-3 flex items-center gap-3 mb-5"><div className="w-11 h-11 rounded-xl bg-lime-300/10 text-lime-300 grid place-items-center"><Cpu size={20}/></div><div className="flex-1 min-w-0"><div className="text-xs text-slate-500">ACTIVE MODEL</div><select aria-label="Active model" value={activeModel} onChange={e=>{const value=e.target.value;if(value===nativeLoadedModel)return;if(nativeLoadedModel)deactivateNativeModel();update({model:value});}} disabled={!nativeLoadedModel&&models.length===0} className="bg-transparent text-sm font-medium w-full outline-none mt-0.5 disabled:opacity-70"><option value="" disabled>{nativeLoadedModel?'Loading native model':models.length?'Select an installed model':nativeModels.length?'Native models installed. Load one in Models.':connection==='online'?'No models installed':connection==='offline'?'Runtime unavailable':'Checking installed models…'}</option>{nativeLoadedModel&&<option value={nativeLoadedModel}>{nativeLoadedModel+' · native'}</option>}{models.filter(m=>m!==nativeLoadedModel).map(m=><option key={m} value={m}>{m}</option>)}</select></div><button type="button" aria-label="Refresh Ollama models" title="Refresh Ollama models" onClick={checkOllama} className="p-2 text-slate-400 hover:text-lime-300"><RefreshCw size={16}/></button></div>
    {messages.length===0?<div className="flex-1 flex flex-col justify-center py-6">
     <div className="text-center mb-5"><div className="w-16 h-16 mx-auto rounded-[22px] bg-lime-300/10 border border-lime-300/20 grid place-items-center text-lime-300 mb-4"><Sparkles size={29}/></div><h2 className="text-xl font-semibold">Make something real.</h2><p className="text-sm text-slate-500 mt-2 max-w-[290px] mx-auto leading-relaxed">A local-first workbench for thinking, shipping, and getting unstuck. Your tools stay yours.</p></div>
     <div className="rounded-2xl border border-white/[.09] bg-white/[.025] p-4 text-left">
      <div className="text-xs uppercase tracking-widest text-lime-300 font-semibold mb-3">FIRST RUN / THREE MOVES</div>
      <div className="space-y-3">
       <div className="flex gap-3"><span className="w-7 h-7 shrink-0 rounded-lg bg-lime-300/10 text-lime-200 grid place-items-center text-xs font-bold">1</span><div><div className="text-sm font-medium">01 — Bring a model online</div><p className="text-xs text-slate-500 mt-1">Open Models to browse Ollama and Hugging Face, then connect to an Ollama server or import a GGUF file. Axiom only lists models it actually discovers; nothing is preselected.</p></div></div>
       <div className="flex gap-3"><span className="w-7 h-7 shrink-0 rounded-lg bg-sky-300/10 text-sky-200 grid place-items-center text-xs font-bold">2</span><div><div className="text-sm font-medium">02 — Pair the gateway</div><p className="text-xs text-slate-500 mt-1">Needed for GitHub, Supabase, and remote MCP. The guide tells you what each key does and where it belongs.</p></div></div>
       <div className="flex gap-3"><span className="w-7 h-7 shrink-0 rounded-lg bg-violet-300/10 text-violet-200 grid place-items-center text-xs font-bold">3</span><div><div className="text-sm font-medium">03 — Give it tools</div><p className="text-xs text-slate-500 mt-1">Connect only what the job needs. Axiom asks before protected writes.</p></div></div>
      </div>
      <div className="grid grid-cols-2 gap-2 mt-4">
       <button type="button" onClick={()=>setShowSettings(true)} className="min-h-11 rounded-xl bg-lime-300 text-slate-950 text-xs font-semibold">Set up connections</button>
       <button type="button" onClick={()=>setTab('models')} className="min-h-11 rounded-xl border border-sky-200/20 bg-sky-200/[.06] text-sky-100 text-xs font-semibold">Open model store</button>
      </div>
     </div>
     <div className="grid grid-cols-2 gap-2 w-full mt-4">{['Explain a codebase','Draft a SQL query','Plan a project','Debug an error'].map(x=><button key={x} onClick={()=>setDraft(x)} className="text-left p-3 rounded-xl border border-white/[.08] bg-white/[.025] text-xs text-slate-300 active:bg-white/[.08]">{x}<ChevronRight size={13} className="inline ml-1 text-lime-300"/></button>)}</div>
    </div>:<div className="space-y-5 pb-5">{messages.map(m=><div key={m.id} className={'flex gap-3 '+(m.role==='user'?'flex-row-reverse':'')}><div className={'w-8 h-8 shrink-0 rounded-xl grid place-items-center '+(m.role==='user'?'bg-slate-700':'bg-lime-300/10 text-lime-300')}>{m.role==='user'?<Smartphone size={15}/>:<Bot size={17}/>}</div><div className={'max-w-[calc(100%_-_2.75rem)] sm:max-w-[86%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words '+(m.role==='user'?'bg-lime-300 text-[#111827] font-medium rounded-tr-sm':'bg-white/[.055] border border-white/[.06] rounded-tl-sm text-slate-200')}>{m.attachments?.length>0&&<div className={'mb-2 flex flex-wrap gap-1.5 '+(m.role==='user'?'text-slate-900':'text-slate-300')}>{m.attachments.map(file=><span key={file.id} className="inline-flex items-center gap-1 border border-current/20 px-2 py-1 text-[10px]"><Paperclip size={10}/>{file.name}</span>)}</div>}{m.content?(m.role==='assistant'?<><MarkdownMessage content={m.content}/>{m.metrics&&<div className="mt-3 pt-2 border-t border-white/[.07] grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-2 text-[10px] text-slate-500" aria-label="Model performance"><div><span className="block text-slate-600">First token</span><span className="text-slate-300 tabular-nums">{m.metrics.firstTokenMs==null?'n/a':m.metrics.firstTokenMs+' ms'}</span></div><div><span className="block text-slate-600">Generation</span><span className="text-slate-300 tabular-nums">{m.metrics.tokensPerSecond==null?'n/a':m.metrics.tokensPerSecond+' tok/s'}</span></div><div><span className="block text-slate-600">Model load</span><span className="text-slate-300 tabular-nums">{m.metrics.modelLoadMs==null?'n/a':m.metrics.modelLoadMs+' ms'}</span></div><div><span className="block text-slate-600">Output</span><span className="text-slate-300 tabular-nums">{m.metrics.generatedTokens==null?'n/a':m.metrics.generatedTokens+' tokens'}</span></div><div className="col-span-2 sm:col-span-4 text-slate-600">Prompt: {m.metrics.promptTokens??'n/a'} tokens · {m.metrics.promptTokensPerSecond??'n/a'} tok/s · Elapsed: {m.metrics.wallTimeMs??'n/a'} ms · Ollama: {m.metrics.modelReportedTotalMs??'n/a'} ms · {m.metrics.modelTurns||1} model turn(s)</div></div>}</>:m.content):<span className="text-slate-500">Thinking…</span>}<div className={'text-[10px] mt-2 flex items-center gap-2 '+(m.role==='user'?'text-slate-950 font-medium':'text-slate-600')}><span>{m.time}</span>{m.role==='assistant'&&m.content&&<button type="button" aria-label="Copy assistant response" title="Copy response" onClick={async()=>{try{await navigator.clipboard.writeText(m.content);setNotice('Assistant response copied.');}catch{setNotice('Could not copy response. Check clipboard permissions.');}}} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-slate-700 hover:text-slate-950 active:bg-black/10"><Copy size={12}/><span>Copy</span></button>}</div></div></div>)}{busy&&<div className="text-xs text-lime-300 flex items-center gap-2 pl-11"><LoaderCircle size={13} className="animate-spin"/>{retryStatus?'Attempt '+(retryStatus.attempt+1)+' of '+retryStatus.maxAttempts+' · retrying in '+Math.ceil(retryStatus.delayMs/1000)+'s':'Generating locally'}</div>}<div ref={bottomRef}/></div>}
   </section>}
   {tab==='models'&&(isNativeAndroidPlatform?<NativeModelStore models={nativeModels} capabilities={nativeCapabilities} loadedModel={nativeLoadedModel} progress={nativeProgress} ollamaModels={models} ollamaConnection={connection} ollamaBaseUrl={state.baseUrl} gatewayPaired={Boolean(gatewayToken)} onOllamaBaseUrlChange={value=>update({baseUrl:value})} onOllamaConnect={()=>{update({settings:{...state.settings,ollamaConnectionMode:"direct"}});checkOllama({direct:true});}} onUseGateway={()=>{update({settings:{...state.settings,ollamaConnectionMode:"gateway"}});checkOllama({gateway:true});}} onSelectOllamaModel={model=>{if(nativeLoadedModel)deactivateNativeModel();update({model});setTab("chat");}} busy={nativeBusy||nativeValidating} onRefresh={refreshNativeModels} onImport={importNativeModelFile} onFiles={getNativeHuggingFaceFiles} onDownload={installNativeModel} onCancelDownload={()=>nativeProgress?.id&&cancelNativeModelDownload(nativeProgress.id)} onLoad={activateNativeModel} onUnload={deactivateNativeModel} onDelete={removeNativeModel} hfTokenConfigured={hfTokenConfigured} onSaveHfToken={saveHuggingFaceToken} onClearHfToken={removeHuggingFaceToken} onValidate={runNativeValidation} validation={nativeValidation} validating={nativeValidating} modelLoadReport={nativeLoadReport} onCancelValidate={cancelNativeValidation}/>:<ModelStore models={models} connection={connection} baseUrl={state.baseUrl} onBaseUrlChange={value=>update({baseUrl:value})} onConnect={()=>{update({settings:{...state.settings,ollamaConnectionMode:"direct"}});checkOllama({direct:true});}} onRefresh={()=>checkOllama()} onPullModel={pullModel} onSelectModel={model=>{update({model});setTab('chat');}} pullingModel={pullingModel} pullProgress={pullProgress} disabled={connection!=='online'||Boolean(pullingModel)}/>)}
   {tab==='workspace'&&<CodeEditor/>}
   {tab==='skills'&&<SkillsMarketplace installedSkills={state.skills||[]} activeSkillIds={currentChat?.skillIds||[]} onInstall={installSkill} onToggleActive={toggleTaskSkill}/>}
   {tab==='terminal'&&<TerminalPanel onNotice={setNotice} terminalRows={state.settings?.terminalRows||24} terminalCols={state.settings?.terminalCols||80}/>}
   {tab==='tools'&&<section><p className="text-xs text-lime-300 font-semibold tracking-widest uppercase">SYSTEM / EXTENSIONS</p><h1 className="text-2xl font-semibold mt-1">Give Axiom tools.</h1><p className="text-sm text-slate-500 mt-2 mb-6">Connect the systems you want Axiom to work with. Nothing gets enabled behind your back.</p><IntegrationGuide gatewayUrl={state.settings?.gatewayUrl||''} paired={Boolean(gatewayToken)} onOpenSettings={()=>setShowSettings(true)}/><div className="rounded-2xl border border-lime-300/20 bg-lime-300/[.045] p-4 mb-4"><div className="flex gap-3 items-center"><div className="w-10 h-10 rounded-xl bg-lime-300/10 text-lime-300 grid place-items-center"><Layers3 size={20}/></div><div className="flex-1"><div className="font-medium text-sm">Extensible registry</div><div className="text-xs text-slate-500 mt-1">Async tools · JSON schema · local execution</div></div><badge className="hidden">Core</badge><span className="text-[10px] text-lime-300 border border-lime-300/20 rounded-full px-2 py-1">CORE</span></div></div>{state.tools.map(t=><div key={t.id} className="rounded-2xl border border-white/[.08] bg-white/[.025] p-4 mb-3"><div className="flex items-center gap-3"><div className="w-11 h-11 rounded-xl bg-white/[.06] grid place-items-center"><Icon name={t.icon} size={20}/></div><div className="flex-1"><div className="font-medium text-sm">{t.name}</div><div className="text-xs text-slate-500 mt-1">{t.description}</div><div className={"text-[10px] mt-1 "+(diagnostics?.services?.[t.id]?.status==="connected"?"text-lime-300":"text-amber-200")}>Provider: {diagnostics?.services?.[t.id]?.status||"not checked"}</div></div><button type="button" role="switch" aria-checked={t.enabled} aria-label={"Enable "+t.name+" integration"} onClick={()=>toggleIntegration(t.id)} className={'w-11 h-6 rounded-full p-1 transition '+(t.enabled?'bg-lime-300':'bg-slate-700')}><span className={'block w-4 h-4 rounded-full bg-white transition '+(t.enabled?'translate-x-5':'')}/></button></div>{t.enabled&&<div className="mt-4 pt-3 border-t border-white/[.07] text-xs text-lime-300 flex gap-2"><Check size={14}/> Tools registered: {listTools().filter(x=>x.name.startsWith(t.id==='github'?'github_':'supabase_')).length}. Upstream credentials verified.</div>}</div>)}<button onClick={async()=>{const snippet="import { registerTool } from './lib/toolRegistry.js';\n\nregisterTool({\n  name: 'my_custom_tool',\n  description: 'Describe what this tool does',\n  inputSchema: { type: 'object', properties: {}, additionalProperties: false }\n}, async (input) => {\n  // Implement your async capability here\n  return { ok: true };\n});";try{await navigator.clipboard.writeText(snippet);setNotice('Custom tool template copied. Add it to your app code and register it at startup.');}catch{setNotice('Clipboard unavailable. Import registerTool from ./lib/toolRegistry.js to add a custom async tool.');}}} className="w-full p-4 rounded-2xl border border-dashed border-white/15 text-sm text-slate-400 flex justify-center items-center gap-2"><Plus size={16}/> Copy custom tool template</button></section>}
   {tab==='mcp'&&<section><p className="text-xs text-lime-300 font-semibold tracking-widest uppercase">SYSTEM / NETWORK</p><h1 className="text-2xl font-semibold mt-1">External endpoints.</h1><p className="text-sm text-slate-500 mt-2 mb-6">Wire in remote tool servers. Inspect what they expose before putting them to work.</p><div className="rounded-2xl border border-white/[.08] bg-white/[.025] p-4 mb-5"><div className="flex items-center gap-2 mb-4"><Server size={18} className="text-lime-300"/><span className="font-medium text-sm">Add endpoint</span></div><label className="text-xs text-slate-500">Server name</label><input aria-label="Server name" value={serverName} onChange={e=>setServerName(e.target.value)} placeholder="My MCP server" className="w-full mt-1 mb-3 p-3 rounded-xl bg-black/30 border border-white/10 text-sm outline-none focus:border-lime-300/50"/><label className="text-xs text-slate-500">Direct endpoint URL (optional)</label><input aria-label="Endpoint URL" value={serverUrl} onChange={e=>setServerUrl(e.target.value)} placeholder="https://example.com/mcp or /sse" className="w-full mt-1 mb-3 p-3 rounded-xl bg-black/30 border border-white/10 text-sm outline-none focus:border-lime-300/50"/><label className="text-xs text-slate-500">Transport</label><select aria-label="MCP transport" value={serverTransport} onChange={e=>setServerTransport(e.target.value)} className="w-full mt-1 mb-3 p-3 rounded-xl bg-[#090d14] border border-white/10 text-sm outline-none"><option value="http">Streamable HTTP</option><option value="sse">Legacy SSE (no auth header)</option></select><label className="text-xs text-slate-500">Gateway MCP server ID (recommended)</label><input aria-label="Gateway MCP server ID" value={serverGatewayId} onChange={e=>setServerGatewayId(e.target.value)} placeholder="filesystem" className="w-full mt-1 p-3 rounded-xl bg-black/30 border border-white/10 text-sm outline-none"/><p className="text-[11px] text-slate-500 mt-2">Configure this ID and its credentials in MCP_SERVERS_JSON on the gateway.</p><button onClick={addServer} className="w-full mt-3 p-3 rounded-xl bg-lime-300 text-slate-950 text-sm font-semibold">Add server</button></div>{state.servers.length===0?<div className="text-center py-12 text-slate-500"><Globe2 size={28} className="mx-auto mb-3 opacity-50"/><p className="text-sm">No MCP servers connected yet.</p></div>:state.servers.map(s=><div key={s.id} className="rounded-2xl border border-white/[.08] bg-white/[.025] p-4 mb-3"><div className="flex items-start gap-3"><div className="w-10 h-10 rounded-xl bg-white/[.06] grid place-items-center"><Radio size={18}/></div><div className="flex-1 min-w-0"><div className="font-medium text-sm">{s.name}</div><div className="text-xs text-slate-500 truncate mt-1">{s.url}</div><div className="text-[10px] mt-2 text-slate-400">{s.transport==='sse'?'Legacy SSE':'Streamable HTTP'} · {s.status} · {s.tools.length} tools</div></div><button type="button" aria-label={"Reconnect "+s.name} title="Reconnect server" onClick={()=>discoverServer(s.id)} className="p-2 rounded-lg bg-white/[.06] text-lime-300"><RefreshCw size={15}/></button><button type="button" aria-label={"Remove "+s.name} title="Remove server" onClick={()=>{mcpAttempts.current[s.id]=(mcpAttempts.current[s.id]||0)+1;mcpCleanup.current[s.id]?.();delete mcpCleanup.current[s.id];setState(current=>({...current,servers:current.servers.filter(x=>x.id!==s.id)}));log('info','MCP server removed',s.name);}} className="p-2 text-slate-500"><Trash2 size={15}/></button></div>{s.tools.map(t=><div key={t.name} className="mt-3 p-3 rounded-xl bg-black/20"><div className="text-xs font-medium">{t.name}</div><div className="text-xs text-slate-500 mt-1">{t.description}</div><pre className="text-[10px] text-slate-600 overflow-auto mt-2">{JSON.stringify(t.inputSchema||{},null,2)}</pre></div>)}</div>)}<div className="text-[11px] text-slate-600 leading-relaxed mt-5">MCP connections depend on server CORS support. Legacy SSE cannot send custom authorization headers from the browser; use a trusted same-origin proxy for authenticated production servers.</div></section>}
   {tab==='logs'&&<section><div className="flex items-center justify-between"><div><p className="text-xs text-lime-300 font-semibold tracking-widest uppercase">SYSTEM / TRACE</p><h1 className="text-2xl font-semibold mt-1">What happened.</h1></div><button type="button" aria-label="Clear execution logs" title="Clear logs" onClick={()=>update({logs:[]})} className="p-2 rounded-xl bg-white/[.05] text-slate-400"><Trash2 size={17}/></button></div><p className="text-sm text-slate-500 mt-2 mb-6">A readable trail of model requests, tool calls, and failures.</p>{state.logs.length===0?<div className="text-center py-16 text-slate-500"><Terminal size={28} className="mx-auto mb-3 opacity-50"/><p className="text-sm">No execution events yet.</p></div>:<div className="space-y-2">{state.logs.map(l=><div key={l.id} className="rounded-xl border border-white/[.07] bg-white/[.025] overflow-hidden"><button onClick={()=>setExpanded(s=>({...s,[l.id]:!s[l.id]}))} className="w-full p-3 flex items-center gap-3 text-left"><span className={'w-2 h-2 rounded-full '+(l.kind==='success'?'bg-lime-400':l.kind==='error'?'bg-red-400':l.kind==='request'?'bg-sky-400':'bg-slate-500')}/><span className="text-xs flex-1 font-medium">{l.title}</span><span className="text-[10px] text-slate-600">{l.time}</span>{expanded[l.id]?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button>{expanded[l.id]&&<pre className="p-3 pt-0 text-[11px] text-slate-400 whitespace-pre-wrap break-words">{l.detail||'No additional details.'}</pre>}</div>)}</div>}</section>}
  </main>
  <div className="fixed bottom-0 left-0 right-0 z-40 max-w-3xl mx-auto">
   {tab==='chat'&&<div className="px-3 pb-2"><div className="glass border border-white/[.12] rounded-2xl p-2 shadow-2xl"><textarea aria-label="Message your local model" enterKeyHint="send" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();sendMessage();}}} rows={2} placeholder="Give the system a job…" className="w-full min-h-[44px] max-h-32 overflow-y-auto resize-none bg-transparent px-2 py-2 text-sm leading-5 outline-none placeholder:text-slate-600"/>{offlineQueuedCount>0&&<div className="px-2 pb-2 text-[10px] text-amber-300" role="status">{offlineQueuedCount} offline draft(s) queued. Reconnected drafts are restored here for review.</div>}{draftAttachments.length>0&&<div className="flex flex-wrap gap-1.5 px-1 pb-2">{draftAttachments.map(item=><span key={item.id} className="inline-flex items-center gap-1.5 max-w-full border border-white/15 bg-white/[.05] px-2 py-1 text-[10px] text-slate-300"><Paperclip size={11}/><span className="truncate max-w-36">{item.name}</span><button type="button" aria-label={"Remove "+item.name} onClick={()=>removePromptAttachment(item.id)} className="text-slate-500"><X size={12}/></button></span>)}</div>}<input ref={attachmentInputRef} type="file" multiple hidden accept="image/*,.txt,.md,.markdown,.json,.js,.jsx,.ts,.tsx,.css,.html,.xml,.yaml,.yml,.toml,.log,.csv,.sql,.py,.sh,.kt,.java,.c,.cpp,.h,.hpp,.rs,.go" onChange={event=>addPromptAttachments(event.target.files)}/><div className="flex items-center justify-between px-1"><div className="flex items-center gap-1"><button type="button" aria-label="Attach files" title="Attach files (1 MiB each)" onClick={()=>attachmentInputRef.current?.click()} disabled={busy} className="w-11 h-11 grid place-items-center border border-white/10 bg-white/[.04] text-slate-300 disabled:opacity-40"><Paperclip size={17}/></button><VoiceCapture disabled={busy} onTranscript={value=>setDraft(current=>current?current.trimEnd()+' '+value:value)} onError={setNotice}/><span className="text-[10px] text-slate-600 hidden sm:inline">Enter to send · Shift + Enter for newline</span></div>{busy?<button onClick={stopGeneration} aria-label="Stop generation" title="Stop generation" className="w-11 h-11 rounded-xl bg-red-400 text-slate-950 grid place-items-center active:scale-95"><Square size={16} fill="currentColor"/></button>:<button onClick={sendMessage} disabled={(!draft.trim()&&!draftAttachments.length)||(!activeModel&&navigator.onLine)} aria-label="Send message" className="w-11 h-11 rounded-xl bg-lime-300 text-slate-950 grid place-items-center disabled:opacity-30 active:scale-95"><ArrowUp size={19}/></button>}</div></div></div>}
   <nav className="glass border-t border-white/[.09] safe-bottom grid grid-cols-8 px-1 pt-2">{nav.map(n=>{const I=n.icon;return <button key={n.id} onClick={()=>setTab(n.id)} className={'min-h-11 flex flex-col items-center justify-center gap-1 py-2 rounded-xl transition '+(tab===n.id?'text-lime-300':'text-slate-500')}><I size={19} strokeWidth={tab===n.id?2.4:1.8}/><span className="text-[10px] font-medium">{n.label}</span>{tab===n.id&&<span className="w-1 h-1 rounded-full bg-lime-300"/>}</button>})}</nav>
  </div>
  {bootStatus==='initializing'||bootStatus==='checking'?<div className="fixed inset-0 z-[80] bg-[#10110e] flex items-center justify-center p-6"><section className="w-full max-w-sm border border-white/15 p-5" role="status" aria-live="polite"><div className="text-xs tracking-[.2em] text-lime-300 font-semibold">AXIOM / STARTUP</div><h2 className="text-2xl font-bold tracking-tight mt-3">Preparing workspace.</h2><div className="mt-5 space-y-3 text-xs text-slate-300"><div className="flex items-center gap-2"><LoaderCircle size={14} className="animate-spin text-lime-300"/> Initializing runtime</div><div className="flex items-center gap-2"><Check size={14} className="text-lime-300"/> Checking local storage</div><div className="flex items-center gap-2"><span className="w-3.5 h-3.5 border border-lime-300/40 rounded-full"/> Checking model runtime</div></div></section></div>:bootStatus==='offline'?<div className="fixed z-[75] top-20 left-3 right-3 max-w-xl mx-auto border border-amber-300/30 bg-[#191a16] p-3 flex items-center justify-between gap-3"><div className="min-w-0"><div className="text-xs font-semibold text-amber-200">Runtime is taking longer than expected</div><p className="text-[10px] text-slate-400 mt-1">Your workspace is available. Continue offline or retry the connection.</p></div><button type="button" onClick={()=>{setBootStatus('checking');checkOllama({silent:true}).then(()=>setBootStatus('ready'));setTimeout(()=>setBootStatus(current=>current==='checking'?'offline':current),8000);}} className="shrink-0 min-h-10 px-3 border border-amber-200/30 text-amber-100 text-xs">Retry</button><button type="button" aria-label="Dismiss runtime warning" onClick={()=>setBootStatus('ready')} className="p-2 text-slate-400"><X size={15}/></button></div>:null}
  {showOnboarding&&<div className="fixed inset-0 z-[55] bg-black/80 backdrop-blur-sm p-4 flex items-end sm:items-center justify-center"><section role="dialog" aria-modal="true" aria-labelledby="onboarding-title" className="w-full max-w-lg rounded-t-3xl sm:rounded-3xl border border-lime-300/25 bg-[#11151d] p-5 pb-7 max-h-[88vh] overflow-auto shadow-2xl"><div className="flex items-center gap-3 mb-4"><div className="w-11 h-11 rounded-xl bg-lime-300 text-slate-950 grid place-items-center"><Zap size={21}/></div><div><p className="text-[10px] tracking-[.18em] uppercase text-lime-300">First launch / Axiom</p><h2 id="onboarding-title" className="text-xl font-semibold">Your workspace is ready.</h2></div></div><p className="text-sm text-slate-300 leading-relaxed">Start with a local model. Pair the gateway only when you need remote integrations such as GitHub, Supabase or MCP.</p><div className="mt-4 rounded-xl border border-white/10 bg-black/25 p-3"><div className="text-sm font-semibold">Connect the local gateway automatically</div><p className="text-xs text-slate-300 mt-2">Install and open Termux, then run this once inside Termux:</p><pre className="mt-2 rounded-lg bg-black/50 border border-white/10 p-3 text-[11px] text-lime-200 overflow-x-auto whitespace-pre-wrap break-all">pkg install -y curl && curl -fsSL https://raw.githubusercontent.com/michaelkage/Axiom/main/pwa/scripts/setup-termux-ollama.sh -o axiom-termux-setup.sh && bash axiom-termux-setup.sh</pre><p className="text-xs text-slate-400 mt-2">The setup starts Ollama and Axiom's gateway, then securely hands the one-time pairing credential directly to this Android app. Axiom stores it in Android Keystore and registers sessions automatically. No copying, pasting, or token screen.</p><p className="text-[11px] text-amber-200/80 mt-2">This is only needed for the Termux gateway bridge. Axiom's built-in native model engine works without Termux or a gateway.</p></div><div className="mt-4 rounded-xl border border-white/10 bg-black/25 p-3"><div className="text-sm font-semibold">Important Android network detail</div><p className="text-xs text-slate-300 mt-2">On Android, 127.0.0.1 means the phone itself. If the gateway runs on your computer, configure its reachable HTTPS address in Settings.</p></div><div className="grid grid-cols-2 gap-2 mt-5"><button type="button" onClick={()=>{dismissOnboarding();setShowSettings(true);}} className="min-h-11 rounded-lg bg-lime-300 text-slate-950 font-semibold text-xs">Open setup</button><button type="button" onClick={dismissOnboarding} className="min-h-11 rounded-lg border border-white/15 bg-white/[.04] text-slate-100 text-xs">Start using Axiom</button></div></section></div>}
  {showSettings&&<div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center" onClick={()=>setShowSettings(false)}><div ref={settingsDialogRef} role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title" onClick={e=>e.stopPropagation()} className="w-full max-w-lg rounded-t-3xl sm:rounded-3xl border border-white/10 bg-[#11151d] p-5 pb-9 max-h-[88vh] overflow-auto"><div className="flex items-center justify-between mb-5"><div><div className="text-xs text-lime-300 tracking-widest uppercase">Configuration</div><h2 id="settings-dialog-title" className="text-xl font-semibold mt-1">Settings</h2></div><button aria-label="Close settings" onClick={()=>setShowSettings(false)} className="p-2 rounded-xl bg-white/[.06]"><X size={18}/></button></div><div className="rounded-2xl border border-lime-300/15 bg-lime-300/[.04] p-3 mb-4"><div className="flex items-center justify-between gap-2"><div className="text-sm font-semibold mb-2">Authenticated local gateway</div><button type="button" onClick={()=>setShowOnboarding(true)} className="text-[11px] underline underline-offset-4 text-lime-200">Open setup guide</button></div><label className="text-xs text-slate-400">Gateway URL</label><input aria-label="Gateway URL" value={state.settings?.gatewayUrl||""} onChange={e=>update({settings:{...state.settings,gatewayUrl:e.target.value}})} placeholder="http://127.0.0.1:8787" className="w-full mt-1 mb-3 p-3 rounded-xl bg-black/30 border border-white/10 text-sm outline-none"/>{isNativeAndroidPlatform?<div className="rounded-xl bg-black/25 p-3"><div className="text-xs text-slate-400">Gateway authentication</div><div className="text-sm font-semibold mt-1">{gatewayToken ? 'Session registered automatically' : 'Waiting for secure pairing'}</div><p className="text-[11px] text-slate-500 mt-1">On Android, the Termux bootstrap hands the pairing credential directly to Axiom. The app stores it in Android Keystore and manages short-lived sessions. Remote gateways can be paired in the advanced section below.</p></div>:<div className="rounded-xl bg-black/25 p-3"><label className="text-xs text-slate-400" htmlFor="browser-gateway-token">Gateway bearer token · browser only</label><input id="browser-gateway-token" aria-label="Gateway bearer token" type="password" autoComplete="off" value={gatewayToken} onChange={e=>setGatewayToken(e.target.value)} placeholder="AXIOM_GATEWAY_TOKEN" className="w-full mt-2 p-3 rounded-xl bg-black/30 border border-white/10 text-sm outline-none"/><p className="text-[11px] text-slate-500 mt-2">Browser mode cannot receive Android's secure app handoff. This token stays in memory and is cleared when the page reloads. The installed Android app pairs automatically through Termux.</p></div>}</div><div className="border-t border-white/[.08] my-5 pt-5"><div className="text-sm font-semibold mb-3">Appearance & interaction</div><label className="block text-xs text-slate-400 mb-1" htmlFor="axiom-theme">Theme</label><select id="axiom-theme" aria-label="Theme" value={theme} onChange={event=>update({settings:{...state.settings,theme:event.target.value}})} className="w-full p-3 mb-3 bg-black/30 border border-white/10 text-sm"><option value="dark">Dark</option><option value="light">Light</option><option value="high-contrast">High contrast</option></select><label className="block text-xs text-slate-400 mb-1" htmlFor="axiom-accent">Custom accent</label><input id="axiom-accent" type="color" value={accentColor} onChange={event=>update({settings:{...state.settings,accentColor:event.target.value}})} className="w-full h-11 p-1 mb-3"/><label className="block text-xs text-slate-400 mb-1" htmlFor="axiom-retries">Automatic retries · transient errors</label><select id="axiom-retries" value={state.settings?.retryAttempts??2} onChange={event=>update({settings:{...state.settings,retryAttempts:Number(event.target.value)}})} className="w-full p-3 bg-black/30 border border-white/10 text-sm"><option value="0">Off</option><option value="1">1 retry</option><option value="2">2 retries</option><option value="3">3 retries</option><option value="5">5 retries</option></select><p className="text-[10px] text-slate-500 mt-2">Retry delays increase automatically. Stop cancels the active request and any pending wait.</p></div><label className="text-xs text-slate-400">Direct Ollama API base URL (gateway disabled)</label><input aria-label="Ollama API base URL" value={state.baseUrl} onChange={e=>update({baseUrl:e.target.value})} className="w-full mt-2 mb-4 p-3 rounded-xl bg-black/30 border border-white/10 text-sm outline-none focus:border-lime-300/50"/>
<div className="border-t border-white/[.08] my-5 pt-5"><div className="flex items-center justify-between gap-3"><div><div className="text-sm font-semibold">Integration health</div><p className="text-[11px] text-slate-500 mt-1">Live, read-only checks from the gateway host. Credentials never leave the gateway.</p></div><button type="button" onClick={()=>checkGatewayDiagnostics()} disabled={diagnosticsBusy||!gatewayToken} className="shrink-0 min-h-10 px-3 rounded-xl border border-lime-300/20 bg-lime-300/10 text-lime-200 text-xs font-semibold disabled:opacity-40">{diagnosticsBusy?'Checking…':'Run checks'}</button></div>{!gatewayToken?<p className="text-xs text-amber-200/80 mt-3">Pair the gateway to check GitHub and Supabase credentials.</p>:<div className="grid gap-2 mt-3">{['ollama','github','supabase'].map(id=>{const item=diagnostics?.services?.[id];const title=id==='ollama'?'Ollama':id==='github'?'GitHub':'Supabase';const status=item?.status||'not-tested';const tone=status==='connected'?'text-lime-300':status==='missing'||status==='error'||status==='offline'?'text-amber-200':'text-slate-400';return <div key={id} className="rounded-xl bg-black/25 border border-white/[.06] p-3"><div className="flex items-center justify-between gap-2"><span className="text-xs font-medium">{title}</span><span className={'text-[10px] uppercase tracking-wide '+tone}>{status.replace('-',' ')}</span></div><p className="text-[11px] text-slate-500 mt-1">{item?.message||'Not checked yet.'}</p></div>;})}{diagnostics?.checkedAt&&<p className="text-[10px] text-slate-600">Last checked {new Date(diagnostics.checkedAt).toLocaleTimeString()}</p>}</div>}</div>
<div className="border-t border-white/[.08] my-5 pt-5">
 <div className="flex items-center justify-between gap-3"><div><div className="text-sm font-semibold">Provider credentials</div><p className="text-[11px] text-slate-500 mt-1">Enter credentials here. The gateway stores them in a private file on the Termux host. Secrets are never sent back to the app or saved in browser storage.</p></div><span className="text-[10px] text-lime-300">{gatewayToken?'GATEWAY LINKED':'GATEWAY OFFLINE'}</span></div>
 <div className="mt-4 rounded-xl border border-white/[.08] bg-black/25 p-3">
  <div className="flex items-center justify-between gap-2"><div className="text-sm font-semibold flex items-center gap-2"><Github size={15}/> GitHub</div><span className={'text-[10px] '+(providerConfig?.github?.configured?'text-lime-300':'text-amber-200')}>{providerConfig?.github?.configured?'TOKEN SAVED':'NOT CONFIGURED'}</span></div>
  <p className="text-[11px] text-slate-400 mt-2">Create a fine-grained PAT with access to the repository below. Contents read/write is needed for file edits; Metadata read is required.</p>
  <label className="block text-xs text-slate-400 mt-3" htmlFor="github-pat">GitHub Personal Access Token</label>
  <input id="github-pat" type="password" autoComplete="new-password" value={githubTokenInput} onChange={e=>setGithubTokenInput(e.target.value)} placeholder={providerConfig?.github?.configured?'Saved securely · enter a new token to replace':'github_pat_…'} className="w-full mt-1 p-3 rounded-xl bg-black/30 border border-white/10 text-sm outline-none"/>
  <label className="block text-xs text-slate-400 mt-3" htmlFor="github-repository">Repository (owner/repo)</label>
  <input id="github-repository" value={state.settings?.githubRepo||providerConfig?.github?.repository||'michaelkage/Axiom'} onChange={e=>update({settings:{...state.settings,githubRepo:e.target.value}})} placeholder="owner/repository" className="w-full mt-1 p-3 rounded-xl bg-black/30 border border-white/10 text-sm outline-none"/>
  <div className="grid grid-cols-2 gap-2 mt-3"><button type="button" onClick={()=>saveProviderCredentials('github')} disabled={!gatewayToken} className="min-h-11 rounded-lg bg-lime-300 text-slate-950 text-xs font-semibold disabled:opacity-40">Save GitHub</button><button type="button" onClick={()=>clearProviderCredentials('github')} disabled={!gatewayToken||!providerConfig?.github?.configured} className="min-h-11 rounded-lg border border-red-300/20 text-red-200 text-xs disabled:opacity-40">Remove token</button></div>
  <a className="inline-block mt-2 text-[11px] text-sky-200 underline" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Create a fine-grained token</a>
 </div>
 <div className="mt-3 rounded-xl border border-white/[.08] bg-black/25 p-3">
  <div className="flex items-center justify-between gap-2"><div className="text-sm font-semibold flex items-center gap-2"><Database size={15}/> Supabase</div><span className={'text-[10px] '+(providerConfig?.supabase?.configured?'text-lime-300':'text-amber-200')}>{providerConfig?.supabase?.configured?'KEY SAVED':'NOT CONFIGURED'}</span></div>
  <p className="text-[11px] text-slate-400 mt-2">Supabase uses your project URL and publishable key (or legacy anon key), not a personal access token. Never use a service-role or sb_secret key.</p>
  <label className="block text-xs text-slate-400 mt-3" htmlFor="supabase-project-url">Project URL</label>
  <input id="supabase-project-url" inputMode="url" autoCapitalize="none" value={supabaseUrlInput||providerConfig?.supabase?.url||''} onChange={e=>setSupabaseUrlInput(e.target.value)} placeholder="https://your-project.supabase.co" className="w-full mt-1 p-3 rounded-xl bg-black/30 border border-white/10 text-sm outline-none"/>
  <label className="block text-xs text-slate-400 mt-3" htmlFor="supabase-publishable-key">Publishable key / anon key</label>
  <input id="supabase-publishable-key" type="password" autoComplete="new-password" autoCapitalize="none" value={supabaseKeyInput} onChange={e=>setSupabaseKeyInput(e.target.value)} placeholder={providerConfig?.supabase?.configured?'Saved securely · enter a new key to replace':'sb_publishable_…'} className="w-full mt-1 p-3 rounded-xl bg-black/30 border border-white/10 text-sm outline-none"/>
  <div className="grid grid-cols-2 gap-2 mt-3"><button type="button" onClick={()=>saveProviderCredentials('supabase')} disabled={!gatewayToken} className="min-h-11 rounded-lg bg-lime-300 text-slate-950 text-xs font-semibold disabled:opacity-40">Save Supabase</button><button type="button" onClick={()=>clearProviderCredentials('supabase')} disabled={!gatewayToken||!providerConfig?.supabase?.configured} className="min-h-11 rounded-lg border border-red-300/20 text-red-200 text-xs disabled:opacity-40">Remove key</button></div>
  <a className="inline-block mt-2 text-[11px] text-sky-200 underline" href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">Open Supabase dashboard</a>
 </div>
</div><RuntimeControls gatewayUrl={state.settings?.gatewayUrl||""} onSessionToken={setGatewayToken} onNotice={setNotice} terminalRows={state.settings?.terminalRows||24} terminalCols={state.settings?.terminalCols||80} onTerminalConfigChange={patch=>update({settings:{...state.settings,...patch}})} gatewaySessionActive={Boolean(gatewayToken)} gatewaySessionToken={gatewayToken}/><button onClick={()=>{checkOllama();}} className="w-full p-3 rounded-xl bg-lime-300 text-slate-950 text-sm font-semibold">Test Ollama connection</button><div className="mt-5 p-3 rounded-xl bg-amber-300/[.06] border border-amber-300/10 text-xs text-amber-200/80 leading-relaxed"><Shield size={14} className="inline mr-2"/>LocalStorage persists your configuration and conversations on this device. It is not encrypted. Avoid storing production secrets or high-privilege tokens here. Browser access to localhost also requires Ollama CORS configuration; HTTPS pages may be blocked from calling an HTTP localhost endpoint by browser security rules.</div><div className="mt-5 text-xs text-slate-600">Axiom PWA · 1.2.0 · Mobile workspace</div></div></div>}
  {pendingApproval&&<div className="fixed inset-0 z-[70] bg-black/80 p-4 flex items-end sm:items-center justify-center"><section ref={approvalDialogRef} role="alertdialog" aria-modal="true" aria-labelledby="tool-approval-title" className="w-full max-w-lg rounded-3xl border border-amber-300/20 bg-[#11151d] p-5 shadow-2xl"><div className="flex items-center gap-3 mb-3"><div className="w-10 h-10 rounded-xl bg-amber-300/10 text-amber-300 grid place-items-center"><Shield size={20}/></div><div><p className="text-xs uppercase tracking-widest text-amber-300">Permission required</p><h2 id="tool-approval-title" className="font-semibold">Approve tool execution?</h2></div></div><p className="text-sm text-slate-300">Axiom is requesting permission to run <strong>{pendingApproval.name}</strong>.</p><pre className="mt-3 max-h-48 overflow-auto rounded-xl bg-black/40 border border-white/10 p-3 text-xs text-slate-300 whitespace-pre-wrap break-words">{JSON.stringify(pendingApproval.args,null,2)}</pre><p className="text-xs text-slate-500 mt-3">Review the arguments before allowing this action. Remote tool descriptions are not trusted instructions.</p><div className="grid grid-cols-2 gap-3 mt-5"><button type="button" onClick={()=>approvalResolver.current?.(false)} className="min-h-12 rounded-xl border border-white/10 bg-white/[.04] text-slate-200">Decline</button><button type="button" onClick={()=>approvalResolver.current?.(true)} className="min-h-12 rounded-xl bg-lime-300 text-slate-950 font-semibold">Allow once</button></div></section></div>}{notice&&<div className="fixed z-[60] bottom-28 left-4 right-4 max-w-xl mx-auto p-3 rounded-xl bg-slate-800 border border-white/10 text-sm flex items-center justify-between shadow-xl"><span>{notice}</span><button type="button" aria-label="Dismiss notification" onClick={()=>setNotice('')}><X size={16}/></button></div>}
 </div>;
}
function NetworkIcon(props){return <Globe2 {...props}/>;}
