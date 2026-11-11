import React from 'react';
import { ArrowUpRight, BookOpen, Github, Database, ShieldCheck, KeyRound, TerminalSquare } from 'lucide-react';

export default function IntegrationGuide({ gatewayUrl, paired, onOpenSettings }) {
  return <section className="rounded-2xl border border-sky-300/15 bg-sky-300/[.035] p-4 mb-4">
    <div className="flex items-start gap-3">
      <div className="w-10 h-10 shrink-0 rounded-xl bg-sky-300/10 text-sky-200 grid place-items-center"><BookOpen size={19}/></div>
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold">Integration setup guide</h2>
        <p className="text-xs text-slate-400 mt-1">Each credential has a different job. Axiom's gateway keeps provider credentials on the machine running Node, not in the app.</p>
      </div>
      <span className={'text-[10px] rounded-full px-2 py-1 border '+(paired?'text-lime-300 border-lime-300/20':'text-amber-200 border-amber-200/20')}>{paired?'PAIRED':'NOT PAIRED'}</span>
    </div>
    <div className="mt-4 rounded-xl border border-lime-300/15 bg-lime-300/[.035] p-3">
      <div className="flex items-center gap-2 text-sm font-semibold"><KeyRound size={15}/> 1. Gateway pairing: generated automatically</div>
      <p className="text-xs text-slate-300 mt-2"><code>AXIOM_GATEWAY_TOKEN</code> is a private pairing password between Axiom and your gateway. It is not issued by GitHub or Supabase, and you no longer need to generate it yourself.</p>
      <p className="text-xs text-slate-300 mt-2">On first gateway startup, Axiom generates a cryptographically random 256-bit token, saves it in <code>~/.config/axiom/gateway-token</code> with owner-only permissions, and prints it once. Copy it at that moment. The gateway will not display it again on later starts.</p>
      <p className="text-[11px] text-slate-400 mt-2">Paste the one-time value into Android Settings → Secure gateway pairing. Android stores it encrypted with Keystore. Temporary session tokens are generated and renewed automatically. If you lose the pairing token, rotate it deliberately by replacing the private gateway token file and restarting the gateway, then pair again.</p>
    </div>
    <div className="mt-3 rounded-xl bg-black/20 p-3">
      <div className="flex items-center gap-2 text-sm font-semibold"><TerminalSquare size={15}/> 2. Gateway and Ollama address</div>
      <p className="text-xs text-slate-300 mt-2">Run <code>npm run gateway</code> from the <code>pwa</code> directory on the device that can reach Ollama and the internet. Default gateway URL: <code>http://127.0.0.1:8787</code>. Current app URL: <code className="break-all">{gatewayUrl || 'not configured'}</code>.</p>
      <p className="text-[11px] text-slate-400 mt-2">If Ollama runs in the same Termux environment, use <code>OLLAMA_BASE_URL=http://127.0.0.1:11434</code>. If Ollama runs on another machine, use its reachable URL instead. On Android, 127.0.0.1 means the phone itself, not your laptop.</p>
      <p className="text-[11px] text-slate-400 mt-2">A gateway on another device needs a trusted HTTPS address and the app origin in <code>AXIOM_ALLOWED_ORIGINS</code>. Do not expose the gateway directly to the public internet.</p>
    </div>
    <div className="mt-3 rounded-xl border border-white/[.08] bg-black/20 p-3">
      <div className="flex items-center gap-2 text-sm font-semibold"><TerminalSquare size={15}/> Android local model setup</div>
      <p className="text-xs text-slate-300 mt-2">Axiom can use a Termux-hosted Ollama runtime as a temporary bridge while native on-device inference is being built. Install Termux first, then follow the one-command bootstrap and pairing guide.</p>
      <a className="inline-flex mt-3 text-xs text-lime-200 underline underline-offset-4" href="https://github.com/michaelkage/Axiom/blob/main/pwa/TERMUX_SETUP.md" target="_blank" rel="noreferrer">Open Android Termux setup guide <ArrowUpRight size={13}/></a>
      <p className="text-[10px] text-amber-200/80 mt-2">The current Android Ollama package is a third-party archived community build. This is a stopgap, not Axiom's native inference engine.</p>
    </div>
    <div className="mt-3 rounded-xl bg-black/20 p-3">
      <div className="flex items-center gap-2 text-sm font-semibold"><Github size={15}/> 3. GitHub token: get this from GitHub</div>
      <ol className="list-decimal pl-4 mt-2 space-y-1 text-xs text-slate-300">
        <li>Open <a className="text-sky-200 underline" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">GitHub → Fine-grained personal access tokens</a>.</li>
        <li>Create a token restricted to only the repository Axiom should access, and set an expiry.</li>
        <li>Repository permissions: <strong>Contents: Read and write</strong> for file editing, plus Metadata read. Read-only use can use Contents: Read.</li>
        <li>Generate it and copy it immediately. GitHub will not show the full token again.</li>
        <li>Set it as <code>GITHUB_TOKEN</code> on the gateway machine. Never paste it into Axiom chat or commit it.</li>
      </ol>
      <p className="text-[11px] text-slate-300 mt-2">Set <code>GITHUB_REPOSITORY=owner/repo</code> to the exact repository. The Repository field in Axiom Settings must match. The gateway only permits content operations on that one repository.</p>
      <p className="text-[10px] text-slate-500 mt-2">Try in Chat: “Read README.md from my configured GitHub repository.” File writes require approval.</p>
    </div>
    <div className="mt-3 rounded-xl bg-black/20 p-3">
      <div className="flex items-center gap-2 text-sm font-semibold"><Database size={15}/> 4. Supabase URL and publishable key</div>
      <ol className="list-decimal pl-4 mt-2 space-y-1 text-xs text-slate-300">
        <li>Open <a className="text-sky-200 underline" href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">Supabase Dashboard</a> and select your project.</li>
        <li>Open the project's <strong>Connect</strong> dialog to copy the Project URL and publishable key, or go to <strong>Settings → API Keys</strong>.</li>
        <li>Set the URL as <code>SUPABASE_URL</code> and the <code>sb_publishable_...</code> key as <code>SUPABASE_PUBLISHABLE_KEY</code> on the gateway machine.</li>
      </ol>
      <p className="text-[11px] text-amber-200/85 mt-2">Use the publishable key (or legacy anon key for compatibility). Never use <code>sb_secret_...</code>, <code>service_role</code>, or another secret key. Publishable keys are low-privilege; table grants and Row Level Security still decide which rows can be accessed.</p>
      <p className="text-[10px] text-slate-500 mt-2">Try in Chat: “Read up to 10 rows from my public profiles table.” The table must be exposed through the Data API, granted access, and have an RLS policy that allows the operation.</p>
    </div>
    <div className="mt-3 rounded-xl bg-black/20 p-3">
      <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={15}/> 5. Optional MCP server tokens</div>
      <p className="text-xs text-slate-300 mt-2">If an MCP server requires a bearer token, put it in that server's <code>token</code> field inside <code>MCP_SERVERS_JSON</code> on the gateway machine. Axiom selects the configured server by ID; the app does not need the upstream token.</p>
      <p className="text-[11px] text-slate-400 mt-2">Supabase SQL/schema tools additionally need a project-owned, permission-controlled <code>exec_sql</code> RPC. Do not expose an unrestricted SQL function or use a service-role key.</p>
    </div>
    <div className="mt-3 rounded-xl border border-white/[.08] bg-black/20 p-3">
      <div className="text-sm font-semibold">Quick reference: where each value comes from</div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-x-3 gap-y-2 mt-3 text-[11px]">
        <span className="text-slate-400">AXIOM_GATEWAY_TOKEN</span><span>Generated once by the gateway at first startup</span>
        <span className="text-slate-400">GITHUB_TOKEN</span><span>GitHub fine-grained personal access token</span>
        <span className="text-slate-400">GITHUB_REPOSITORY</span><span>Type <code>owner/repo</code> yourself</span>
        <span className="text-slate-400">SUPABASE_URL</span><span>Supabase project Connect dialog</span>
        <span className="text-slate-400">SUPABASE_PUBLISHABLE_KEY</span><span>Supabase Connect dialog / API Keys</span>
        <span className="text-slate-400">MCP server token</span><span>Issued by that MCP provider</span>
      </div>
    </div>
    <button type="button" onClick={onOpenSettings} className="mt-3 w-full min-h-11 rounded-xl bg-sky-200/10 border border-sky-200/15 text-sky-100 text-sm font-medium flex items-center justify-center gap-2">Open connection settings <ArrowUpRight size={15}/></button>
  </section>;
}
