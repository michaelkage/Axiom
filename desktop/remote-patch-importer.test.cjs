"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const {execFileSync}=require("node:child_process");
const {applyRemoteWorkerPatch,canonicalRepositoryIdentity}=require("./remote-patch-importer.cjs");

async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"axiom-remote-patch-"));
  const data=path.join(root,"user-data");
  await fs.mkdir(data);
  const project=path.join(root,"project");
  await fs.mkdir(project);
  const git=(args,cwd=project)=>execFileSync("git",args,{cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
  git(["init"]);
  git(["config","user.name","Axiom Test"]);
  git(["config","user.email","axiom@example.invalid"]);
  await fs.writeFile(path.join(project,"README.md"),"base\n");
  git(["add","README.md"]);git(["commit","-m","base"]);
  git(["remote","add","origin","https://github.com/acme/project.git"]);
  return {root,data,project,git};
}
const patch="diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-base\n+updated from remote\n";
test("canonicalizes HTTPS and SSH remotes to the same repository identity",()=>{
  assert.equal(canonicalRepositoryIdentity("git@github.com:acme/project.git"),"github.com/acme/project");
  assert.equal(canonicalRepositoryIdentity("https://github.com/acme/project.git"),"github.com/acme/project");
  assert.equal(canonicalRepositoryIdentity("ssh://git@github.com/acme/project.git"),"github.com/acme/project");
});
test("applies a remote patch only into an isolated local review worktree",async t=>{
  const f=await fixture();t.after(()=>fs.rm(f.root,{recursive:true,force:true}));
  const result=await applyRemoteWorkerPatch({workspaceRoot:f.project,userDataPath:f.data,taskId:"task-1",repositoryUrl:"https://github.com/acme/project.git",patch});
  assert.notEqual(result.worktreePath,f.project);
  assert.equal(await fs.readFile(path.join(result.worktreePath,"README.md"),"utf8"),"updated from remote\n");
  assert.equal(await fs.readFile(path.join(f.project,"README.md"),"utf8"),"base\n");
});
test("refuses patches from a repository that does not match the open project",async t=>{
  const f=await fixture();t.after(()=>fs.rm(f.root,{recursive:true,force:true}));
  await assert.rejects(applyRemoteWorkerPatch({workspaceRoot:f.project,userDataPath:f.data,taskId:"task-2",repositoryUrl:"https://github.com/other/repository.git",patch}),/does not match/i);
});
test("rejects malformed, oversized and path-traversal patches without changing the project",async t=>{
  const f=await fixture();t.after(()=>fs.rm(f.root,{recursive:true,force:true}));
  await assert.rejects(applyRemoteWorkerPatch({workspaceRoot:f.project,userDataPath:f.data,taskId:"task-3",repositoryUrl:"https://github.com/acme/project.git",patch:"not a diff"}),/Git file-change headers/i);
  const traversal="diff --git a/../../outside.txt b/../../outside.txt\n--- a/../../outside.txt\n+++ b/../../outside.txt\n@@ -0,0 +1 @@\n+escape\n";
  await assert.rejects(applyRemoteWorkerPatch({workspaceRoot:f.project,userDataPath:f.data,taskId:"task-4",repositoryUrl:"https://github.com/acme/project.git",patch:traversal}));
  await assert.rejects(fs.access(path.join(f.root,"outside.txt")));
  await assert.rejects(applyRemoteWorkerPatch({workspaceRoot:f.project,userDataPath:f.data,taskId:"task-5",repositoryUrl:"https://github.com/acme/project.git",patch:"diff --git a/x b/x\n"+"x".repeat(8*1024*1024)}),/8 MiB/i);
});
