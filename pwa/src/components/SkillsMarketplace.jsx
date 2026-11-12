import React, { useEffect, useMemo, useState } from 'react';
import { BookOpen, Check, Download, ExternalLink, RefreshCw, Search, Shield, Sparkles, UploadCloud } from 'lucide-react';
import { loadSkillFromManifest, loadSkillRegistry } from '../lib/skillRegistry.js';

export default function SkillsMarketplace({ installedSkills = [], activeSkillIds = [], onInstall, onToggleActive }) {
  const [registry, setRegistry] = useState([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);
  const [customUrl, setCustomUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    loadSkillRegistry().then(items => { if (active) setRegistry(items); }).catch(reason => { if (active) setError('Could not load curated registry: ' + reason.message); });
    return () => { active = false; };
  }, []);

  const filtered = useMemo(() => registry.filter(item => (item.name + ' ' + item.description).toLowerCase().includes(query.toLowerCase())), [registry, query]);

  async function inspect(source) {
    setLoading(true);
    setError('');
    setNotice('');
    setPreview(null);
    try {
      const skill = await loadSkillFromManifest(source.manifestUrl || source);
      setSelected({ ...source, manifestUrl: skill.sourceUrl });
      setPreview(skill);
    } catch (reason) {
      setSelected(null);
      setError(reason.message || 'Could not inspect skill.');
    } finally {
      setLoading(false);
    }
  }

  function install() {
    if (!preview) return;
    onInstall?.(preview);
    setNotice('Installed ' + preview.name + ' v' + preview.version + '. Activate it for this task when ready.');
  }

  async function inspectCustom(event) {
    event?.preventDefault();
    const url = customUrl.trim();
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') throw new Error('Custom skill manifests must use HTTPS.');
      await inspect({ name: 'Custom skill', source: 'Custom URL', manifestUrl: parsed.toString() });
    } catch (reason) {
      setError(reason.message || 'Enter a valid HTTPS manifest URL.');
    }
  }

  return <section className="space-y-5">
    <div className="flex items-start justify-between gap-3">
      <div><p className="text-xs text-lime-300 font-semibold tracking-widest uppercase">SYSTEM / SKILLS</p><h1 className="text-2xl font-semibold mt-1">Skills marketplace.</h1><p className="text-sm text-slate-500 mt-2">Install reviewed task guidance and activate it per conversation. Skills never grant tools or bypass approvals.</p></div>
      <Sparkles size={24} className="text-lime-300 shrink-0 mt-2"/>
    </div>
    <div className="border border-white/10 bg-white/[.025] p-4">
      <div className="flex items-center gap-2 text-sm font-semibold"><BookOpen size={16} className="text-lime-300"/> Installed skills · this task</div>
      {!installedSkills.length ? <p className="text-xs text-slate-500 mt-3">No skills installed yet. Inspect a curated skill below before installing it.</p> : <div className="mt-3 divide-y divide-white/[.08]">{installedSkills.map(skill => {
        const active = activeSkillIds.includes(skill.id);
        return <div key={skill.id} className="py-3 flex items-start gap-3">
          <div className="flex-1 min-w-0"><div className="text-sm font-medium">{skill.name} <span className="text-[10px] text-slate-500">v{skill.version}</span></div><p className="text-xs text-slate-500 mt-1">{skill.description}</p><div className="text-[10px] text-slate-600 mt-2">Permissions declared: {(skill.permissions || []).join(', ') || 'none'} · Required tools: {(skill.requiredTools || []).join(', ') || 'none'}</div></div>
          <button type="button" role="switch" aria-checked={active} aria-label={'Activate '+skill.name+' for this task'} onClick={() => onToggleActive?.(skill.id)} className={'shrink-0 min-w-14 min-h-10 px-2 border text-[10px] font-semibold ' + (active ? 'border-lime-300 bg-lime-300 text-slate-950' : 'border-white/15 text-slate-300')}>{active ? 'ACTIVE' : 'OFF'}</button>
        </div>;
      })}</div>}
      <p className="text-[10px] text-slate-500 mt-3 flex gap-2"><Shield size={13} className="shrink-0"/> Skill permissions are descriptive only. Existing Axiom tool availability and per-action approval remain authoritative.</p>
    </div>

    <div className="border border-white/10 bg-white/[.025] p-4">
      <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">Curated registry</h2><span className="text-[10px] text-slate-500">{registry.length} entries</span></div>
      <div className="relative mt-3"><Search size={15} className="absolute left-3 top-3 text-slate-500"/><input aria-label="Search skills" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search skills…" className="w-full pl-9 pr-3 py-3 bg-black/30 border border-white/10 text-sm"/></div>
      {filtered.length ? <div className="mt-2 divide-y divide-white/[.08]">{filtered.map(item => {
        const installed = installedSkills.find(skill => skill.id === item.id);
        return <div key={item.id} className="py-3 flex items-center gap-3">
          <div className="flex-1 min-w-0"><div className="text-sm font-medium">{item.name}</div><p className="text-xs text-slate-500 mt-1">{item.description}</p><span className="text-[10px] text-slate-600">{item.source}{installed ? ' · installed v'+installed.version : ''}</span></div>
          <button type="button" onClick={() => inspect(item)} disabled={loading} className="min-h-10 px-3 border border-white/15 text-xs flex items-center gap-1.5 disabled:opacity-40"><ExternalLink size={13}/> Inspect</button>
        </div>;
      })}</div> : <p className="text-xs text-slate-500 py-4">No matching skills in the curated registry.</p>}
      <a href="https://github.com/michaelkage/Axiom/tree/main/pwa/skills" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 mt-4 text-xs text-lime-300 underline underline-offset-4">Publish a skill through the Axiom GitHub repository <ExternalLink size={12}/></a>
    </div>

    <form onSubmit={inspectCustom} className="border border-white/10 bg-white/[.025] p-4">
      <div className="flex items-center gap-2 text-sm font-semibold"><UploadCloud size={16} className="text-lime-300"/> Install from custom URL</div>
      <p className="text-xs text-slate-500 mt-1">Provide an HTTPS URL to a skill.json manifest. Axiom fetches and validates its instructions before installation.</p>
      <input aria-label="Custom skill manifest URL" type="url" inputMode="url" value={customUrl} onChange={event => setCustomUrl(event.target.value)} placeholder="https://example.com/skill.json" className="w-full mt-3 p-3 bg-black/30 border border-white/10 text-xs"/>
      <button type="submit" disabled={loading || !customUrl.trim()} className="w-full mt-2 min-h-11 bg-lime-300 text-slate-950 text-xs font-semibold disabled:opacity-40">{loading ? 'Inspecting…' : 'Inspect custom skill'}</button>
    </form>

    {loading && <div role="status" className="text-xs text-lime-300 flex items-center gap-2"><RefreshCw size={13} className="animate-spin"/> Fetching and validating skill manifest…</div>}
    {error && <p role="alert" className="text-xs text-red-300 border border-red-300/20 p-3">{error}</p>}
    {notice && <p role="status" className="text-xs text-lime-200 border border-lime-300/20 p-3">{notice}</p>}
    {preview && <div className="border border-lime-300/30 bg-lime-300/[.035] p-4 space-y-3">
      <div><p className="text-[10px] uppercase tracking-widest text-lime-300">Skill inspection</p><h2 className="text-lg font-semibold mt-1">{preview.name}</h2><p className="text-xs text-slate-400 mt-1">{preview.description}</p><p className="text-[10px] text-slate-500 mt-1">ID {preview.id} · Version {preview.version}</p></div>
      <div className="grid grid-cols-2 gap-2 text-xs"><div className="border border-white/10 p-2"><div className="text-slate-500 text-[10px] uppercase">Required tools</div><div className="mt-1">{preview.requiredTools.join(', ') || 'None'}</div></div><div className="border border-white/10 p-2"><div className="text-slate-500 text-[10px] uppercase">Model hints</div><div className="mt-1">{preview.modelHints.join(', ') || 'None'}</div></div></div>
      <div className="border border-amber-300/20 bg-amber-300/[.04] p-3"><div className="text-xs font-semibold text-amber-200">Declared safety permissions</div><p className="text-xs text-slate-300 mt-1">{preview.permissions.join(', ') || 'None'}</p><p className="text-[10px] text-slate-500 mt-2">These labels do not grant capabilities. Axiom's existing security controls remain in force.</p></div>
      <details className="border border-white/10 p-3"><summary className="text-xs font-semibold cursor-pointer">Read full SKILL.md instructions</summary><pre className="mt-3 text-[11px] leading-relaxed whitespace-pre-wrap break-words text-slate-300 max-h-72 overflow-auto">{preview.instructions}</pre></details>
      <div className="flex gap-2"><button type="button" onClick={install} className="flex-1 min-h-11 bg-lime-300 text-slate-950 text-xs font-semibold flex items-center justify-center gap-2"><Download size={14}/>{installedSkills.some(skill => skill.id === preview.id) ? 'Update installed skill' : 'Install skill'}</button><button type="button" onClick={() => { setPreview(null); setSelected(null); }} className="min-h-11 px-4 border border-white/15 text-xs">Close</button></div>
    </div>}
  </section>;
}
