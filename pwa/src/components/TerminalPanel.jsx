import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, CircleStop, FolderPlus, Play, RefreshCw, SquareTerminal, X } from 'lucide-react';
import {
  addRuntimeListener, createWorkspace, getRuntimeInfo, isNativeAndroid, listWorkspaces,
  resizeTerminal, selectWorkspace, startTerminal, stopTerminal, writeTerminal
} from '../lib/axiomRuntime.js';

const MAX_SCROLLBACK = 160000;
const cleanAnsi = value => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '');
export default function TerminalPanel({ onNotice }) {
  const native = isNativeAndroid();
  const [runtime, setRuntime] = useState(null);
  const [workspaces, setWorkspaces] = useState([]);
  const [workspace, setWorkspace] = useState('default');
  const [newWorkspace, setNewWorkspace] = useState('');
  const [sessionId, setSessionId] = useState(null);
  const [output, setOutput] = useState('');
  const [input, setInput] = useState('');
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [status, setStatus] = useState('stopped');
  const [error, setError] = useState('');
  const [cols, setCols] = useState(80);
  const [rows, setRows] = useState(24);
  const outputRef = useRef(null);
  const inputRef = useRef(null);
  const sessionRef = useRef(null);
  const append = useCallback(text => setOutput(current => (current + cleanAnsi(text)).slice(-MAX_SCROLLBACK)), []);

  useEffect(() => {
    if (!native) return;
    let alive = true;
    Promise.all([getRuntimeInfo(), listWorkspaces()]).then(([info, items]) => {
      if (!alive) return;
      setRuntime(info);
      setWorkspace(info.activeWorkspace || 'default');
      setWorkspaces(items);
    }).catch(e => alive && setError(e.message));
    let dataListener, exitListener;
    let disposed = false;
    addRuntimeListener('ptyData', event => {
      if (event.sessionId === sessionRef.current) append(event.data || '');
    }).then(listener => { if (disposed) listener.remove(); else dataListener = listener; });
    addRuntimeListener('ptyExit', event => {
      if (event.sessionId === sessionRef.current) {
        sessionRef.current = null;
        setSessionId(null);
        setStatus('stopped');
        append('\r\n[process exited]\r\n');
      }
    }).then(listener => { if (disposed) listener.remove(); else exitListener = listener; });
    return () => {
      disposed = true;
      alive = false;
      dataListener?.remove();
      exitListener?.remove();
      if (sessionRef.current) stopTerminal(sessionRef.current).catch(() => {});
    };
  }, [native, append]);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: 'auto' });
  }, [output]);

  const refreshRuntime = async () => {
    try {
      const [info, items] = await Promise.all([getRuntimeInfo(), listWorkspaces()]);
      setRuntime(info);
      setWorkspace(info.activeWorkspace);
      setWorkspaces(items);
    } catch (e) { setError(e.message); }
  };

  const launch = async () => {
    if (!native || sessionRef.current) return;
    setError('');
    setOutput('');
    setStatus('starting');
    try {
      const result = await startTerminal({ rows, cols });
      sessionRef.current = result.sessionId;
      setSessionId(result.sessionId);
      setStatus('running');
      append('Axiom shell · ' + result.cwd + '\r\n');
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch (e) {
      setStatus('stopped');
      setError(e.message);
    }
  };

  const stop = async (interrupt = false) => {
    if (!sessionRef.current) return;
    const id = sessionRef.current;
    try { await stopTerminal(id, interrupt); } catch (e) { setError(e.message); }
    sessionRef.current = null;
    setSessionId(null);
    setStatus('stopped');
  };

  const send = async value => {
    if (!sessionRef.current || !value) return;
    try { await writeTerminal(sessionRef.current, value); }
    catch (e) { setError(e.message); }
  };

  const onInputKeyDown = event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const command = input;
      setInput('');
      if (command.trim()) {
        setHistory(items => [...items.slice(-99), command]);
        setHistoryIndex(-1);
      }
      send(command + '\r');
    } else if (event.key === 'c' && event.ctrlKey) {
      event.preventDefault();
      setInput('');
      send('\u0003');
      append('^C\r\n');
    } else if (event.key === 'd' && event.ctrlKey) {
      event.preventDefault();
      setInput('');
      send('\u0004');
    } else if (event.key === 'l' && event.ctrlKey) {
      event.preventDefault();
      setOutput('');
      send('\u000c');
    } else if (event.key === 'ArrowUp' && !input) {
      event.preventDefault();
      const next = Math.min(history.length - 1, historyIndex + 1);
      if (next >= 0) { setHistoryIndex(next); setInput(history[history.length - 1 - next]); }
    } else if (event.key === 'ArrowDown' && historyIndex >= 0) {
      event.preventDefault();
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setInput(next < 0 ? '' : history[history.length - 1 - next]);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      setInput(value => value + '    ');
    }
  };

  const changeWorkspace = async name => {
    if (sessionRef.current) await stop();
    try {
      await selectWorkspace(name);
      setWorkspace(name);
      await refreshRuntime();
      append('\r\n[workspace: ' + name + ']\r\n');
    } catch (e) { setError(e.message); }
  };

  const addWorkspace = async () => {
    const name = newWorkspace.trim();
    if (!name) return;
    try {
      const created = await createWorkspace(name);
      setNewWorkspace('');
      await refreshRuntime();
      setWorkspace(created.name);
      setOutput('Workspace created: ' + created.path + '\r\n');
    } catch (e) { setError(e.message); }
  };

  useEffect(() => {
    if (!sessionId) return;
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width || 640;
      const nextCols = Math.max(24, Math.min(180, Math.floor(width / 8)));
      if (nextCols !== cols) {
        setCols(nextCols);
        resizeTerminal(sessionId, rows, nextCols).catch(() => {});
      }
    });
    if (outputRef.current) observer.observe(outputRef.current);
    return () => observer.disconnect();
  }, [sessionId, cols, rows]);

  if (!native) return <section className="py-12 text-center"><SquareTerminal size={34} className="mx-auto text-lime-300 mb-3"/><h1 className="text-xl font-semibold">Native terminal required</h1><p className="text-sm text-slate-500 mt-2 px-6">Install the Android APK to access the native PTY. Browser-only PWA mode cannot spawn an Android shell.</p></section>;

  return <section className="pb-4">
    <div className="flex items-center justify-between mb-4">
      <div><p className="text-xs text-lime-300 font-semibold tracking-widest uppercase">Native runtime</p><h1 className="text-2xl font-semibold mt-1">Terminal</h1><p className="text-xs text-slate-500 mt-1">{runtime?.workspaceRoot || 'Loading private workspace…'}</p></div>
      <button type="button" onClick={refreshRuntime} aria-label="Refresh runtime status" className="p-2 rounded-xl bg-white/[.06] text-slate-300"><RefreshCw size={17}/></button>
    </div>
    <div className="rounded-2xl border border-white/[.08] bg-white/[.025] p-3 mb-3">
      <div className="flex items-center gap-2 mb-3"><select aria-label="Active workspace" value={workspace} onChange={e => changeWorkspace(e.target.value)} className="flex-1 min-w-0 p-3 rounded-xl bg-[#090d14] border border-white/10 text-sm"><option value={workspace}>{workspace}</option>{workspaces.filter(item => item.name !== workspace).map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select><span className={'text-xs '+(status === 'running' ? 'text-lime-300' : 'text-slate-500')}>{status}</span></div>
      <div className="flex gap-2"><input value={newWorkspace} onChange={e => setNewWorkspace(e.target.value)} onKeyDown={e => e.key === 'Enter' && addWorkspace()} placeholder="New project workspace" aria-label="New workspace name" className="min-w-0 flex-1 p-3 rounded-xl bg-black/30 border border-white/10 text-sm"/><button onClick={addWorkspace} aria-label="Create workspace" className="p-3 rounded-xl bg-white/[.08] text-lime-300"><FolderPlus size={18}/></button></div>
    </div>
    <div className="rounded-2xl border border-white/[.1] bg-[#05070b] overflow-hidden">
      <div className="px-3 py-2 flex items-center justify-between border-b border-white/[.08]"><div className="flex items-center gap-2 text-xs text-slate-400"><span className={'w-2 h-2 rounded-full '+(status === 'running' ? 'bg-lime-400' : 'bg-slate-600')}/>{sessionId ? 'PTY session ' + sessionId.slice(0, 8) : 'Shell stopped'}</div><div className="flex gap-2">{sessionId ? <><button onClick={() => { setInput(''); send('\u0003'); }} className="p-2 text-amber-300" aria-label="Send Ctrl+C interrupt"><Activity size={15}/></button><button onClick={() => stop(false)} className="p-2 text-red-300" aria-label="Close terminal session"><CircleStop size={15}/></button></> : <button onClick={launch} className="p-2 text-lime-300" aria-label="Start shell"><Play size={15}/></button>}<button onClick={() => setOutput('')} className="p-2 text-slate-500" aria-label="Clear terminal"><X size={15}/></button></div></div>
      <pre ref={outputRef} onClick={() => inputRef.current?.focus()} className="h-[48vh] min-h-64 max-h-[65vh] overflow-auto p-3 text-[12px] leading-5 text-slate-200 whitespace-pre-wrap break-words font-mono">{output || 'Start the shell to connect to your active workspace.'}</pre>
      <div className="border-t border-white/[.08] p-2"><textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={onInputKeyDown} disabled={!sessionId} rows={2} spellCheck="false" autoCapitalize="off" autoCorrect="off" aria-label="Terminal input" placeholder={sessionId ? 'Type a command… Enter to run · Ctrl+C to interrupt' : 'Start the shell first'} className="w-full resize-none bg-transparent outline-none p-2 text-sm font-mono text-lime-100 placeholder:text-slate-600 disabled:opacity-40"/><div className="flex items-center justify-between px-2 pb-1 text-[10px] text-slate-600"><span>PTY · {rows} × {cols} · scrollback {Math.min(output.length, MAX_SCROLLBACK).toLocaleString()} chars</span><span>Ctrl+C interrupt · Ctrl+D EOF · Ctrl+L clear</span></div></div>
    </div>
    {error && <p role="alert" className="mt-3 rounded-xl bg-red-400/10 border border-red-400/20 p-3 text-xs text-red-200">{error}</p>}
  </section>;
}
