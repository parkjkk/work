#!/usr/bin/env node
'use strict';
const cp=require('node:child_process'),path=require('node:path'),fs=require('node:fs');
const {run,inside}=require('./run-sync.cjs');
function git(dir,args,allowFailure=false){const r=cp.spawnSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});if(r.status&&!allowFailure)throw Error('Git operation failed');return{ok:r.status===0,text:(r.stdout||'').trim()}}
function refresh(dir){git(dir,['fetch','origin','main']);git(dir,['reset','--hard','origin/main'])}
function publish(dir,files,message){
 const present=files.filter(f=>fs.existsSync(path.join(dir,f))||git(dir,['ls-files','--',f],true).text);if(present.length)git(dir,['add','--',...present]);const changed=git(dir,['diff','--cached','--quiet'],true);if(changed.ok)return true;
 git(dir,['-c','user.name=production-sync[bot]','-c','user.email=production-sync@users.noreply.github.com','commit','-m',message]);
 return git(dir,['push','origin','HEAD:main'],true).ok;
}
async function main(){
 if(process.env.GITHUB_ACTIONS!=='true')throw Error('Workflow runner requires an ephemeral GitHub Actions checkout');
 const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1],target=path.resolve(get('--target')),source=path.resolve(get('--source'));
 const workspace=path.resolve(process.env.GITHUB_WORKSPACE||'');
 for(const dir of[target,source]){const rel=path.relative(workspace,dir);if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw Error('Checkout must be below runner workspace');inside(workspace,rel);inside(dir,'')}
 if(target===source)throw Error('Repositories must be separate');
 for(let attempt=1;attempt<=4;attempt++){
  refresh(target);refresh(source);
  const summary=run({target,source});
  if(publish(target,['months','meta/catalog.json','meta/ilbo-sync.json'],'Sync field production records')&&publish(source,['meta/products.json'],'Update production product catalog')){
   process.stdout.write(JSON.stringify({attempt,...summary})+'\n');return;
  }
  // A rejected push is never forced. Re-read both repositories and recompute.
  await new Promise(r=>setTimeout(r,attempt*1000));
 }
 throw Error('Concurrent updates could not be resolved');
}
if(require.main===module)main().catch(()=>{process.stderr.write('Synchronization did not finish. Retry the workflow after checking repository access and concurrent changes.\n');process.exitCode=1});
module.exports={publish};
