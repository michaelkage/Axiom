import React from 'react';
import { ArrowUpRight, BookOpen, Github, Database, ShieldCheck } from 'lucide-react';

export default function IntegrationGuide({ gatewayUrl, paired, onOpenSettings }) {
  return <section className="rounded-2xl border border-sky-300/15 bg-sky-300/[.035] p-4 mb-4">
    <div className="flex items-start gap-3">
      <div className="w-10 h-10 shrink-0 rounded-xl bg-sky-300/10 text-sky-200 grid place-items-center"><BookOpen size={19}/></div>
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold">Integration setup guide</h2>
        <p className="text-xs text-slate-400 mt-1">GitHub and Supabase connect through Axiom's authenticated Node gateway. The APK does not connect to either service directly.</p>
      </div>
      <span className={'text-[10px] rounded-full px-2 py-1 border '+(paired?'text-lime-300 border-lime-300/20':'text-amber-200 border-amber-200/20')}>{paired?'PAIRED':'NOT PAIRED'}</span>
    </div>
    <ol className="mt-4 space-y-3 text-xs text-slate-300">
      <li className="flex gap-2"><span className="text-sky-200 font-semibold">1.</span><span><strong>Run the gateway</strong> on the device that can reach Ollama and the internet. On Android, that may be Termux. The gateway must be running before integrations can work.</span></li>
      <li className="flex gap-2"><span className="text-sky-200 font-semibold">2.</span><span><strong>Configure the gateway environment</strong> where <code>npm run gateway</code> runs. Set <code>AXIOM_GATEWAY_TOKEN</code> (random, 32+ characters), <code>GITHUB_TOKEN</code>, <code>GITHUB_REPOSITORY</code>, <code>SUPABASE_URL</code>, <code>SUPABASE_PUBLISHABLE_KEY</code>, and <code>OLLAMA_BASE_URL</code> if Ollama is not at the gateway's default address.</span></li>
      <li className="flex gap-2"><span className="text-sky-200 font-semibold">3.</span><span><strong>Set the Gateway URL</strong> in Settings. Current value: <code className="break-all">{gatewayUrl || 'not configured'}</code>. Use <code>127.0.0.1</code> only when the gateway runs on the same phone. A gateway on another device needs a reachable address and HTTPS.</span></li>
      <li className="flex gap-2"><span className="text-sky-200 font-semibold">4.</span><span><strong>Pair once</strong> in Settings using the same <code>AXIOM_GATEWAY_TOKEN</code>. Android stores the pairing credential in Keystore and renews short-lived sessions. Browser mode requires a session token again after reload.</span></li>
      <li className="flex gap-2"><span className="text-sky-200 font-semibold">5.</span><span><strong>Enable the integration below</strong>, then ask for it in Chat. Tool writes and SQL execution require your approval before they run.</span></li>
    </ol>
    <div className="grid sm:grid-cols-2 gap-2 mt-4">
      <div className="rounded-xl bg-black/20 p-3">
        <div className="flex items-center gap-2 text-sm font-medium"><Github size={15}/> GitHub</div>
        <p className="text-[11px] text-slate-400 mt-2">Set <code>GITHUB_TOKEN</code> and <code>GITHUB_REPOSITORY=owner/repo</code> on the gateway. The Repository field in Settings must match. Axiom can read files and create or update files, with approval for writes.</p>
        <p className="text-[10px] text-slate-500 mt-2">Try in Chat: “Read README.md from my configured GitHub repository.”</p>
      </div>
      <div className="rounded-xl bg-black/20 p-3">
        <div className="flex items-center gap-2 text-sm font-medium"><Database size={15}/> Supabase</div>
        <p className="text-[11px] text-slate-400 mt-2">Set your project URL and publishable key on the gateway. Row access follows your project's grants and RLS policies. Never use a service-role or secret key here.</p>
        <p className="text-[10px] text-slate-500 mt-2">Try in Chat: “Read up to 10 rows from my public profiles table.”</p>
      </div>
    </div>
    <div className="mt-3 rounded-xl border border-amber-200/10 bg-amber-200/[.035] p-3 text-[11px] text-amber-100/80">
      <ShieldCheck size={13} className="inline mr-1"/> Supabase schema discovery and SQL tools need a project-owned <code>exec_sql</code> RPC. Do not expose an unrestricted SQL function to the public API. The normal row-reading tool does not need that RPC.
    </div>
    <button type="button" onClick={onOpenSettings} className="mt-3 w-full min-h-11 rounded-xl bg-sky-200/10 border border-sky-200/15 text-sky-100 text-sm font-medium flex items-center justify-center gap-2">Open connection settings <ArrowUpRight size={15}/></button>
  </section>;
}
