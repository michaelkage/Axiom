import React, { useEffect, useMemo, useRef, useState } from 'react';
import { connectMcpHttp, connectMcpSse } from './lib/mcpClient.js';
import { runOllamaToolChat } from './lib/ollamaChat.js';
import MarkdownMessage from './components/MarkdownMessage.jsx';
import { executeTool, listTools, registerTool, serializeToolResult, toOllamaTools } from './lib/toolRegistry.js';
import { registerGitHubTools } from './lib/githubTools.js';
import { registerSupabaseTools } from './lib/supabaseTools.js';
import { Activity, ArrowDown, ArrowUp, Bot, Check, ChevronDown, ChevronRight, CircleHelp, Code2, Copy, Cpu, Database, ExternalLink, FileCode2, Github, Globe2, HardDrive, KeyRound, Layers3, LoaderCircle, Menu, MessageSquare, MoreHorizontal, Plus, Radio, RefreshCw, Send, Server, Settings2, Shield, Smartphone, Sparkles, Square, Terminal, Trash2, Wrench, X, Zap } from 'lucide-react';

const STORE = 'axiom.mobile.v1';
const defaults = { baseUrl:'http://localhost:11434', model:'qwen2.5:1.5b', activeTab:'chat', chats:[], tools:[{id:'github',name:'GitHub',description:'Read files, inspect repositories and publish commits.',enabled:false,icon:'github'},{id:'supabase',name:'Supabase',description:'Inspect schemas and run SQL against your project.',enabled:false,icon:'database'}], servers:[], logs:[], settings:{temperature:0.7,stream:true,gatewayUrl:'http://127.0.0.1:8787',githubToken:'',githubRepo:'michaelkage/Axiom',supabaseUrl:'',supabaseKey:''} };
const uid = () => Math.random().toString(36).slice(2,10);
const stamp = () => new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
function loadState(){ try { const saved=JSON.parse(localStorage.getItem(STORE)||'{}'); const settings={...defaults.settings,...(saved.settings||{}),githubToken:'',supabaseKey:''}; const servers=(saved.servers||[]).map(({authToken,...server})=>({...server,authToken:''})); return {...defaults,...saved,servers,settings}; } catch { return defaults; } }
function Icon({name,...props}) { const map={github:Github,database:Database}; const C=map[name]||Wrench; return <C {...props}/>; }

