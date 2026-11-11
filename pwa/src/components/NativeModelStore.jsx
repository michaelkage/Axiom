import React, { useMemo, useState } from 'react';
import { Cpu, Download, HardDrive, LoaderCircle, RefreshCw, Search, Trash2, Zap } from 'lucide-react';

const formatBytes = value => {
  const bytes = Number(value || 0);
  if (!bytes) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / Math.pow(1024, index)).toFixed(index > 1 ? 1 : 0) + ' ' + units[index];
};

export default function NativeModelStore({
  models = [], capabilities = null, loadedModel = '', progress = null,
  busy = false, onRefresh, onSearch, onFiles, onDownload, onLoad, onUnload, onDelete
}) {
  const [query, setQuery] = useState('Qwen2.5 1.5B GGUF');
  const [results, setResults] = useState([]);
  const [filesByRepo, setFilesByRepo] = useState({});
  const [selectedFiles, setSelectedFiles] = useState({});
  const [searching, setSearching] = useState(false);
  const [loadingRepo, setLoadingRepo] = useState('');
  const [error, setError] = useState('');

  async function search(event) {
    event?.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError('');
    try {
      const params = new URLSearchParams({ search: query.trim(), filter: 'gguf', sort: 'downloads', direction: '-1', limit: '20' });
      const response = await fetch('https://huggingface.co/api/models?' + params, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('Hugging Face returned HTTP ' + response.status + '.');
      const payload = await response.json();
      setResults((Array.isArray(payload) ? payload : []).filter(item => item?.id?.includes('/')));
    } catch (cause) {
      setError(cause.message || 'Could not search Hugging Face.');
    } finally {
      setSearching(false);
    }
  }

  async function inspect(repo) {
    setLoadingRepo(repo);
    setError('');
    try {
      const files = await onFiles(repo);
      setFilesByRepo(current => ({ ...current, [repo]: files }));
      const preferred = files.find(file => /Q4_K_M/i.test(file.path)) || files.find(file => /Q4/i.test(file.path)) || files[0];
      if (preferred) setSelectedFiles(current => ({ ...current, [repo]: preferred.path }));
      if (!files.length) setError('This repository has no GGUF files.');
    } catch (cause) {
      setError(cause.message || 'Could not inspect GGUF files.');
    } finally {
      setLoadingRepo('');
    }
  }

  const totalInstalled = useMemo(() => models.reduce((sum, model) => sum + Number(model.sizeBytes || 0), 0), [models]);
  const active = models.find(model => model.id === loadedModel || model.loaded);

  return <section className="space-y-5">
    <header>
      <p className="text-xs text-lime-300 font-semibold tracking-widest uppercase">NATIVE INFERENCE / ANDROID</p>
      <h1 className="text-2xl font-semibold mt-1">Axiom model vault.</h1>
      <p className="text-sm text-slate-500 mt-2">GGUF models live in Axiom's private app storage and run through the bundled llama.cpp engine. No Termux or Ollama required.</p>
    </header>

    <div className="grid grid-cols-2 gap-2">
      <div className="border border-white/10 bg-white/[.025] p-3">
        <div className="flex items-center gap-2 text-xs text-slate-500"><Cpu size={14}/> DEVICE MEMORY</div>
        <div className="text-lg font-semibold mt-2">{capabilities ? formatBytes(capabilities.availableRamBytes) : '—'}</div>
        <div className="text-[10px] text-slate-600">Available RAM / {capabilities ? formatBytes(capabilities.totalRamBytes) : 'checking'}</div>
      </div>
      <div className="border border-white/10 bg-white/[.025] p-3">
        <div className="flex items-center gap-2 text-xs text-slate-500"><HardDrive size={14}/> MODEL STORAGE</div>
        <div className="text-lg font-semibold mt-2">{capabilities ? formatBytes(capabilities.storageAvailableBytes) : '—'}</div>
        <div className="text-[10px] text-slate-600">Free / {formatBytes(totalInstalled)} used by models</div>
      </div>
    </div>
    {capabilities && <div className="border border-white/10 p-3 text-[11px] text-slate-500">
      <div className="flex justify-between gap-2"><span>Inference backend</span><span className="text-lime-200">{capabilities.inferenceBackend}</span></div>
      <div className="flex justify-between gap-2 mt-1"><span>Architecture</span><span>{capabilities.primaryAbi} · {capabilities.cpuCores} CPU cores</span></div>
      <div className="flex justify-between gap-2 mt-1"><span>Vulkan loader</span><span>{capabilities.vulkanLoaderAvailable ? 'Detected, backend not enabled' : 'Unavailable'}</span></div>
    </div>}

    <div className="border border-white/[.09] bg-white/[.025] p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2"><HardDrive size={17} className="text-lime-300"/><h2 className="text-sm font-semibold">Private model library</h2></div>
        <button type="button" onClick={onRefresh} disabled={busy} aria-label="Refresh native models" className="p-2 border border-white/10 disabled:opacity-40"><RefreshCw size={14}/></button>
      </div>
      {active && <div className="mt-3 p-3 border border-lime-300/20 bg-lime-300/[.05]">
        <div className="text-[10px] text-lime-200 uppercase tracking-widest">Loaded into memory</div>
        <div className="text-sm font-semibold break-all mt-1">{active.name}</div>
        <button type="button" onClick={onUnload} disabled={busy} className="mt-2 min-h-9 px-3 border border-white/10 text-xs disabled:opacity-40">Unload model</button>
      </div>}
      {models.length ? <div className="divide-y divide-white/[.07] mt-2">{models.map(model => <article key={model.id} className="py-3">
        <div className="flex gap-2 items-start"><div className="flex-1 min-w-0"><div className="text-sm font-medium break-all">{model.name}</div><div className="text-[10px] text-slate-500 mt-1">{formatBytes(model.sizeBytes)} · SHA-256 {model.sha256 === 'not-verified' ? 'not available' : (model.sha256 || '').slice(0, 12) + '…'}</div>{model.repo && <div className="text-[10px] text-slate-600 mt-1">{model.repo}</div>}</div>{model.loaded || model.id === loadedModel ? <span className="text-[10px] text-lime-200">Loaded</span> : null}</div>
        <div className="flex gap-2 mt-2"><button type="button" onClick={() => onLoad(model.id)} disabled={busy || model.loaded || model.id === loadedModel} className="min-h-9 px-3 bg-lime-300 text-slate-950 text-xs font-semibold disabled:opacity-40">Load model</button><button type="button" onClick={() => onDelete(model.id)} disabled={busy || model.loaded || model.id === loadedModel} aria-label={'Delete ' + model.name} className="min-h-9 px-3 border border-red-300/20 text-red-200 disabled:opacity-30"><Trash2 size={14}/></button></div>
      </article>)}</div> : <p className="text-xs text-slate-500 py-5 text-center">No native models installed yet.</p>}
    </div>

    <div className="border border-white/[.09] bg-white/[.025] p-4">
      <div className="flex items-center gap-2"><Search size={17} className="text-lime-300"/><h2 className="text-sm font-semibold">Hugging Face GGUF catalogue</h2></div>
      <p className="text-xs text-slate-500 mt-1">Search public GGUF repositories, inspect their actual files and download a specific quantization directly into private storage.</p>
      <form onSubmit={search} className="mt-3 flex gap-2">
        <input value={query} onChange={event => setQuery(event.target.value)} aria-label="Search native Hugging Face models" placeholder="Search GGUF models" className="min-w-0 flex-1 p-3 bg-black/30 border border-white/10 text-sm"/>
        <button type="submit" disabled={searching || !query.trim()} aria-label="Search native model catalogue" className="w-12 min-h-11 bg-white/10 grid place-items-center disabled:opacity-40">{searching ? <LoaderCircle size={16} className="animate-spin"/> : <Search size={16}/>}</button>
      </form>
      {results.map(item => {
        const files = filesByRepo[item.id] || [];
        const selected = files.find(file => file.path === selectedFiles[item.id]) || files[0];
        return <article key={item.id} className="py-3 border-b border-white/[.07]">
          <div className="text-sm font-medium break-all">{item.id}</div>
          <div className="text-[10px] text-slate-500 mt-1">{Number(item.downloads || 0).toLocaleString()} downloads · {Number(item.likes || 0).toLocaleString()} likes · {(item.tags || []).find(tag => tag.startsWith('license:'))?.slice(8) || 'License: inspect model card'}</div>
          <div className="flex flex-wrap gap-2 mt-2"><button type="button" onClick={() => inspect(item.id)} disabled={loadingRepo === item.id || busy} className="min-h-9 px-3 border border-white/10 text-xs disabled:opacity-40">{loadingRepo === item.id ? 'Inspecting…' : files.length ? 'Refresh files' : 'Inspect GGUF files'}</button><a href={'https://huggingface.co/' + item.id} target="_blank" rel="noreferrer" className="min-h-9 px-3 border border-white/10 text-xs flex items-center">Model card</a></div>
          {files.length > 0 && <div className="mt-3"><label className="block text-[10px] text-slate-500 mb-1">GGUF file / quantization</label><select value={selected?.path || ''} onChange={event => setSelectedFiles(current => ({ ...current, [item.id]: event.target.value }))} className="w-full p-2 bg-[#090d14] border border-white/10 text-xs">{files.map(file => <option key={file.path} value={file.path}>{file.path.split('/').pop()} · {formatBytes(file.sizeBytes)}</option>)}</select><button type="button" onClick={() => selected && onDownload({ repo: item.id, file: selected.path, sha256: selected.sha256, sizeBytes: selected.sizeBytes })} disabled={busy || !selected} className="w-full mt-2 min-h-10 bg-lime-300 text-slate-950 text-xs font-semibold disabled:opacity-40"><Download size={14} className="inline mr-1"/> Download into Axiom</button></div>}
        </article>;
      })}
      {error && <p role="alert" className="text-xs text-red-300 mt-3">{error}</p>}
      {progress && <div className="mt-4" role="status" aria-live="polite"><div className="flex justify-between text-xs"><span className="truncate pr-2">{progress.status || 'Downloading model'}</span><span>{progress.percent ?? 0}%</span></div><div className="h-1.5 bg-white/10 mt-2"><div className="h-full bg-lime-300" style={{ width: (progress.percent || 0) + '%' }}/></div><p className="text-[10px] text-slate-500 mt-1">{formatBytes(progress.downloadedBytes)} / {formatBytes(progress.totalBytes)}</p></div>}
    </div>
    <div className="text-[11px] text-amber-200/80 leading-relaxed">Models are downloaded from Hugging Face and stored in Axiom's private app directory. They are removed when app data is cleared or Axiom is uninstalled. Only public repositories are supported in this first native model manager.</div>
  </section>;
}
