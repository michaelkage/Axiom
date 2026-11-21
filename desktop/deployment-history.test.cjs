"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const {createDeploymentHistoryStore,MAX_PER_PROJECT}=require("./deployment-history.cjs");

test("persists project-scoped deployment history without credentials",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"axiom-deploy-history-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=createDeploymentHistoryStore(root);
  const deployment=await store.append("/workspace/one",{
    provider:"vercel",previewUrl:"https://axiom.vercel.app",status:"deployed",
    verification:{verified:true,status:200},durationMs:1234,token:"must-not-persist",
  });
  assert.equal(deployment.verification.verified,true);
  assert.equal((await store.list("/workspace/one")).length,1);
  assert.equal((await store.list("/workspace/two")).length,0);
  const stored=await fs.readFile(path.join(root,"deployment-history.json"),"utf8");
  assert.ok(!stored.includes("must-not-persist"));
  assert.ok(!stored.includes("token"));
});

test("retains only the latest twenty previews per project",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"axiom-deploy-history-limit-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=createDeploymentHistoryStore(root);
  for(let i=0;i<MAX_PER_PROJECT+3;i++) {
    await store.append("/workspace/project",{
      provider:"netlify",previewUrl:"https://deploy-"+i+".netlify.app",status:"deployed_unverified",
      verification:{verified:false,status:503},durationMs:i,
    });
  }
  const records=await store.list("/workspace/project");
  assert.equal(records.length,MAX_PER_PROJECT);
  assert.equal(records[0].previewUrl,"https://deploy-22.netlify.app");
});

test("rejects non-HTTPS and unsupported deployment providers",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"axiom-deploy-history-invalid-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=createDeploymentHistoryStore(root);
  await assert.rejects(store.append("/workspace/project",{provider:"vercel",previewUrl:"http://insecure.example"}),/HTTPS/i);
  await assert.rejects(store.append("/workspace/project",{provider:"unknown",previewUrl:"https://example.com"}),/deployment result/i);
});
