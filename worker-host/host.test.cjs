"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {createWorkerHost}=require("./host.cjs");
async function fixture(opts={}){const dataDirectory=await fs.mkdtemp(path.join(os.tmpdir(),"axiom-worker-host-"));const token="test-token-with-at-least-thirty-two-characters";const host=createWorkerHost({token,dataDirectory,maxConcurrent:opts.maxConcurrent,provisionWorkspace:async j=>({workspacePath:path.join(dataDirectory,"ws-"+j.id)}),runWorker:opts.runWorker || (async (_j,_w,emit) => {emit("worker started");return {summary:"completed",exitCode:0};})});const address=await host.start({port:0});const base="http://127.0.0.1:"+address.port;const request=(route,options={})=>fetch(base+route,{...options,headers:{authorization:"Bearer "+token,...(options.headers||{})}});return {host,dataDirectory,request,base};}
const payload=(extra={})=>({idempotencyKey:"request-unique-1",taskId:"task-1",title:"Implement endpoint",prompt:"Implement endpoint",repositoryUrl:"https://github.com/acme/project.git",branch:"main",...extra});
test("requires a strong bearer token",()=>assert.throws(()=>createWorkerHost({token:"short"}),/at least 32/));
test("authenticates requests and exposes protocol health",async t=>{const f=await fixture();t.after(()=>f.host.stop());const denied=await fetch(f.base+"/v1/health");assert.equal(denied.status,401);const r=await f.request("/v1/health");assert.equal(r.status,200);assert.deepEqual(await r.json(),{status:"ok",protocol:1});});
test("validates jobs, executes once, and supports idempotent submission",async t=>{const f=await fixture();t.after(()=>f.host.stop());const post=()=>f.request("/v1/jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload())});const first=await post();assert.equal(first.status,202);const j=await first.json();for(let i=0;i<50&&!["succeeded","failed"].includes(f.host.getJob(j.id)?.status);i++)await new Promise(r=>setTimeout(r,10));assert.equal(f.host.getJob(j.id).status,"succeeded");const again=await post();assert.equal(again.status,200);assert.equal((await again.json()).id,j.id);});
test("rejects invalid branches and oversized request bodies",async t=>{const f=await fixture();t.after(()=>f.host.stop());const invalid=await f.request("/v1/jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload({branch:"../main"}))});assert.equal(invalid.status,400);const huge=await f.request("/v1/jobs",{method:"POST",headers:{"content-type":"application/json"},body:"x".repeat(1024*1024+8)});assert.equal(huge.status,413);});
test("cancellation is terminal only after runner termination",async t=>{let started;const ready=new Promise(r=>started=r);const f=await fixture({runWorker:async(_j,_w,_emit,signal)=>new Promise((resolve,reject)=>{started();signal.addEventListener("abort",()=>setTimeout(()=>reject(Object.assign(Error("terminated"),{name:"AbortError"})),20),{once:true});})});t.after(()=>f.host.stop());const r=await f.request("/v1/jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload())});const j=await r.json();await ready;const c=await f.request("/v1/jobs/"+j.id+"/cancel",{method:"POST"});assert.equal(c.status,202);assert.equal(f.host.getJob(j.id).status,"running");for(let i=0;i<50&&f.host.getJob(j.id).status!=="cancelled";i++)await new Promise(r=>setTimeout(r,10));assert.equal(f.host.getJob(j.id).status,"cancelled");});
test("restores completed jobs without re-executing them",async t=>{const f=await fixture();t.after(()=>f.host.stop());const r=await f.request("/v1/jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload())});const j=await r.json();for(let i=0;i<50&&f.host.getJob(j.id).status!=="succeeded";i++)await new Promise(r=>setTimeout(r,10));await f.host.stop();const restored=createWorkerHost({token:"test-token-with-at-least-thirty-two-characters",dataDirectory:f.dataDirectory,runWorker:async()=>{throw Error("must not run");}});await restored.restore();assert.equal(restored.getJob(j.id).status,"succeeded");await restored.stop();});

test("does not persist prompts and marks active jobs interrupted after restart",async t=>{let started;const ready=new Promise(r=>started=r);const f=await fixture({runWorker:async()=>new Promise(()=>{started();})});t.after(()=>f.host.stop());const r=await f.request("/v1/jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload({prompt:"private task prompt that must not be persisted"}))});const j=await r.json();await ready;const persisted=await fs.readFile(path.join(f.dataDirectory,"jobs.json"),"utf8");assert.equal(persisted.includes("private task prompt"),false);await f.host.stop();const restarted=createWorkerHost({token:"test-token-with-at-least-thirty-two-characters",dataDirectory:f.dataDirectory,runWorker:async()=>{throw Error("must never auto-retry");}});await restarted.restore();assert.equal(restarted.getJob(j.id).status,"interrupted");assert.match(restarted.getJob(j.id).error,/never retried|No retry/i);await restarted.stop();});
test("redacts common API tokens from retained worker logs",async t=>{const f=await fixture({runWorker:async(_j,_w,emit)=>{emit("Authorization: Bearer abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz123456");return {summary:"done",exitCode:0};}});t.after(()=>f.host.stop());const r=await f.request("/v1/jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload())});const j=await r.json();for(let i=0;i<50&&f.host.getJob(j.id).status!=="succeeded";i++)await new Promise(r=>setTimeout(r,10));const serialized=JSON.stringify(f.host.getJob(j.id).logs);assert.equal(serialized.includes("abcdefghijklmnop"),false);assert.equal(serialized.includes("ghp_"),false);});

test("resolves the remote workspace token before invoking OpenCode",async t=>{let observed;const f=await fixture({runWorker:async(j,workspace)=>{observed={prompt:j.prompt,workspace};return {summary:"done",exitCode:0};}});t.after(()=>f.host.stop());const r=await f.request("/v1/jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload({prompt:"Work in __AXIOM_WORKSPACE_ROOT__"}))});const j=await r.json();for(let i=0;i<50&&f.host.getJob(j.id).status!=="succeeded";i++)await new Promise(r=>setTimeout(r,10));assert.equal(observed.prompt,"Work in "+observed.workspace);});
test("bounds concurrent remote worker processes",async t=>{let active=0,maxActive=0;const f=await fixture({maxConcurrent:1,runWorker:async()=>{active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,30));active--;return {summary:"done",exitCode:0};}});t.after(()=>f.host.stop());const submit=extra=>f.request("/v1/jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload(extra))});const a=await submit();const b=await submit({idempotencyKey:"request-unique-2",taskId:"task-2"});const ja=await a.json(),jb=await b.json();for(let i=0;i<100&&(!["succeeded","failed"].includes(f.host.getJob(ja.id).status)||!["succeeded","failed"].includes(f.host.getJob(jb.id).status));i++)await new Promise(r=>setTimeout(r,10));assert.equal(f.host.getJob(ja.id).status,"succeeded");assert.equal(f.host.getJob(jb.id).status,"succeeded");assert.equal(maxActive,1);});


test("returns a bounded binary-capable patch for remote worker changes",async t=>{
  const dataDirectory=await fs.mkdtemp(path.join(os.tmpdir(),"axiom-worker-patch-"));
  const workspace=path.join(dataDirectory,"workspace");
  await fs.mkdir(workspace,{recursive:true});
  const exec=async(args)=>require("node:child_process").execFileSync("git",args,{cwd:workspace,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
  exec(["init"]);
  exec(["config","user.email","axiom@example.invalid"]);
  exec(["config","user.name","Axiom Test"]);
  await fs.writeFile(path.join(workspace,"README.md"),"base\\n");
  exec(["add","README.md"]);exec(["commit","-m","base"]);
  const token="test-token-with-at-least-thirty-two-characters";
  const host=createWorkerHost({
    token,dataDirectory,workspaceDirectory:path.join(dataDirectory,"workspaces"),
    provisionWorkspace:async()=>({workspacePath:workspace}),
    runWorker:async()=>{await fs.writeFile(path.join(workspace,"feature.js"),"export const feature = true;\\n");execFileSync("git",["add","feature.js"],{cwd:workspace});execFileSync("git",["commit","-m","worker feature"],{cwd:workspace});return {summary:"added feature",exitCode:0};},
  });
  const address=await host.start({port:0});
  t.after(async()=>{await host.stop();await fs.rm(dataDirectory,{recursive:true,force:true});});
  const base="http://127.0.0.1:"+address.port;
  const headers={authorization:"Bearer "+token,"content-type":"application/json"};
  const submitted=await fetch(base+"/v1/jobs",{method:"POST",headers,body:JSON.stringify(payload())});
  const job=await submitted.json();
  for(let i=0;i<100&&!host.getJob(job.id)?.patchAvailable&&!host.getJob(job.id)?.patchError;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(host.getJob(job.id).status,"succeeded");
  assert.equal(host.getJob(job.id).patchAvailable,true);
  const response=await fetch(base+"/v1/jobs/"+job.id+"/patch",{headers});
  assert.equal(response.status,200);
  const result=await response.json();
  assert.match(result.patch,/feature\.js/);
  assert.match(result.patch,/export const feature = true/);
  assert.ok(result.bytes>0&&result.bytes<=8*1024*1024);
});

test("blocks remote patch transfer when secret-like files are changed",async t=>{
  const dataDirectory=await fs.mkdtemp(path.join(os.tmpdir(),"axiom-worker-secret-patch-"));
  const workspace=path.join(dataDirectory,"workspace");
  await fs.mkdir(workspace,{recursive:true});
  const exec=async(args)=>require("node:child_process").execFileSync("git",args,{cwd:workspace,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
  exec(["init"]);exec(["config","user.email","axiom@example.invalid"]);exec(["config","user.name","Axiom Test"]);
  await fs.writeFile(path.join(workspace,"README.md"),"base\\n");exec(["add","README.md"]);exec(["commit","-m","base"]);
  const token="test-token-with-at-least-thirty-two-characters";
  const host=createWorkerHost({
    token,dataDirectory,workspaceDirectory:path.join(dataDirectory,"workspaces"),
    provisionWorkspace:async()=>({workspacePath:workspace}),
    runWorker:async()=>{await fs.writeFile(path.join(workspace,".env"),"API_KEY=do-not-transfer\\n");return {summary:"created environment file",exitCode:0};},
  });
  const address=await host.start({port:0});
  t.after(async()=>{await host.stop();await fs.rm(dataDirectory,{recursive:true,force:true});});
  const base="http://127.0.0.1:"+address.port;
  const headers={authorization:"Bearer "+token,"content-type":"application/json"};
  const submitted=await fetch(base+"/v1/jobs",{method:"POST",headers,body:JSON.stringify(payload())});
  const job=await submitted.json();
  for(let i=0;i<100&&!host.getJob(job.id)?.patchError;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(host.getJob(job.id).status,"succeeded");
  assert.equal(host.getJob(job.id).patchAvailable,false);
  assert.match(host.getJob(job.id).patchError,/secret-like files/i);
  const response=await fetch(base+"/v1/jobs/"+job.id+"/patch",{headers});
  assert.equal(response.status,409);
});


test("lists durable remote jobs without returning stored prompts",async t=>{
  const f=await fixture();
  t.after(()=>f.host.stop());
  const submitted=await f.request("/v1/jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload({prompt:"private job prompt"}))});
  const job=await submitted.json();
  for(let i=0;i<50&&f.host.getJob(job.id)?.status!=="succeeded";i++)await new Promise(r=>setTimeout(r,10));
  const response=await f.request("/v1/jobs");
  assert.equal(response.status,200);
  const result=await response.json();
  const listed=result.jobs.find(item=>item.id===job.id);
  assert.ok(listed);
  assert.equal("prompt" in listed,false);
  assert.ok(listed.logs.length<=5);
});
