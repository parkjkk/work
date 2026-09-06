#!/usr/bin/env node
'use strict';
// Runs only trusted code from schedule-data. The field repository is JSON input.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {planSync,projectCatalog,stable}=require('./ilbo-sync.cjs');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const git=(dir,...args)=>cp.execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function inside(root,relative){
 const base=path.resolve(root),p=path.resolve(base,relative),rel=path.relative(base,p);if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('Path outside repository');
 const rootStat=fs.lstatSync(base);if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw Error('Repository root must be a real directory');
 const actualRoot=fs.realpathSync(base);let current=base;
 for(const part of rel.split(path.sep).filter(Boolean)){
  current=path.join(current,part);let stat;try{stat=fs.lstatSync(current)}catch(e){if(e.code==='ENOENT')continue;throw e}
  if(stat.isSymbolicLink())throw Error('Symbolic links are not allowed in repository data paths');
  if(!stat.isDirectory()&&!stat.isFile())throw Error('Data path must be a regular file or directory');
  const real=fs.realpathSync(current),boundary=path.relative(actualRoot,real);if(boundary.startsWith('..')||path.isAbsolute(boundary))throw Error('Resolved path outside repository');
 }
 return p;
}
function write(root,relative,data){
 const p=inside(root,relative),body=JSON.stringify(data,null,2)+'\n';if(fs.existsSync(p)&&stable(read(p))===stable(data))return false;
 fs.mkdirSync(path.dirname(p),{recursive:true});inside(root,relative);
 // Exclusive regular temporary file + rename prevents following existing hard links.
 const tempRelative=path.relative(path.resolve(root),path.join(path.dirname(p),'.sync-'+crypto.randomBytes(12).toString('hex')+'.tmp')),temp=inside(root,tempRelative);let fd;
 try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,body,'utf8');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;inside(root,relative);fs.renameSync(temp,p)}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp)}
 return true;
}
function verifyProjectionMode(dir){
 const entries=git(dir,'ls-tree','-r','-z','HEAD','--','meta').split('\0').filter(Boolean);
 for(const entry of entries){const m=entry.match(/^(\d+) (\w+) [0-9a-f]+\t(.+)$/);if(!m)throw Error('Invalid source tree');if(m[3]==='meta'||m[3]==='meta/products.json'&&(m[1]!=='100644'||m[2]!=='blob'))throw Error('Source catalog projection must be a regular tracked file')}
}
function nativeState(dir){
 const envelope=read(inside(dir,'meta/catalog.json'));if(envelope.schema!==1||!Array.isArray(envelope.records))throw Error('Invalid catalog envelope');
 const meta=envelope.records.find(r=>r.id==='catalog'&&r.kind==='catalog');if(meta?.app!=='johyeong-schedule'||meta.schema!==1||!Array.isArray(meta.months))throw Error('Invalid schedule catalog');
 if(meta.catalogUnitSync)throw Error('Catalog unit update is pending');
 const state={products:envelope.records.filter(r=>r.kind==='products'&&!r.deleted),months:{}};
 for(const key of meta.months){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(key))throw Error('Invalid month key');const x=read(inside(dir,'months/'+key+'.json'));if(x.schema!==1||x.records?.length!==1||x.records[0].kind!=='month'||x.records[0].id!==key)throw Error('Invalid month envelope');const m=x.records[0];for(const k of['rows','issues','stocks','plans','plaster'])if(!Array.isArray(m[k]))throw Error('Missing month collection');state.months[key]=m}
 return{state,envelope,meta};
}
function sourceSnapshot(dir,repo='parkjkk/ilbo-data'){
 // Read tracked files at a single checked-out commit, never source executable files.
 inside(dir,'meta/products.json');inside(dir,'data');verifyProjectionMode(dir);
 const commit=git(dir,'rev-parse','HEAD'),files={};
 const lines=git(dir,'ls-tree','-r','-z','HEAD','--','data').split('\0').filter(Boolean);
 for(const line of lines){const match=line.match(/^100644 blob ([0-9a-f]+)\t(data\/\d{4}-\d{2}-\d{2}\.json)$/);if(!match){if(/\tdata(?:\/\d{4}-\d{2}-\d{2}\.json)?$/.test(line))throw Error('Source day is not a regular JSON file');continue}inside(dir,match[2]);const data=JSON.parse(git(dir,'show','HEAD:'+match[2]));files[match[2]]={sha:match[1],data}}
 return{repo,branch:'main',commit,complete:true,readAt:new Date().toISOString(),files};
}
function run({target,source,initialConflict='review',snapshotFile,dryRun=false}){
 const targetRoot=inside(target,''),sourceRoot=inside(source,'');if(targetRoot===sourceRoot||!path.relative(targetRoot,sourceRoot).startsWith('..')||!path.relative(sourceRoot,targetRoot).startsWith('..'))throw Error('Repositories must be disjoint');
 const loaded=nativeState(target),snapshot=snapshotFile?read(snapshotFile):sourceSnapshot(source),reportPath=inside(target,'meta/ilbo-sync.json'),previousReport=fs.existsSync(reportPath)?read(reportPath):undefined;
 // Source priority is a one-time migration option; subsequent calls always merge.
 if(initialConflict==='source'&&previousReport)throw Error('Initial source-priority migration has already run');
 if(!['source','review'].includes(initialConflict))throw Error('Invalid initial conflict policy');
 const result=planSync(loaded.state,snapshot,{initialConflict,previousReport});
 const catalog=loaded.envelope,meta=catalog.records.find(r=>r.id==='catalog');meta.months=Object.keys(result.state.months).sort();
 const priorProjectionPath=inside(source,'meta/products.json'),priorProjection=fs.existsSync(priorProjectionPath)?read(priorProjectionPath):undefined;
 const projection=projectCatalog(result.state.products,priorProjection,snapshot.readAt);
 const writes=[];
 if(!dryRun){
  for(const id of result.changedMonths)if(write(target,'months/'+id+'.json',{schema:1,records:[{...result.state.months[id],kind:'month',policyVersion:'web-ledger-2'}]}))writes.push('months/'+id+'.json');
  if(stable(meta.months)!==stable(loaded.state.months&&Object.keys(loaded.state.months).sort()))meta.rev=(meta.rev||0)+1;
  if(write(target,'meta/catalog.json',catalog))writes.push('meta/catalog.json');
  if(write(target,'meta/ilbo-sync.json',result.report))writes.push('meta/ilbo-sync.json');
  if(write(source,'meta/products.json',projection))writes.push('source:meta/products.json');
 }
 return{counts:result.report.counts,status:result.report.status,changedMonths:result.changedMonths.length,filesWritten:writes.length,dryRun};
}
if(require.main===module){
 try{const args=process.argv.slice(2),get=k=>{const i=args.indexOf(k);return i<0?undefined:args[i+1]};const target=get('--target'),source=get('--source');if(!target||!source)throw Error('Required --target and --source');const summary=run({target:path.resolve(target),source:path.resolve(source),snapshotFile:get('--snapshot'),initialConflict:get('--initial-conflict')||'review',dryRun:args.includes('--dry-run')});process.stdout.write(JSON.stringify(summary)+'\n')}catch{process.stderr.write('Synchronization stopped: invalid input or repository state. Existing remote data was not overwritten.\n');process.exitCode=1}
}
module.exports={run,nativeState,sourceSnapshot,inside,verifyProjectionMode};
