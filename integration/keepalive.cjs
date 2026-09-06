'use strict';
// Public repository maintenance only; no business data or credentials are read.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
function git(root,args){const r=cp.spawnSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});if(r.status)throw Error('Repository maintenance failed');return r.stdout.trim()}
try{
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REPOSITORY!=='parkjkk/work')throw Error('Wrong execution scope');
 const args=process.argv.slice(2),root=path.resolve(args[args.indexOf('--repo')+1]),workspace=path.resolve(process.env.GITHUB_WORKSPACE||'');
 if(root!==path.join(workspace,'app')||fs.lstatSync(root).isSymbolicLink())throw Error('Wrong checkout path');
 git(root,['fetch','origin','main']);git(root,['reset','--hard','origin/main']);
 const file=path.join(root,'.automation-checkpoint.json');
 if(fs.existsSync(file)&&(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()))throw Error('Wrong checkpoint file');
 const month=new Date().toISOString().slice(0,7),previous=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
 if(previous?.month!==month){
  fs.writeFileSync(file,JSON.stringify({schema:1,month,purpose:'Monthly repository automation maintenance'})+'\n');
  git(root,['add','--','.automation-checkpoint.json']);
  git(root,['-c','user.name=production-sync[bot]','-c','user.email=production-sync@users.noreply.github.com','commit','-m','Maintain monthly automation checkpoint']);
  git(root,['push','origin','HEAD:main']);
 }
 process.stdout.write('Monthly automation checkpoint is current.\n');
}catch{process.stderr.write('Monthly automation maintenance did not finish.\n');process.exitCode=1}
