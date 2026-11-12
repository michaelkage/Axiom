import React, { useMemo, useRef, useState } from 'react';
import { Code2, Download, FilePlus2, RotateCcw, Search, Save } from 'lucide-react';

const KEYWORDS = new Set(['const','let','var','function','return','if','else','for','while','class','extends','import','from','export','default','async','await','try','catch','throw','new','this','true','false','null','undefined','public','private','static','interface','type','enum','def','pass','lambda','select','from','where','insert','update','delete','create','table','join','as','and','or','not']);

function tokenClass(token) {
  if (/^(\/\/|\/\*|#)/.test(token)) return 'editor-comment';
  if (/^["']/.test(token)) return 'editor-string';
  if (/^\d/.test(token)) return 'editor-number';
  if (KEYWORDS.has(token)) return 'editor-keyword';
  return '';
}

function HighlightedCode({ value }) {
  const pattern = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|var|function|return|if|else|for|while|class|extends|import|from|export|default|async|await|try|catch|throw|new|this|true|false|null|undefined|public|private|static|interface|type|enum|def|pass|lambda|select|where|insert|update|delete|create|table|join|as|and|or|not)\b|\b\d+(?:\.\d+)?\b)/g;
  const nodes = [];
  let cursor = 0;
  let index = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > cursor) nodes.push(value.slice(cursor, match.index));
    nodes.push(<span key={index++} className={tokenClass(match[0])}>{match[0]}</span>);
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes;
}

export default function CodeEditor() {
  const [fileName, setFileName] = useState('untitled.js');
  const [language, setLanguage] = useState('javascript');
  const [value, setValue] = useState('');
  const [original, setOriginal] = useState('');
  const [dirty, setDirty] = useState(false);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [notice, setNotice] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const inputRef = useRef(null);
  const gutterRef = useRef(null);
  const editorRef = useRef(null);
  const highlightRef = useRef(null);

  const lineCount = useMemo(() => Math.max(1, value.split('\n').length), [value]);
  const languageFor = name => {
    const extension = String(name).split('.').pop().toLowerCase();
    return ({ js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', css: 'css', html: 'html', py: 'python', sql: 'sql', sh: 'shell', kt: 'kotlin', java: 'java', md: 'markdown' })[extension] || 'text';
  };

  async function openFile(file) {
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setNotice('Editor files are limited to 1 MiB. Split or reduce this file before opening it.');
      return;
    }
    try {
      const text = await file.text();
      setFileName(file.name || 'untitled.txt');
      setLanguage(languageFor(file.name || ''));
      setValue(text);
      setOriginal(text);
      setDirty(false);
      setNotice('File opened in the local editor. Original source remains unchanged until you save a copy.');
    } catch (error) {
      setNotice('Could not read file: ' + error.message);
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function saveFile() {
    const blob = new Blob([value], { type: 'text/plain;charset=utf-8' });
    const suggestedName = fileName.replace(/(\.[^.]+)?$/, '.edited$1');
    try {
      if (typeof window.showSaveFilePicker === 'function') {
        const handle = await window.showSaveFilePicker({ suggestedName: fileName, types: [{ description: 'Text and source files', accept: { 'text/plain': ['.txt','.js','.jsx','.ts','.tsx','.json','.css','.html','.md','.sql','.py','.sh','.kt','.java'] } }] });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        setOriginal(value);
        setDirty(false);
        setNotice('Saved changes to ' + handle.name + '.');
        return;
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = suggestedName;
      anchor.click();
      URL.revokeObjectURL(url);
      setOriginal(value);
      setDirty(false);
      setNotice('Downloaded edited copy: ' + suggestedName + '. The imported original was not overwritten.');
    } catch (error) {
      if (error.name !== 'AbortError') setNotice('Could not save file: ' + error.message);
    }
  }

  function replaceNext() {
    if (!findText) return;
    const index = value.indexOf(findText, editorRef.current?.selectionStart || 0);
    if (index < 0) { setNotice('No further match found.'); return; }
    const next = value.slice(0, index) + replaceText + value.slice(index + findText.length);
    setValue(next);
    setDirty(next !== original);
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(index, index + replaceText.length);
    });
  }

  function replaceAll() {
    if (!findText) return;
    const next = value.split(findText).join(replaceText);
    setValue(next);
    setDirty(next !== original);
    setNotice(next === value ? 'No matching text found.' : 'Replaced all matching text.');
  }

  function handleScroll(event) {
    if (!highlightRef.current) return;
    highlightRef.current.scrollTop = event.currentTarget.scrollTop;
    highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
    if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
  }

  return <section className="space-y-4">
    <div className="flex items-start justify-between gap-3">
      <div><p className="text-xs text-lime-300 font-semibold tracking-widest uppercase">WORKSPACE / EDITOR</p><h1 className="text-2xl font-semibold mt-1">Code workspace.</h1><p className="text-sm text-slate-500 mt-2">Open a source file, make a quick edit, then save it or export an edited copy.</p></div>
      <Code2 size={24} className="text-lime-300 shrink-0 mt-2"/>
    </div>
    <div className="flex items-center gap-2 border border-white/10 bg-white/[.025] p-2">
      <input ref={inputRef} type="file" hidden accept=".txt,.md,.json,.js,.jsx,.ts,.tsx,.css,.html,.sql,.py,.sh,.kt,.java,.xml,.yaml,.yml,.toml,.log,.csv" onChange={event => openFile(event.target.files?.[0])}/>
      <button type="button" onClick={() => inputRef.current?.click()} className="min-h-10 px-3 border border-white/15 text-xs flex items-center gap-2"><FilePlus2 size={14}/> Open file</button>
      <button type="button" onClick={saveFile} disabled={!dirty} className="min-h-10 px-3 bg-lime-300 text-slate-950 text-xs font-semibold flex items-center gap-2 disabled:opacity-35"><Save size={14}/> Save</button>
      <button type="button" onClick={() => { setValue(original); setDirty(false); setNotice('Reverted to the last opened or saved version.'); }} disabled={!dirty} className="min-h-10 px-3 border border-white/15 text-xs flex items-center gap-2 disabled:opacity-35"><RotateCcw size={14}/> Revert</button>
    </div>
    <div className="flex items-center justify-between gap-3 text-xs">
      <div className="min-w-0"><span className="font-semibold text-slate-200 truncate">{fileName}</span><span className="text-slate-500 ml-2">{language}</span></div>
      <span className={dirty ? 'text-amber-300' : 'text-slate-500'}>{dirty ? 'UNSAVED' : 'SAVED'}</span>
    </div>
    <div className="border border-white/15 bg-[#090d13] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <span className="text-[10px] uppercase tracking-widest text-slate-500">Source buffer · {lineCount} lines</span>
        <button type="button" onClick={() => setShowReplace(value => !value)} className="text-[10px] text-lime-300 flex items-center gap-1"><Search size={12}/> Find / replace</button>
      </div>
      {showReplace && <div className="grid grid-cols-2 gap-2 p-2 border-b border-white/10">
        <input aria-label="Find text" value={findText} onChange={event => setFindText(event.target.value)} placeholder="Find" className="min-w-0 p-2 bg-black/40 border border-white/15 text-xs"/>
        <input aria-label="Replace text" value={replaceText} onChange={event => setReplaceText(event.target.value)} placeholder="Replace with" className="min-w-0 p-2 bg-black/40 border border-white/15 text-xs"/>
        <button type="button" onClick={replaceNext} className="min-h-9 border border-white/15 text-xs">Replace next</button>
        <button type="button" onClick={replaceAll} className="min-h-9 border border-white/15 text-xs">Replace all</button>
      </div>}
      <div className="code-editor-shell flex relative" style={{ height: 'min(58dvh, 620px)', minHeight: 280 }}>
        <div ref={gutterRef} aria-hidden="true" className="code-editor-gutter select-none text-right py-3 px-2 text-[11px] leading-6 text-slate-600 border-r border-white/10 bg-black/20 overflow-hidden">{Array.from({ length: lineCount }, (_, index) => <div key={index}>{index + 1}</div>)}</div>
        <div className="relative flex-1 min-w-0 overflow-hidden">
          <pre ref={highlightRef} aria-hidden="true" className="code-editor-highlight absolute inset-0 m-0 p-3 overflow-hidden text-[12px] leading-6 font-mono whitespace-pre pointer-events-none"><code><HighlightedCode value={value + '\n'}/></code></pre>
          <textarea ref={editorRef} aria-label="Code editor" spellCheck={false} autoCapitalize="off" autoCorrect="off" value={value} onChange={event => { setValue(event.target.value); setDirty(event.target.value !== original); }} onScroll={handleScroll} className="code-editor-input absolute inset-0 w-full h-full resize-none m-0 p-3 text-[12px] leading-6 font-mono whitespace-pre overflow-auto bg-transparent outline-none" placeholder="// Open a source file to begin editing…"/>
        </div>
      </div>
    </div>
    {notice && <div role="status" className="text-xs text-slate-300 border border-white/10 p-3">{notice}</div>}
    <p className="text-[11px] text-slate-500 leading-relaxed">Safety: Axiom edits an in-memory copy. When the File System Access API is unavailable, Save downloads a new edited copy instead of silently overwriting the original. This editor does not grant access to the app-private Android runtime workspace.</p>
  </section>;
}
