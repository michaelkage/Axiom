import React, { useState } from 'react';
import { Download, ExternalLink, LoaderCircle, Package, RefreshCw, Search, Server, Sparkles } from 'lucide-react';

const QUANTIZATIONS = ['Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0', 'F16'];

export default function ModelStore({ models = [], connection = 'unknown', onRefresh, onPullModel, onSelectModel, pullingModel = '', pullProgress = null, disabled = false }) {
  const [registryName, setRegistryName] = useState('');
  const [query, setQuery] = useState('');
  const [quantization, setQuantization] = useState('Q4_K_M');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');

  async function searchHuggingFace(event) {
    event?.preventDefault();
    const term = query.trim();
    if (!term) return;
    setSearching(true);
    setError('');
    try {
      const params = new URLSearchParams({ search: term, filter: 'gguf', sort: 'downloads', direction: '-1', limit: '15' });
      const response = await fetch('https://huggingface.co/api/models?' + params.toString(), { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('Hugging Face returned HTTP ' + response.status + '.');
      const payload = await response.json();
      setResults((Array.isArray(payload) ? payload : []).filter(item => item?.id && item?.id.includes('/')));
    } catch (requestError) {
      setError(requestError.message || 'Could not search Hugging Face.');
    } finally {
      setSearching(false);
    }
  }

  function installHuggingFace(repo) {
    const name = 'hf.co/' + repo + ':' + quantization;
    onPullModel(name);
  }

  return <section className="space-y-5">
    <div>
      <p className="text-xs text-lime-300 font-semibold tracking-widest uppercase">LOCAL AI / LIBRARY</p>
      <h1 className="text-2xl font-semibold mt-1">Model store.</h1>
      <p className="text-sm text-slate-500 mt-2">Find models, install them into the connected Ollama runtime, and switch models without opening a terminal.</p>
    </div>

    <div className="border border-white/[.09] bg-white/[.025] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2"><Server size={17} className="text-lime-300"/><span className="text-sm font-semibold">Runtime library</span></div>
        <span className={'text-[10px] uppercase tracking-wide ' + (connection === 'online' ? 'text-lime-300' : 'text-amber-200')}>{connection === 'online' ? 'Connected' : 'Not connected'}</span>
      </div>
      <p className="text-xs text-slate-500 mt-1">Installed models on the configured Ollama host.</p>
      <button type="button" onClick={onRefresh} disabled={disabled} className="mt-3 min-h-10 px-3 border border-white/10 text-xs flex items-center gap-2 disabled:opacity-40"><RefreshCw size={14}/> Refresh library</button>
      {models.length ? <div className="mt-3 divide-y divide-white/[.07]">{models.map(model => <div key={model} className="py-3 flex items-center gap-3"><Package size={17} className="text-slate-500"/><span className="text-sm flex-1 break-all">{model}</span><button type="button" onClick={() => onSelectModel(model)} className="min-h-9 px-3 bg-lime-300 text-slate-950 text-xs font-semibold">Use</button></div>)}</div> : <p className="mt-4 py-5 text-center text-xs text-slate-500">No installed models detected yet.</p>}
    </div>

    <div className="border border-white/[.09] bg-white/[.025] p-4">
      <div className="flex items-center gap-2"><Download size={17} className="text-lime-300"/><h2 className="text-sm font-semibold">Install an Ollama model</h2></div>
      <p className="text-xs text-slate-500 mt-1">Pull a model directly into your connected Ollama runtime. Downloads run on that host, not inside the browser.</p>
      <form onSubmit={event => { event.preventDefault(); if (registryName.trim()) onPullModel(registryName.trim()); }} className="mt-3">
        <label className="block text-xs text-slate-400 mb-1" htmlFor="ollama-model-name">Model name or registry ID</label>
        <input id="ollama-model-name" value={registryName} onChange={event => setRegistryName(event.target.value)} placeholder="qwen2.5:1.5b" className="w-full p-3 bg-black/30 border border-white/10 text-sm outline-none"/>
        <button type="submit" disabled={disabled || !registryName.trim() || Boolean(pullingModel)} className="w-full mt-2 min-h-11 bg-lime-300 text-slate-950 text-sm font-semibold disabled:opacity-40">{pullingModel ? 'Installing…' : 'Download and install'}</button>
      </form>
      {pullingModel && <div className="mt-3" role="status" aria-live="polite"><div className="flex justify-between text-xs text-slate-400"><span className="truncate pr-2">{pullingModel}</span><span>{pullProgress?.percent ?? 0}%</span></div><div className="h-1.5 bg-white/10 mt-2 overflow-hidden"><div className="h-full bg-lime-300 transition-all" style={{ width: (pullProgress?.percent ?? 0) + '%' }}/></div><p className="text-[10px] text-slate-500 mt-1">{pullProgress?.status || 'Preparing download…'}{pullProgress?.detail ? ' · ' + pullProgress.detail : ''}</p></div>}
    </div>

    <div className="border border-white/[.09] bg-white/[.025] p-4">
      <div className="flex items-center gap-2"><Sparkles size={17} className="text-sky-300"/><h2 className="text-sm font-semibold">Hugging Face catalogue</h2></div>
      <p className="text-xs text-slate-500 mt-1">Search GGUF repositories. Compatible repositories can be installed through Ollama's Hugging Face model support.</p>
      <form onSubmit={searchHuggingFace} className="mt-3 flex gap-2">
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search Qwen, Llama, Gemma…" aria-label="Search Hugging Face GGUF models" className="min-w-0 flex-1 p-3 bg-black/30 border border-white/10 text-sm outline-none"/>
        <button type="submit" disabled={searching || !query.trim()} aria-label="Search Hugging Face" className="w-12 min-h-11 bg-white/10 grid place-items-center disabled:opacity-40">{searching ? <LoaderCircle size={17} className="animate-spin"/> : <Search size={17}/>}</button>
      </form>
      <label className="block text-xs text-slate-400 mt-3 mb-1" htmlFor="hf-quantization">GGUF quantization</label>
      <select id="hf-quantization" value={quantization} onChange={event => setQuantization(event.target.value)} className="w-full p-3 bg-[#090d14] border border-white/10 text-sm">{QUANTIZATIONS.map(value => <option key={value}>{value}</option>)}</select>
      {error && <p role="alert" className="text-xs text-red-300 mt-3">{error}</p>}
      {results.length > 0 && <div className="mt-3 divide-y divide-white/[.07]">{results.map(item => <article key={item.id} className="py-3"><div className="text-sm font-medium break-all">{item.id}</div><div className="text-[10px] text-slate-500 mt-1">{Number(item.downloads || 0).toLocaleString()} downloads · {Number(item.likes || 0).toLocaleString()} likes</div><div className="flex gap-2 mt-2"><button type="button" disabled={disabled || Boolean(pullingModel)} onClick={() => installHuggingFace(item.id)} className="min-h-9 px-3 bg-lime-300 text-slate-950 text-xs font-semibold disabled:opacity-40">Install {quantization}</button><a href={'https://huggingface.co/' + encodeURIComponent(item.id).replace('%2F', '/')} target="_blank" rel="noreferrer" className="min-h-9 px-3 border border-white/10 text-xs flex items-center gap-1">Model card <ExternalLink size={12}/></a></div></article>)}</div>}
      {!results.length && !searching && <p className="text-[11px] text-slate-600 mt-3">Search results are fetched from Hugging Face. Check the model card, license, architecture, and available quantizations before installing.</p>}
    </div>

    <p className="text-[11px] text-amber-200/80 leading-relaxed">Runtime note: Axiom installs models into the Ollama host you connected. Android itself cannot run the standard desktop Ollama daemon. To use models fully on-device without Termux or another host, Axiom needs a separate Android-native inference runtime.</p>
  </section>;
}
