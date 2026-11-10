import React, { useEffect, useState } from 'react';
import { Activity, LockKeyhole, Power, ShieldCheck, Zap } from 'lucide-react';
import {
  getRuntimeInfo, isNativeAndroid, registerGatewaySession, setKeepAwake,
  startBackgroundService, stopBackgroundService, storeGatewayPairingToken
} from '../lib/axiomRuntime.js';

export default function RuntimeControls({ gatewayUrl, onSessionToken, onNotice, terminalRows = 24, terminalCols = 80, onTerminalConfigChange = () => {}, gatewaySessionActive = false }) {
  const native = isNativeAndroid();
  const [info, setInfo] = useState(null);
  const [pairingToken, setPairingToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    if (!native) return;
    try { setInfo(await getRuntimeInfo()); } catch (e) { setError(e.message); }
  };
  useEffect(() => {
    refresh();
  }, [native, gatewayUrl]);

  const pair = async () => {
    setBusy(true); setError('');
    try {
      await storeGatewayPairingToken(pairingToken.trim());
      const result = await registerGatewaySession(gatewayUrl);
      onSessionToken(result.token);
      setPairingToken('');
      onNotice('Gateway paired. A short-lived native session token is active.');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const service = async enabled => {
    setError('');
    try {
      if (enabled) await startBackgroundService();
      else await stopBackgroundService();
      await refresh();
    } catch (e) { setError(e.message); }
  };

  const awake = async enabled => {
    setError('');
    try { await setKeepAwake(enabled); await refresh(); }
    catch (e) { setError(e.message); }
  };

  if (!native) return <div className="mt-5 rounded-2xl border border-white/[.08] p-3">
    <div className="text-sm font-semibold flex items-center gap-2"><Activity size={16}/> Native runtime</div>
    <p className="text-xs text-slate-500 mt-2">Available in the installed Android APK. Browser mode cannot start Android services or store credentials in Android Keystore.</p>
  </div>;

  return <div className="mt-5 border-t border-white/[.08] pt-5">
    <div className="flex items-center justify-between mb-3"><div><div className="text-sm font-semibold">Android runtime</div><p className="text-xs text-slate-500 mt-1">Native PTY · private workspaces · foreground execution</p></div><span className="text-[10px] text-lime-300 border border-lime-300/20 rounded-full px-2 py-1">NATIVE</span></div>
    <div className="rounded-xl bg-black/25 p-3 mb-3 flex items-center justify-between"><div><div className="text-xs text-slate-400">Gateway session</div><div className="text-sm font-semibold">{gatewaySessionActive ? 'Registered' : 'Not paired'}</div></div><span className={'w-2 h-2 rounded-full '+(gatewaySessionActive?'bg-lime-400':'bg-slate-600')}/></div>
    <div className="grid grid-cols-2 gap-2 mb-3">
      <div className="rounded-xl bg-black/25 p-3"><div className="text-[10px] text-slate-500">PTY sessions</div><div className="text-lg font-semibold">{info?.terminalCount ?? 0}</div></div>
      <div className="rounded-xl bg-black/25 p-3"><div className="text-[10px] text-slate-500">Workspace</div><div className="text-sm font-semibold truncate">{info?.activeWorkspace ?? 'Loading…'}</div></div>
    </div>
    <div className="flex items-center justify-between rounded-xl bg-black/25 p-3 mb-2"><div className="min-w-0"><div className="text-sm">Background runtime</div><div className="text-[10px] text-slate-500">Persistent notification while active</div></div><button type="button" role="switch" aria-checked={!!info?.serviceRequested} onClick={() => service(!info?.serviceRequested)} className={'w-11 h-6 rounded-full p-1 '+(info?.serviceRequested?'bg-lime-300':'bg-slate-700')}><span className={'block w-4 h-4 rounded-full bg-white '+(info?.serviceRequested?'translate-x-5':'')}/></button></div>
    <div className="flex items-center justify-between rounded-xl bg-black/25 p-3 mb-4"><div className="min-w-0"><div className="text-sm flex items-center gap-2"><Zap size={14}/> Keep CPU awake</div><div className="text-[10px] text-slate-500">Background CPU only. It does not speed up AI and can heat the phone.</div></div><button type="button" role="switch" aria-checked={!!info?.keepAwake} onClick={() => awake(!info?.keepAwake)} className={'w-11 h-6 rounded-full p-1 '+(info?.keepAwake?'bg-lime-300':'bg-slate-700')}><span className={'block w-4 h-4 rounded-full bg-white '+(info?.keepAwake?'translate-x-5':'')}/></button></div>
    <div className="rounded-xl bg-black/25 p-3 mb-4"><div className="text-sm font-semibold mb-2">Terminal defaults</div><div className="grid grid-cols-2 gap-3"><label className="text-[11px] text-slate-500">Rows<input type="number" min="2" max="200" value={terminalRows} onChange={e => onTerminalConfigChange({ terminalRows: Math.max(2, Math.min(200, Number(e.target.value) || 24)) })} className="w-full mt-1 p-2 rounded-lg bg-black/30 border border-white/10 text-sm text-slate-100"/></label><label className="text-[11px] text-slate-500">Columns<input type="number" min="24" max="400" value={terminalCols} onChange={e => onTerminalConfigChange({ terminalCols: Math.max(24, Math.min(400, Number(e.target.value) || 80)) })} className="w-full mt-1 p-2 rounded-lg bg-black/30 border border-white/10 text-sm text-slate-100"/></label></div><p className="text-[10px] text-slate-600 mt-2">Columns auto-fit the available terminal width when the panel is resized.</p></div>
    <div className="rounded-xl border border-lime-300/15 bg-lime-300/[.035] p-3">
      <div className="text-sm font-semibold flex items-center gap-2"><LockKeyhole size={15}/> Secure gateway pairing</div>
      <p className="text-[11px] text-slate-500 mt-1 mb-3">Enter the gateway's existing AXIOM_GATEWAY_TOKEN once. Android encrypts it with Android Keystore, then registers a 12-hour session token. The pairing token never enters browser storage.</p>
      <input type="password" autoComplete="off" value={pairingToken} onChange={e => setPairingToken(e.target.value)} placeholder="Gateway pairing token" aria-label="Gateway pairing token" className="w-full p-3 rounded-xl bg-black/30 border border-white/10 text-sm outline-none"/>
      <button type="button" disabled={busy || pairingToken.trim().length < 32 || !gatewayUrl} onClick={pair} className="w-full mt-2 p-3 rounded-xl bg-lime-300 text-slate-950 text-sm font-semibold disabled:opacity-40">{busy?'Pairing…':'Pair and register session'}</button>
      <p className="text-[10px] text-amber-200/70 mt-2">Android localhost is the phone itself. If the Node gateway runs on your computer, use its reachable HTTPS address instead of 127.0.0.1.</p>
      <div className="text-[10px] text-slate-600 mt-2 flex items-center gap-1"><ShieldCheck size={12}/> Session credentials are memory-only; pairing secret is Keystore-encrypted.</div>
    </div>
    {error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}
  </div>;
}