export default function App(){
 const [state,setState]=useState(loadState);
 const [tab,setTab]=useState(state.activeTab||'chat');
 const [draft,setDraft]=useState('');
 const [busy,setBusy]=useState(false);
 const [models,setModels]=useState([]);
 const [connection,setConnection]=useState('unknown');
 const [showSettings,setShowSettings]=useState(false);
 const [showHistory,setShowHistory]=useState(false);
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
 const approvalDialogRef=useRef(null);
 const bottomRef=useRef(null);
 const settingsDialogRef=useRef(null);
 const settingsTriggerRef=useRef(null);
 const activeRunRef=useRef(null);
 const integrationCleanup=useRef({});
 const mcpCleanup=useRef({});
 const mcpAttempts=useRef({});
 const mcpRestoreStarted=useRef(false);
 const currentChat=state.chats[0]||null;
 const registeredTools=listTools();
 const messages=currentChat?.messages||[];
 const update=(patch)=>setState(s=>({...s,...patch}));
 useEffect(()=>{const settings={...state.settings,githubToken:'',supabaseKey:''};const servers=(state.servers||[]).map(({authToken,...server})=>({...server,authToken:''}));const chats=(state.chats||[]).slice(0,40).map(chat=>({...chat,messages:(chat.messages||[]).slice(-300)}));const persisted={...state,chats,logs:(state.logs||[]).slice(0,100),settings,servers,activeTab:tab};try{localStorage.setItem(STORE,JSON.stringify(persisted));}catch(error){setNotice('Local storage is full. Export or remove older conversations to keep saving new messages.');}},[state,tab]);
 useEffect(()=>{bottomRef.current?.scrollIntoView({behavior:'smooth'});},[messages,busy]);
 useEffect(()=>()=>{activeRunRef.current?.abort(new DOMException('Axiom view closed','AbortError'));},[]);
 const log=(kind,title,detail='')=>setState(s=>({...s,logs:[{id:uid(),kind,title,detail,time:stamp()},...s.logs].slice(0,100)}));
 const patchChat=(fn,chatId)=>setState(s=>{const chats=[...s.chats];let index=chatId?chats.findIndex(chat=>chat.id===chatId):0;if(index<0&&chatId){chats.unshift({id:chatId,title:'New conversation',messages:[]});index=0;}else if(index<0){chats.unshift({id:uid(),title:'New conversation',messages:[]});index=0;}chats[index]={...chats[index],messages:fn(chats[index].messages||[])};return {...s,chats};});
 const gatewayBase=()=>String(state.settings?.gatewayUrl||'').replace(/\/$/,'');
 const gatewayFetch=(input,init={})=>{const headers=new Headers(init.headers||{});if(gatewayToken)headers.set('Authorization','Bearer '+gatewayToken);return fetch(input,{...init,headers});};
 async function checkOllama({silent=false}={}){
  const base=gatewayToken?gatewayBase()+'/api/ollama':state.baseUrl.replace(/\/$/,'');
  const previous=connection;
  try { const r=await gatewayFetch(base+'/api/tags'); if(!r.ok) throw new Error('HTTP '+r.status); const data=await r.json(); setModels((data.models||[]).map(m=>m.name)); setConnection('online'); if(previous!=='online')log('success','Ollama connected',base); }
  catch(e){setConnection('offline');if(previous!=='offline')log('error','Ollama connection failed',e.message);if(!silent)setNotice('Could not reach Ollama. Check the gateway, URL, and network access.');}
 }
 useEffect(()=>{checkOllama({silent:true});},[]);
 useEffect(()=>{
  let timer;
  const retry=()=>{if(document.visibilityState==='visible')checkOllama({silent:true});};
  const interval=setInterval(()=>{if(connection!=='online'&&document.visibilityState==='visible')retry();},10000);
  window.addEventListener('online',retry);
  document.addEventListener('visibilitychange',retry);
  return()=>{clearInterval(interval);clearTimeout(timer);window.removeEventListener('online',retry);document.removeEventListener('visibilitychange',retry);};
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
  for(const item of state.tools.filter(t=>t.enabled)){
   if(integrationCleanup.current[item.id])continue;
   try{const settings=state.settings||{};integrationCleanup.current[item.id]=item.id==='github'?registerGitHubTools({token:settings.githubToken,repository:settings.githubRepo}):registerSupabaseTools({url:settings.supabaseUrl,key:settings.supabaseKey});}
   catch(error){log('error',item.id+' integration restore failed',error.message);setState(current=>({...current,tools:current.tools.map(tool=>tool.id===item.id?{...tool,enabled:false}:tool)}));}
  }
 },[]);

 function stopGeneration(){
  const controller=activeRunRef.current;
  if(!controller||controller.signal.aborted)return;
  controller.abort(new DOMException('Stopped by user','AbortError'));
 }
 async function sendMessage(){
  const prompt=draft.trim(); if(!prompt||busy)return;
  const controller=new AbortController();
  activeRunRef.current=controller;
  const signal=controller.signal;
  const chatId=currentChat?.id||uid();
  if(!currentChat)setState(s=>({...s,chats:[{id:chatId,title:'New conversation',messages:[]},...s.chats]}));
  setDraft(''); setBusy(true);
  const userMsg={id:uid(),role:'user',content:prompt,time:stamp()};
  const priorMessages=currentChat?.messages||[];
  patchChat(old=>[...old,userMsg],chatId);
  setState(s=>({...s,chats:s.chats.map(chat=>chat.id===chatId?{...chat,title:chat.title==='New conversation'?prompt.slice(0,36):chat.title}:chat)}));
  const base=gatewayToken?gatewayBase()+'/api/ollama':state.baseUrl.replace(/\/$/,'');
  const assistantId=uid();
  patchChat(old=>[...old,{id:assistantId,role:'assistant',content:'',time:stamp()}],chatId);
  let answer='';
  try{
   const availableTools=toOllamaTools();
   answer=(await runOllamaToolChat({
    baseUrl:base,
    fetchImpl:gatewayFetch,
    model:state.model,
    messages:[...priorMessages,userMsg],
    tools:availableTools,
    signal,
    executeTool,
    serializeToolResult,
    getToolMeta:name=>listTools().find(tool=>tool.name===name),
    confirmTool:(name,args,{signal}={})=>new Promise(resolve=>{const finish=allowed=>{signal?.removeEventListener('abort',onAbort);approvalResolver.current=null;setPendingApproval(null);resolve(allowed);};const onAbort=()=>finish(false);approvalResolver.current=finish;setPendingApproval({name,args});if(signal?.aborted)onAbort();else signal?.addEventListener('abort',onAbort,{once:true});}),
    onText:value=>{answer=value;patchChat(old=>old.map(m=>m.id===assistantId?{...m,content:answer}:m),chatId);},
    onEvent:event=>{
     if(event.type==='request')log('request','Ollama /api/chat',JSON.stringify({model:event.model,toolCount:event.toolCount,turn:event.turn,stream:true},null,2));
     else if(event.type==='tool.request')log('request','Tool: '+event.name,JSON.stringify(event.args,null,2));
     else if(event.type==='tool.completed')log('success','Tool completed: '+event.name,event.result);
     else if(event.type==='tool.failed')log('error','Tool failed: '+event.name,event.error);
     else if(event.type==='tool.declined')log('info','Tool action declined: '+event.name);
    }
   })).answer;
   log('success','Generation complete',state.model);
  }catch(e){if(signal.aborted){if(!answer)patchChat(old=>old.map(m=>m.id===assistantId?{...m,content:'Generation stopped.'}:m),chatId);log('info','Generation cancelled','Partial assistant output was preserved.');}else{patchChat(old=>old.map(m=>m.id===assistantId?{...m,content:(answer?answer+'\n\n':'')+'**Generation error**\n\n'+e.message}:m),chatId);log('error','Generation failed',e.message);}}
  finally{if(activeRunRef.current===controller)activeRunRef.current=null;setBusy(false);}
 }
 function toggleIntegration(id){
  if(integrationCleanup.current[id]){integrationCleanup.current[id]();delete integrationCleanup.current[id];update({tools:state.tools.map(t=>t.id===id?{...t,enabled:false}:t)});log('info',id+' tools disabled');return;}
  try{
   const settings=state.settings||{};
   if(!gatewayToken)throw new Error('Configure the authenticated gateway token in Settings before enabling integrations.');
   integrationCleanup.current[id]=id==='github'
    ?registerGitHubTools({token:gatewayToken,repository:settings.githubRepo,baseUrl:gatewayBase()+'/api/github'})
    :registerSupabaseTools({url:gatewayBase()+'/api/supabase',key:gatewayToken});
   update({tools:state.tools.map(t=>t.id===id?{...t,enabled:true}:t)});
   log('success',id+' tools registered',listTools().map(t=>t.name).join(', '));
  }catch(error){setNotice(error.message);log('error',id+' registration failed',error.message);}
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
 const nav=[{id:'chat',label:'Chat',icon:MessageSquare},{id:'tools',label:'Tools',icon:Wrench},{id:'mcp',label:'MCP',icon:NetworkIcon},{id:'logs',label:'Logs',icon:Activity}];
 return <div className="min-h-[100dvh] text-slate-100 flex flex-col max-w-3xl mx-auto relative">
  <header className="safe-top sticky top-0 z-30 glass border-b border-white/[.07]">
   <div className="h-[66px] px-4 flex items-center justify-between">
    <button onClick={()=>setTab('chat')} className="flex items-center gap-3 text-left"><div className="w-9 h-9 rounded-xl bg-lime-300 text-slate-950 grid place-items-center shadow-[0_0_28px_rgba(163,230,53,.2)]"><Zap size={21} fill="currentColor"/></div><div><div className="font-bold tracking-[.18em] text-[15px]">AXIOM</div><div className="text-[10px] tracking-[.16em] text-slate-500 uppercase">Local intelligence</div></div></button>
    <div className="flex items-center gap-2"><span className={'w-2 h-2 rounded-full '+(connection==='online'?'bg-lime-400 shadow-[0_0_10px_#a3e635]':'bg-slate-600')}/><span className="text-xs text-slate-400 hidden sm:block">{connection==='online'?'Ollama online':connection==='offline'?'Offline':'Connecting'}</span>{busy&&<button onClick={stopGeneration} aria-label="Stop generation" title="Stop generation" className="w-11 h-11 grid place-items-center rounded-xl border border-red-400/30 bg-red-400/10 text-red-300 active:scale-95"><Square size={16} fill="currentColor"/></button>}<button ref={settingsTriggerRef} onClick={()=>setShowSettings(true)} aria-label="Open settings" className="w-11 h-11 grid place-items-center rounded-xl border border-white/10 bg-white/[.04] active:scale-95"><Settings2 size={18}/></button></div>
   </div>
  </header>
  <main className="flex-1 px-4 pt-5 pb-[calc(11rem+env(safe-area-inset-bottom))]">
   {tab==='chat'&&<section className="flex flex-col min-h-[65vh]">
    <div className="flex items-center justify-between mb-5"><div><p className="text-xs text-lime-300 font-semibold tracking-widest uppercase">Workspace / Chat</p><h1 className="text-2xl font-semibold mt-1 tracking-tight">Your local copilot.</h1></div><div className="flex gap-2"><button onClick={()=>setShowHistory(v=>!v)} className="min-h-11 flex items-center gap-1.5 text-sm rounded-xl px-3 py-2 border border-white/10 bg-white/[.04] text-slate-300"><MessageSquare size={15}/> History</button>{currentChat&&<button onClick={deleteCurrentChat} aria-label="Delete current conversation" title="Delete conversation" className="min-h-11 w-11 grid place-items-center rounded-xl border border-red-400/20 bg-red-400/[.06] text-red-300"><Trash2 size={15}/></button>}<button onClick={newChat} className="min-h-11 flex items-center gap-1.5 text-sm rounded-xl px-3 py-2 bg-lime-300 text-slate-950 font-semibold"><Plus size={16}/> New</button></div></div>{showHistory&&<div className="rounded-2xl border border-white/[.08] bg-[#11151d] p-2 mb-4 space-y-1">{state.chats.length===0?<p className="text-xs text-slate-500 p-3">No saved conversations yet.</p>:state.chats.map(chat=><button key={chat.id} onClick={()=>{setState(current=>{const selected=current.chats.find(item=>item.id===chat.id);return selected?{...current,chats:[selected,...current.chats.filter(item=>item.id!==chat.id)]}:current;});setShowHistory(false);}} className={'w-full text-left p-3 rounded-xl '+(currentChat?.id===chat.id?'bg-lime-300/10 text-lime-200':'hover:bg-white/[.04] text-slate-300')}><div className="text-sm truncate">{chat.title||'New conversation'}</div><div className="text-[10px] text-slate-500 mt-1">{chat.messages?.length||0} messages</div></button>)}</div>}
    <div className="rounded-2xl border border-white/[.08] bg-white/[.025] p-3 flex items-center gap-3 mb-5"><div className="w-11 h-11 rounded-xl bg-lime-300/10 text-lime-300 grid place-items-center"><Cpu size={20}/></div><div className="flex-1 min-w-0"><div className="text-xs text-slate-500">ACTIVE MODEL</div><select aria-label="Active model" value={state.model} onChange={e=>update({model:e.target.value})} className="bg-transparent text-sm font-medium w-full outline-none mt-0.5"><option value={state.model}>{state.model}</option>{models.filter(m=>m!==state.model).map(m=><option key={m}>{m}</option>)}</select></div><button type="button" aria-label="Refresh Ollama models" title="Refresh Ollama models" onClick={checkOllama} className="p-2 text-slate-400 hover:text-lime-300"><RefreshCw size={16}/></button></div>
    {messages.length===0?<div className="flex-1 flex flex-col justify-center items-center text-center py-12"><div className="w-16 h-16 rounded-[22px] bg-lime-300/10 border border-lime-300/20 grid place-items-center text-lime-300 mb-5"><Sparkles size={29}/></div><h2 className="text-xl font-semibold">Think locally. Build freely.</h2><p className="text-sm text-slate-500 mt-2 max-w-[270px] leading-relaxed">Chat with Ollama, connect your tools, and bring your own intelligence stack.</p><div className="grid grid-cols-2 gap-2 w-full mt-7">{['Explain a codebase','Draft a SQL query','Plan a project','Debug an error'].map(x=><button key={x} onClick={()=>setDraft(x)} className="text-left p-3 rounded-xl border border-white/[.08] bg-white/[.025] text-xs text-slate-300 active:bg-white/[.08]">{x}<ChevronRight size={13} className="inline ml-1 text-lime-300"/></button>)}</div></div>:<div className="space-y-5 pb-5">{messages.map(m=><div key={m.id} className={'flex gap-3 '+(m.role==='user'?'flex-row-reverse':'')}><div className={'w-8 h-8 shrink-0 rounded-xl grid place-items-center '+(m.role==='user'?'bg-slate-700':'bg-lime-300/10 text-lime-300')}>{m.role==='user'?<Smartphone size={15}/>:<Bot size={17}/>}</div><div className={'max-w-[calc(100%_-_2.75rem)] sm:max-w-[86%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words '+(m.role==='user'?'bg-lime-300 text-slate-950 rounded-tr-sm':'bg-white/[.055] border border-white/[.06] rounded-tl-sm text-slate-200')}>{m.content?(m.role==='assistant'?<MarkdownMessage content={m.content}/>:m.content):<span className="text-slate-500">Thinking…</span>}<div className={'text-[10px] mt-2 flex items-center gap-2 '+(m.role==='user'?'text-slate-700':'text-slate-600')}><span>{m.time}</span>{m.role==='assistant'&&m.content&&<button type="button" aria-label="Copy assistant response" title="Copy response" onClick={async()=>{try{await navigator.clipboard.writeText(m.content);setNotice('Assistant response copied.');}catch{setNotice('Could not copy response. Check clipboard permissions.');}}} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-slate-400 hover:text-lime-300 active:bg-white/10"><Copy size={12}/><span>Copy</span></button>}</div></div></div>)}{busy&&<div className="text-xs text-lime-300 flex items-center gap-2 pl-11"><LoaderCircle size={13} className="animate-spin"/> Generating locally</div>}<div ref={bottomRef}/></div>}
   </section>}
   {tab==='tools'&&<section><p className="text-xs text-lime-300 font-semibold tracking-widest uppercase">Extensions</p><h1 className="text-2xl font-semibold mt-1">Tool registry</h1><p className="text-sm text-slate-500 mt-2 mb-6">Connect capabilities to give Axiom hands, not just answers.</p><div className="rounded-2xl border border-lime-300/20 bg-lime-300/[.045] p-4 mb-4"><div className="flex gap-3 items-center"><div className="w-10 h-10 rounded-xl bg-lime-300/10 text-lime-300 grid place-items-center"><Layers3 size={20}/></div><div className="flex-1"><div className="font-medium text-sm">Extensible registry</div><div className="text-xs text-slate-500 mt-1">Async tools · JSON schema · local execution</div></div><badge className="hidden">Core</badge><span className="text-[10px] text-lime-300 border border-lime-300/20 rounded-full px-2 py-1">CORE</span></div></div>{state.tools.map(t=><div key={t.id} className="rounded-2xl border border-white/[.08] bg-white/[.025] p-4 mb-3"><div className="flex items-center gap-3"><div className="w-11 h-11 rounded-xl bg-white/[.06] grid place-items-center"><Icon name={t.icon} size={20}/></div><div className="flex-1"><div className="font-medium text-sm">{t.name}</div><div className="text-xs text-slate-500 mt-1">{t.description}</div></div><button type="button" role="switch" aria-checked={t.enabled} aria-label={"Enable "+t.name+" integration"} onClick={()=>toggleIntegration(t.id)} className={'w-11 h-6 rounded-full p-1 transition '+(t.enabled?'bg-lime-300':'bg-slate-700')}><span className={'block w-4 h-4 rounded-full bg-white transition '+(t.enabled?'translate-x-5':'')}/></button></div>{t.enabled&&<div className="mt-4 pt-3 border-t border-white/[.07] text-xs text-lime-300 flex gap-2"><Check size={14}/> Registered: {listTools().filter(x=>x.name.startsWith(t.id==='github'?'github_':'supabase_')).length} runtime tools.</div>}</div>)}<button onClick={async()=>{const snippet="import { registerTool } from './lib/toolRegistry.js';\n\nregisterTool({\n  name: 'my_custom_tool',\n  description: 'Describe what this tool does',\n  inputSchema: { type: 'object', properties: {}, additionalProperties: false }\n}, async (input) => {\n  // Implement your async capability here\n  return { ok: true };\n});";try{await navigator.clipboard.writeText(snippet);setNotice('Custom tool template copied. Add it to your app code and register it at startup.');}catch{setNotice('Clipboard unavailable. Import registerTool from ./lib/toolRegistry.js to add a custom async tool.');}}} className="w-full p-4 rounded-2xl border border-dashed border-white/15 text-sm text-slate-400 flex justify-center items-center gap-2"><Plus size={16}/> Copy custom tool template</button></section>}
   {tab==='mcp'&&<section><p className="text-xs text-lime-300 font-semibold tracking-widest uppercase">Connectivity</p><h1 className="text-2xl font-semibold mt-1">MCP servers</h1><p className="text-sm text-slate-500 mt-2 mb-6">Connect external Model Context Protocol servers and discover their tools.</p><div className="rounded-2xl border border-white/[.08] bg-white/[.025] p-4 mb-5"><div className="flex items-center gap-2 mb-4"><Server size={18} className="text-lime-300"/><span className="font-medium text-sm">Add endpoint</span></div><label className="text-xs text-slate-500">Server name</label><input aria-label="Server name" value={serverName} onChange={e=>setServerName(e.target.value)} placeholder="My MCP server" className="w-full mt-1 mb-3 p-3 rounded-xl bg-black/30 border border-white/10 text-sm outline-none focus:border-lime-300/50"/><label className="text-xs text-slate-500">Direct endpoint URL (optional)</label><input aria-label="Endpoint URL" value={serverUrl} onChange={e=>setServerUrl(e.target.value)} placeholder="https://example.com/mcp or /sse" className="w-full mt-1 mb-3 p-3 rounded-xl bg-black/30 border border-white/10 text-sm outline-none focus:border-lime-300/50"/><label className="text-xs text-slate-500">Transport</label><select aria-label="MCP transport" value={serverTransport} onChange={e=>setServerTransport(e.target.value)} className="w-full mt-1 mb-3 p-3 rounded-xl bg-[#090d14] border border-white/10 text-sm outline-none"><option value="http">Streamable HTTP</option><option value="sse">Legacy SSE (no auth header)</option></select><label className="text-xs text-slate-500">Gateway MCP server ID (recommended)</label><input aria-label="Gateway MCP server ID" value={serverGatewayId} onChange={e=>setServerGatewayId(e.target.value)} placeholder="filesystem" className="w-full mt-1 p-3 rounded-xl bg-black/30 border border-white/10 text-sm outline-none"/><p className="text-[11px] text-slate-500 mt-2">Configure this ID and its credentials in MCP_SERVERS_JSON on the gateway.</p><button onClick={addServer} className="w-full mt-3 p-3 rounded-xl bg-lime-300 text-slate-950 text-sm font-semibold">Add server</button></div>{state.servers.length===0?<div className="text-center py-12 text-slate-500"><Globe2 size={28} className="mx-auto mb-3 opacity-50"/><p className="text-sm">No MCP servers connected yet.</p></div>:state.servers.map(s=><div key={s.id} className="rounded-2xl border border-white/[.08] bg-white/[.025] p-4 mb-3"><div className="flex items-start gap-3"><div className="w-10 h-10 rounded-xl bg-white/[.06] grid place-items-center"><Radio size={18}/></div><div className="flex-1 min-w-0"><div className="font-medium text-sm">{s.name}</div><div className="text-xs text-slate-500 truncate mt-1">{s.url}</div><div className="text-[10px] mt-2 text-slate-400">{s.transport==='sse'?'Legacy SSE':'Streamable HTTP'} · {s.status} · {s.tools.length} tools</div></div><button type="button" aria-label={"Reconnect "+s.name} title="Reconnect server" onClick={()=>discoverServer(s.id)} className="p-2 rounded-lg bg-white/[.06] text-lime-300"><RefreshCw size={15}/></button><button type="button" aria-label={"Remove "+s.name} title="Remove server" onClick={()=>{mcpAttempts.current[s.id]=(mcpAttempts.current[s.id]||0)+1;mcpCleanup.current[s.id]?.();delete mcpCleanup.current[s.id];setState(current=>({...current,servers:current.servers.filter(x=>x.id!==s.id)}));log('info','MCP server removed',s.name);}} className="p-2 text-slate-500"><Trash2 size={15}/></button></div>{s.tools.map(t=><div key={t.name} className="mt-3 p-3 rounded-xl bg-black/20"><div className="text-xs font-medium">{t.name}</div><div className="text-xs text-slate-500 mt-1">{t.description}</div><pre className="text-[10px] text-slate-600 overflow-auto mt-2">{JSON.stringify(t.inputSchema||{},null,2)}</pre></div>)}</div>)}<div className="text-[11px] text-slate-600 leading-relaxed mt-5">MCP connections depend on server CORS support. Legacy SSE cannot send custom authorization headers from the browser; use a trusted same-origin proxy for authenticated production servers.</div></section>}
   {tab==='logs'&&<section><div className="flex items-center justify-between"><div><p className="text-xs text-lime-300 font-semibold tracking-widest uppercase">Observability</p><h1 className="text-2xl font-semibold mt-1">Execution logs</h1></div><button type="button" aria-label="Clear execution logs" title="Clear logs" onClick={()=>update({logs:[]})} className="p-2 rounded-xl bg-white/[.05] text-slate-400"><Trash2 size={17}/></button></div><p className="text-sm text-slate-500 mt-2 mb-6">Live request traces, tool activity, and responses.</p>{state.logs.length===0?<div className="text-center py-16 text-slate-500"><Terminal size={28} className="mx-auto mb-3 opacity-50"/><p className="text-sm">No execution events yet.</p></div>:<div className="space-y-2">{state.logs.map(l=><div key={l.id} className="rounded-xl border border-white/[.07] bg-white/[.025] overflow-hidden"><button onClick={()=>setExpanded(s=>({...s,[l.id]:!s[l.id]}))} className="w-full p-3 flex items-center gap-3 text-left"><span className={'w-2 h-2 rounded-full '+(l.kind==='success'?'bg-lime-400':l.kind==='error'?'bg-red-400':l.kind==='request'?'bg-sky-400':'bg-slate-500')}/><span className="text-xs flex-1 font-medium">{l.title}</span><span className="text-[10px] text-slate-600">{l.time}</span>{expanded[l.id]?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button>{expanded[l.id]&&<pre className="p-3 pt-0 text-[11px] text-slate-400 whitespace-pre-wrap break-words">{l.detail||'No additional details.'}</pre>}</div>)}</div>}</section>}
  </main>
  <div className="fixed bottom-0 left-0 right-0 z-40 max-w-3xl mx-auto">
   {tab==='chat'&&<div className="px-3 pb-2"><div className="glass border border-white/[.12] rounded-2xl p-2 shadow-2xl"><textarea aria-label="Message your local model" enterKeyHint="send" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();sendMessage();}}} rows={2} placeholder="Message your local model…" className="w-full min-h-[44px] max-h-32 overflow-y-auto resize-none bg-transparent px-2 py-2 text-sm leading-5 outline-none placeholder:text-slate-600"/><div className="flex items-center justify-between px-1"><span className="text-[10px] text-slate-600">Enter to send · Shift + Enter for newline</span>{busy?<button onClick={stopGeneration} aria-label="Stop generation" title="Stop generation" className="w-11 h-11 rounded-xl bg-red-400 text-slate-950 grid place-items-center active:scale-95"><Square size={16} fill="currentColor"/></button>:<button onClick={sendMessage} disabled={!draft.trim()} aria-label="Send message" className="w-11 h-11 rounded-xl bg-lime-300 text-slate-950 grid place-items-center disabled:opacity-30 active:scale-95"><ArrowUp size={19}/></button>}</div></div></div>}
   <nav className="glass border-t border-white/[.09] safe-bottom grid grid-cols-4 px-2 pt-2">{nav.map(n=>{const I=n.icon;return <button key={n.id} onClick={()=>setTab(n.id)} className={'min-h-11 flex flex-col items-center justify-center gap-1 py-2 rounded-xl transition '+(tab===n.id?'text-lime-300':'text-slate-500')}><I size={19} strokeWidth={tab===n.id?2.4:1.8}/><span className="text-[10px] font-medium">{n.label}</span>{tab===n.id&&<span className="w-1 h-1 rounded-full bg-lime-300"/>}</button>})}</nav>
  </div>
  {showSettings&&<div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center" onClick={()=>setShowSettings(false)}><div ref={settingsDialogRef} role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title" onClick={e=>e.stopPropagation()} className="w-full max-w-lg rounded-t-3xl sm:rounded-3xl border border-white/10 bg-[#11151d] p-5 pb-9 max-h-[88vh] overflow-auto"><div className="flex items-center justify-between mb-5"><div><div className="text-xs text-lime-300 tracking-widest uppercase">Configuration</div><h2 id="settings-dialog-title" className="text-xl font-semibold mt-1">Settings</h2></div><button aria-label="Close settings" onClick={()=>setShowSettings(false)} className="p-2 rounded-xl bg-white/[.06]"><X size={18}/></button></div><div className="rounded-2xl border border-lime-300/15 bg-lime-300/[.04] p-3 mb-4"><div className="text-sm font-semibold mb-2">Authenticated local gateway</div><label className="text-xs text-slate-400">Gateway URL</label><input aria-label="Gateway URL" value={state.settings?.gatewayUrl||""} onChange={e=>update({settings:{...state.settings,gatewayUrl:e.target.value}})} placeholder="http://127.0.0.1:8787" className="w-full mt-1 mb-3 p-3 rounded-xl bg-black/30 border border-white/10 text-sm outline-none"/><label className="text-xs text-slate-400">Gateway bearer token (session only)</label><input aria-label="Gateway bearer token" type="password" autoComplete="off" value={gatewayToken} onChange={e=>setGatewayToken(e.target.value)} placeholder="Paste AXIOM_GATEWAY_TOKEN" className="w-full mt-1 p-3 rounded-xl bg-black/30 border border-white/10 text-sm outline-none"/><p className="text-[11px] text-slate-500 mt-2">The token is kept in memory only and cleared when this page reloads. When configured, Ollama requests use the authenticated gateway.</p></div><label className="text-xs text-slate-400">Direct Ollama API base URL (gateway disabled)</label><input aria-label="Ollama API base URL" value={state.baseUrl} onChange={e=>update({baseUrl:e.target.value})} className="w-full mt-2 mb-4 p-3 rounded-xl bg-black/30 border border-white/10 text-sm outline-none focus:border-lime-300/50"/><label className="text-xs text-slate-400">Default model</label><input aria-label="Default model" value={state.model} onChange={e=>update({model:e.target.value})} placeholder="qwen2.5:1.5b" className="w-full mt-2 mb-4 p-3 rounded-xl bg-black/30 border border-white/10 text-sm outline-none focus:border-lime-300/50"/><div className="border-t border-white/[.08] my-5 pt-5"><div className="text-sm font-semibold mb-3">GitHub integration</div><p className="text-xs text-slate-500 mb-2">The gateway holds GITHUB_TOKEN. Set GITHUB_TOKEN and GITHUB_REPOSITORY on the gateway process.</p><label className="text-xs text-slate-400">Repository</label><input aria-label="GitHub repository" value={state.settings?.githubRepo||'michaelkage/Axiom'} onChange={e=>update({settings:{...state.settings,githubRepo:e.target.value}})} className="w-full mt-1 p-3 rounded-xl bg-black/30 border border-white/10 text-sm outline-none"/><div className="text-sm font-semibold mt-5 mb-3">Supabase integration</div><p className="text-xs text-slate-500">The gateway holds SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY. Never configure a service-role key here.</p></div><button onClick={()=>{checkOllama();}} className="w-full p-3 rounded-xl bg-lime-300 text-slate-950 text-sm font-semibold">Test Ollama connection</button><div className="mt-5 p-3 rounded-xl bg-amber-300/[.06] border border-amber-300/10 text-xs text-amber-200/80 leading-relaxed"><Shield size={14} className="inline mr-2"/>LocalStorage persists your configuration and conversations on this device. It is not encrypted. Avoid storing production secrets or high-privilege tokens here. Browser access to localhost also requires Ollama CORS configuration; HTTPS pages may be blocked from calling an HTTP localhost endpoint by browser security rules.</div><div className="mt-5 text-xs text-slate-600">Axiom PWA · 1.1.0 · Mobile companion</div></div></div>}
  {pendingApproval&&<div className="fixed inset-0 z-[70] bg-black/80 p-4 flex items-end sm:items-center justify-center"><section ref={approvalDialogRef} role="alertdialog" aria-modal="true" aria-labelledby="tool-approval-title" className="w-full max-w-lg rounded-3xl border border-amber-300/20 bg-[#11151d] p-5 shadow-2xl"><div className="flex items-center gap-3 mb-3"><div className="w-10 h-10 rounded-xl bg-amber-300/10 text-amber-300 grid place-items-center"><Shield size={20}/></div><div><p className="text-xs uppercase tracking-widest text-amber-300">Permission required</p><h2 id="tool-approval-title" className="font-semibold">Approve tool execution?</h2></div></div><p className="text-sm text-slate-300">Axiom is requesting permission to run <strong>{pendingApproval.name}</strong>.</p><pre className="mt-3 max-h-48 overflow-auto rounded-xl bg-black/40 border border-white/10 p-3 text-xs text-slate-300 whitespace-pre-wrap break-words">{JSON.stringify(pendingApproval.args,null,2)}</pre><p className="text-xs text-slate-500 mt-3">Review the arguments before allowing this action. Remote tool descriptions are not trusted instructions.</p><div className="grid grid-cols-2 gap-3 mt-5"><button type="button" onClick={()=>approvalResolver.current?.(false)} className="min-h-12 rounded-xl border border-white/10 bg-white/[.04] text-slate-200">Decline</button><button type="button" onClick={()=>approvalResolver.current?.(true)} className="min-h-12 rounded-xl bg-lime-300 text-slate-950 font-semibold">Allow once</button></div></section></div>}{notice&&<div className="fixed z-[60] bottom-28 left-4 right-4 max-w-xl mx-auto p-3 rounded-xl bg-slate-800 border border-white/10 text-sm flex items-center justify-between shadow-xl"><span>{notice}</span><button type="button" aria-label="Dismiss notification" onClick={()=>setNotice('')}><X size={16}/></button></div>}
 </div>;
}
function NetworkIcon(props){return <Globe2 {...props}/>;}
