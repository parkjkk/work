'use strict';
const crypto=require('node:crypto');
const clone=x=>JSON.parse(JSON.stringify(x));
const own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
const stable=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const same=(a,b)=>stable(a??null)===stable(b??null);
const hash=x=>crypto.createHash('sha256').update(stable(x)).digest('hex');
const clean=x=>String(x??'').trim();
function iso(s){if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const d=new Date(s+'T00:00:00Z');return !Number.isNaN(+d)&&d.toISOString().slice(0,10)===s}
function number(x,label){if(x===''||x==null)return null;if(typeof x!=='number'&&typeof x!=='string'||!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(String(x).trim()))throw Error('Invalid numeric field: '+label);const n=Number(x);if(!Number.isFinite(n)||n<0)throw Error('Invalid nonnegative field: '+label);return n}
function productIndex(products){
 const ids=new Map(),names=new Map();
 const add=(name,p)=>{name=clean(name);if(!name)return;const prior=names.get(name);if(prior&&prior.id!==p.id)throw Error('Ambiguous product name or alias');names.set(name,p)};
 for(const p of products||[]){if(p.deleted)continue;if(!clean(p.id)||!clean(p.name)||ids.has(p.id))throw Error('Invalid or duplicate product ID');ids.set(p.id,p);add(p.name,p)}
 for(const p of ids.values()){if(p.aliases!=null&&!Array.isArray(p.aliases))throw Error('Invalid product aliases');for(const a of p.aliases||[])add(typeof a==='string'?a:a.name,p)}
 return{ids,names,resolve:r=>{if(r.productId){const p=ids.get(r.productId);if(!p)return null;const byName=names.get(clean(r.product));if(byName&&byName.id!==p.id)throw Error('Product ID and name disagree');return p}return names.get(clean(r.product))||null}};
}
function projectCatalog(products,prior,now=new Date().toISOString()){
 const ix=productIndex(products),list=[...ix.ids.values()].map(p=>({id:p.id,name:p.name,active:p.active!==false&&!p.disabled})).sort((a,b)=>a.id.localeCompare(b.id));
 const aliases=[...ix.names].filter(([name,p])=>name!==p.name).map(([name,p])=>({name,productId:p.id})).sort((a,b)=>a.name.localeCompare(b.name));
 const revision=hash({products:list,aliases});if(prior?.revision===revision&&same(prior.products,list)&&same(prior.aliases,aliases))return clone(prior);
 return{schema:1,kind:'schedule-product-catalog',revision,updatedAt:now,products:list,aliases};
}
function newMonth(id){return{id,rev:1,name:id,modern:true,closed:false,rows:[],issues:[],stocks:[],plans:[],jobs:[],history:[],auditSessions:[],operations:[],headerRows:[],plaster:[],auditStamp:'',openingSource:null}}
function rowBody(row){const x=clone(row);delete x.sourceIntegration;delete x.rev;return x}
function detailOf(r){const x={};for(const k of['defPart','gasa','cs','gap','inlet','face','bubble','b1','b2','remark','sourceProduct'])if(own(r,k))x[k]=r[k];return x}
function sourceFiles(snapshot){
 if(!snapshot||typeof snapshot.repo!=='string'||!snapshot.commit||!snapshot.files||snapshot.complete===false)throw Error('Complete source snapshot required');
 const out=[];
 for(const [path,file]of Object.entries(snapshot.files)){
  if(!path.startsWith('data/'))continue;
  const match=path.match(/^data\/(\d{4}-\d{2}-\d{2})\.json$/);if(!match)continue;
  if(!iso(match[1])||!file?.sha||!Array.isArray(file?.data?.rows)||file.complete===false)throw Error('Invalid or incomplete source day');
  const seen=new Set();for(const r of file.data.rows){if(!r||typeof r.id!=='string'||!r.id||seen.has(r.id))throw Error('Duplicate or missing source row ID');seen.add(r.id);if(!clean(r.worker))throw Error('Missing source worker');if(r.date&&r.date!==match[1])throw Error('Source date disagrees with filename')}
  out.push({path,date:match[1],sha:file.sha,rows:file.data.rows});
 }
 return out.sort((a,b)=>a.path.localeCompare(b.path));
}
function planSync(state,snapshot,options={}){
 const next=clone(state),ix=productIndex(next.products),files=sourceFiles(snapshot),now=options.now||snapshot.readAt||new Date().toISOString();
 const report={schema:1,kind:'ilbo-sync-report',policyVersion:'ilbo-sync-2',sourceRepo:snapshot.repo,sourceCommit:snapshot.commit,sourceFiles:Object.fromEntries(files.map(f=>[f.path,f.sha])),counts:{added:0,linked:0,updated:0,deleted:0,attendance:0,held:0},issues:[],qualityWarnings:[],updatedAt:now};
 const touched=new Set(),seenKeys=new Set(),days=new Set(files.map(f=>f.path)),claimed=new Set(),prepared=[];
 const targetDeleted=new Set();
 for(const m of Object.values(next.months))for(const event of m.history||[]){
  if(event.type==='ilbo-sync')continue;
  const beforeKey=event.before?.sourceIntegration?.key,afterKey=event.after?.sourceIntegration?.key;
  if(beforeKey&&event.after===null)targetDeleted.add(beforeKey);
  // An explicit user restoration with the same source link clears its tombstone.
  if(afterKey)targetDeleted.delete(afterKey);
 }
 const issue=(code,ctx,extra={})=>{report.issues.push({code,path:ctx.path,id:ctx.id||ctx.raw?.id,date:ctx.date||ctx.path?.match(/\d{4}-\d{2}-\d{2}/)?.[0]||'',worker:clean(ctx.raw?.worker||ctx.worker),sourceProduct:clean(ctx.raw?.sourceProduct||ctx.raw?.product||ctx.sourceProduct),...extra});report.counts.held++};
 const integrationKey=(path,id)=>snapshot.repo+'/'+path+'#'+id;
 const history=(month,type,before,after,ctx)=>{month.history=month.history||[];const event={type:'ilbo-sync',action:type,at:now,sourceRepo:snapshot.repo,sourcePath:ctx.path,sourceId:ctx.raw?.id||ctx.id,sourceCommit:snapshot.commit,before:before?clone(before):null,after:after?clone(after):null};event.id='ilbo-history:'+hash({type,before,after,path:ctx.path,id:event.sourceId});if(!month.history.some(e=>e.id===event.id))month.history.push(event);touched.add(month.id)};
 const locate=key=>Object.values(next.months).flatMap(m=>m.rows.map(row=>({m,row}))).filter(x=>x.row.sourceIntegration?.key===key);
 // Validate the full source before returning any changes.
 for(const f of files)for(const raw of f.rows){
  const ctx={...f,raw,id:raw.id,key:integrationKey(f.path,raw.id)},month=f.date.slice(0,7);seenKeys.add(ctx.key);
  if(raw.off){prepared.push({...ctx,month,attendance:true});continue}
  if(!clean(raw.product)&&!raw.productId){issue('missing-product',ctx);continue}
  let p;try{p=ix.resolve(raw)}catch{issue('product-id-name-conflict',ctx);continue}if(!p){issue('unknown-product',ctx);continue}
  const values={date:f.date,worker:clean(raw.worker),product:p.name};
  try{
   if(own(raw,'prod')){const n=number(raw.prod,'prod');if(n!==null)values.pours=n}
   if(own(raw,'plan'))values.plan=number(raw.plan,'plan');
   if(own(raw,'planIntent')){
    const valid=own(raw,'plan')&&(['continue','start','end'].includes(raw.planIntent))&&(raw.planIntent==='continue'?values.plan===null:raw.planIntent==='start'?values.plan>0:values.plan===0);
    if(!valid){issue('invalid-plan-intent',ctx);continue}values.fieldPlanIntent=raw.planIntent;
   }
   if(own(raw,'scrapKg'))values.fieldScrapKg=number(raw.scrapKg,'scrapKg');
   if(own(raw,'defQty'))values.fieldDefQty=number(raw.defQty,'defQty');
   const hours=number(raw.hours,'hours');if(hours!==null&&hours>24)throw Error('Hours exceed day');
   const details=detailOf(raw);if(Object.keys(details).length)values.fieldDetails=details;
   prepared.push({...ctx,month,p,values,hours,group:f.date+'\0'+values.worker});
  }catch{issue('invalid-source-number',ctx)}
 }
 // One working-time value per worker/day. Keep the existing first clock row when possible.
 const groups=new Map();for(const c of prepared.filter(c=>!c.attendance)){if(!groups.has(c.group))groups.set(c.group,[]);groups.get(c.group).push(c)}
 for(const cs of groups.values()){
  const hours=[...new Set(cs.map(c=>c.hours).filter(x=>x!==null))];if(hours.length>1){for(const c of cs)issue('inconsistent-worker-hours',c);continue}
  if(!hours.length)continue;
  const current=(next.months[cs[0].month]?.rows||[]).filter(r=>r.date===cs[0].date&&r.worker===cs[0].values.worker&&!r.deleted);
  const clock=current.find(r=>r.hours!==null&&r.hours!==''&&r.hours!==undefined)||current[0];
  const owner=cs.find(c=>clock&&(clock.sourceIntegration?.key===c.key||clock.product===c.p.name))||cs[0];
  for(const c of cs)c.values.hours=c===owner?hours[0]:null;
 }
 const sourceMatches=new Map();for(const c of prepared.filter(c=>!c.attendance)){const key=c.group+'\0'+c.p.id;sourceMatches.set(key,(sourceMatches.get(key)||0)+1)}
 for(const c of prepared){
  let m=next.months[c.month];if(m?.closed){issue('closed-month',c);continue}
  if(targetDeleted.has(c.key)&&!locate(c.key).length){issue('target-deleted',c);continue}
  const opposite=Object.values(next.months).flatMap(mm=>(mm[c.attendance?'rows':'fieldAttendance']||[])).find(r=>r.sourceIntegration?.key===c.key);
  if(opposite){issue('source-record-kind-changed',c);continue}
  if(!c.attendance&&!locate(c.key).length&&sourceMatches.get(c.group+'\0'+c.p.id)>1){issue('multiple-source-match',c);continue}
  if(!c.attendance&&!locate(c.key).length&&!own(c.values,'pours')){issue('missing-production-quantity',c);continue}
  if(!m){m=next.months[c.month]=newMonth(c.month);touched.add(c.month)}
  if(c.attendance){
   const rows=m.fieldAttendance||(m.fieldAttendance=[]),matches=rows.filter(r=>r.sourceIntegration?.key===c.key);if(matches.length>1){issue('duplicate-attendance-link',c);continue}
   const values={date:c.date,worker:clean(c.raw.worker),offKind:clean(c.raw.offKind)||'휴무',hours:number(c.raw.hours,'attendance-hours'),details:detailOf(c.raw)},prev=matches[0];
   const old=prev?clone(prev):null;if(prev&&same(values,prev.sourceIntegration.baseline))continue;
   if(prev&&Object.entries(prev.sourceIntegration.baseline).some(([k,v])=>!same(prev[k],v))){issue('attendance-conflict',c);continue}
   const row=prev||{id:'ilbo-attendance:'+hash(c.key).slice(0,24),rev:0};Object.assign(row,values);row.rev=(row.rev||0)+1;row.sourceIntegration={schema:1,key:c.key,repo:snapshot.repo,path:c.path,id:c.raw.id,sourceHash:hash(c.raw),baseline:clone(values)};row.sourceIntegration.targetHash=hash(rowBody(row));if(!prev)rows.push(row);history(m,prev?'attendance-update':'attendance-add',old,row,c);report.counts.attendance++;continue;
  }
  const matches=locate(c.key);if(matches.length>1){issue('duplicate-source-link',c);continue}
  let row=matches[0]?.row,initial=false;
  if(matches[0]&&matches[0].m.id!==m.id){issue('source-month-moved',c);continue}
  if(!row){
   const candidates=m.rows.filter(r=>!r.deleted&&r.date===c.date&&r.worker===c.values.worker&&ix.names.get(clean(r.product))?.id===c.p.id&&!r.sourceIntegration);
   if(candidates.length>1){issue('multiple-existing-rows',c);continue}
   row=candidates[0];initial=!!row;
   if(row&&claimed.has(row.id)){issue('multiple-source-match',c);continue}
   if(row&&!same(row.pours,c.values.pours)&&options.initialConflict!=='source'){issue('initial-quantity-conflict',c);continue}
  }
  if(row?.deleted){issue('target-deleted',c);continue}
  const before=row?clone(row):null;
  // A blank first field report must not hide a recorded legacy defect amount.
  if(before)for(const key of['fieldScrapKg','fieldDefQty'])if(c.values[key]===null&&!own(row,key)&&!own(row.sourceIntegration?.baseline||{},key))delete c.values[key];
  if(!row){
   if(!own(c.values,'pours')){issue('missing-production-quantity',c);continue}
   row={id:'ilbo:'+hash(c.key).slice(0,24),rev:0,date:c.date,worker:c.values.worker,product:c.p.name,lot:'',hours:null,plan:null,pours:null,cases:c.p.cases??null,waterRatio:c.p.waterRatio??null,plaster:c.p.kg??null,defectUnit:null,defectCount:null,defectPart:'',unitSources:{cases:'catalog',plaster:'catalog'},explicit:{day:true,worker:true,hours:own(c.values,'hours')&&c.values.hours!==null,pours:true,lot:false},source:'work.html'};
  }
  claimed.add(row.id);
  const baseline=row.sourceIntegration?.baseline,patch={},conflicts=[];
  for(const [key,value]of Object.entries(c.values)){
   if(baseline){
    if(own(baseline,key)&&same(value,baseline[key]))continue;
    if(same(row[key],value))continue;
    if(own(baseline,key)&&!same(row[key],baseline[key])){conflicts.push(key);continue}
    if(!own(baseline,key)&&row[key]!=null&&row[key]!==''&&!same(row[key],value)){conflicts.push(key);continue}
   }else if(initial&&options.initialConflict!=='source'&&!same(row[key],value)){conflicts.push(key);continue}
   patch[key]=value;
  }
  if(conflicts.length){issue(initial?'initial-field-conflict':'target-source-conflict',c,{fields:conflicts});continue}
  const nextBaseline={...(baseline||{}),...clone(c.values)};
  if(before?.sourceIntegration&&same(nextBaseline,baseline)&&same(patch,{})&&before.sourceIntegration.sourceHash===hash(c.raw))continue;
  Object.assign(row,patch);row.rev=(row.rev||0)+1;
  if(row.explicit&&own(patch,'hours'))row.explicit.hours=patch.hours!==null;
  const targetEdited=!!before?.sourceIntegration?.targetEdited||!!(before?.sourceIntegration&&before.sourceIntegration.targetHash!==hash(rowBody(before)));
  // The engine owns baseline. User edits must leave it intact for three-way merge.
  row.sourceIntegration={...(row.sourceIntegration||{}),schema:1,key:c.key,repo:snapshot.repo,path:c.path,id:c.raw.id,sourceHash:hash(c.raw),baseline:nextBaseline,sourceProduct:clean(c.raw.sourceProduct||c.raw.product),productId:c.p.id,sourceCreatedAt:c.raw.ts||null,sourceUpdatedAt:c.raw.t||null,...(targetEdited?{targetEdited:true}:{})};
  row.sourceIntegration.targetHash=hash(rowBody(row));
  if(!before){m.rows.push(row);report.counts.added++;history(m,'add',null,row,c)}else if(initial){report.counts.linked++;history(m,'initial-link',before,row,c)}else{report.counts.updated++;history(m,'update',before,row,c)}
 }
 // Absence is meaningful only inside a successfully read full day file.
 for(const m of Object.values(next.months))for(const field of['rows','fieldAttendance'])for(const row of[...(m[field]||[])]){
  const si=row.sourceIntegration;if(!si||si.repo!==snapshot.repo||seenKeys.has(si.key))continue;
  const c={path:si.path,id:si.id,date:row.date,worker:row.worker,sourceProduct:si.sourceProduct||row.product};if(!days.has(si.path)){issue('source-day-missing',c);continue}
  if(m.closed){issue('closed-month-deletion',c);continue}
  if(si.targetEdited||si.targetHash!==hash(rowBody(row))){issue('target-modified-before-source-deletion',c);continue}
  const before=clone(row);m[field].splice(m[field].indexOf(row),1);history(m,'source-delete',before,null,c);report.counts.deleted++;
 }
 for(const id of touched)next.months[id].rev=(next.months[id].rev||0)+1;
 // Data-quality discrepancies are informational: preserve both sources, amounts,
 // and manual calendars. They are not failed merges or held imports.
 const checkedDays=new Set();
 for(const m of Object.values(next.months))for(const attendance of m.fieldAttendance||[]){
  if(attendance.deleted||attendance.sourceIntegration?.repo!==snapshot.repo||(clean(attendance.offKind)||'휴무')!=='휴무')continue;
  const key=attendance.date+'\0'+attendance.worker;if(checkedDays.has(key))continue;checkedDays.add(key);
  const rows=m.rows.filter(r=>!r.deleted&&r.date===attendance.date&&r.worker===attendance.worker&&Number.isFinite(r.pours)&&r.pours>0);
  if(rows.length)report.qualityWarnings.push({code:'off-production-overlap',date:attendance.date,worker:attendance.worker,products:[...new Set(rows.map(r=>r.product))].sort(),rows:rows.length,pours:rows.reduce((n,r)=>n+r.pours,0),rowIds:rows.map(r=>r.id).sort(),message:'현장 휴무 기록과 같은 날의 생산실적이 함께 있습니다. 원본을 확인해 주세요.'});
 }
 report.qualityWarnings.sort((a,b)=>(a.date+'\0'+a.worker).localeCompare(b.date+'\0'+b.worker));
 report.issues.sort((a,b)=>stable(a).localeCompare(stable(b)));
 const previous=options.previousReport;
 report.status=report.issues.length?'review':'ok';report.revision=hash({policyVersion:report.policyVersion,sourceCommit:report.sourceCommit,sourceFiles:report.sourceFiles,issues:report.issues,qualityWarnings:report.qualityWarnings,months:[...touched].sort(),at:now});
 const finalReport=previous&&previous.policyVersion===report.policyVersion&&previous.sourceCommit===report.sourceCommit&&same(previous.sourceFiles,report.sourceFiles)&&same(previous.issues,report.issues)&&same(previous.qualityWarnings,report.qualityWarnings)&&touched.size===0?clone(previous):report;
 return{state:next,report:finalReport,changedMonths:[...touched].sort(),changed:!same(next,state)||!same(finalReport,previous)};
}
module.exports={planSync,projectCatalog,productIndex,sourceFiles,hash,stable,newMonth};
