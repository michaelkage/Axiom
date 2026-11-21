"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {validateRemoteWorkerConfig,createRemoteWorkerHostClient}=require("./remote-worker-host-client.cjs");
const valid={hostUrl:"https://worker.example.com",repositoryUrl:"https://github.com/acme/project.git",branch:"main",token:"worker-host-token-with-at-least-32-characters"};
test("validates secure host, repository, branch and bearer token settings",()=>{
  assert.deepEqual(validateRemoteWorkerConfig(valid),{hostUrl:"https://worker.example.com",repositoryUrl:valid.repositoryUrl,branch:"main",token:valid.token});
  assert.equal(validateRemoteWorkerConfig({...valid,hostUrl:"http://localhost:20129"}).hostUrl,"http://localhost:20129");
});
test("rejects insecure remote hosts and credential-bearing repository URLs",()=>{
  assert.throws(()=>validateRemoteWorkerConfig({...valid,hostUrl:"http://worker.example.com"}),/HTTPS/i);
  assert.throws(()=>validateRemoteWorkerConfig({...valid,repositoryUrl:"https://user:pass@github.com/acme/project.git"}),/credentials/i);
  assert.throws(()=>validateRemoteWorkerConfig({...valid,token:"short"}),/32–4096/);
  assert.throws(()=>validateRemoteWorkerConfig({...valid,branch:"../main"}),/branch/i);
});
test("uses bearer auth for job lifecycle and patch retrieval without exposing the token",async()=>{
  const calls=[];
  const client=createRemoteWorkerHostClient({
    getConfig:async()=>({hostUrl:"https://worker.example.com"}),
    getToken:async()=>valid.token,
    fetch:async(url,options)=>{calls.push({url:String(url),options});return {ok:true,status:200,json:async()=>({id:"job-1",status:"succeeded",patch:"diff",bytes:4})};},
  });
  await client.submit({taskId:"task-1"});
  await client.get("job-1");
  await client.getPatch("job-1");
  await client.cancel("job-1");
  assert.equal(calls.length,4);
  assert.ok(calls.every(call=>call.options.headers.authorization==="Bearer "+valid.token));
  assert.equal(calls[2].url,"https://worker.example.com/v1/jobs/job-1/patch");
  assert.ok(!JSON.stringify(calls.map(call=>call.options.body)).includes(valid.token));
});
