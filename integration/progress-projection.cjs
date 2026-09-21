'use strict';
const {hash,sourceFiles,productIndex}=require('./ilbo-sync.cjs');
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k),copy=x=>JSON.parse(JSON.stringify(x));
const SOURCE_FIELDS=['id','worker','product','productId','plan','prod','planIntent','productionCompletion','productionPlanQty','scheduleConditions','machineActuals','scheduleTarget'];
function projectProgress(state,snapshot,previous,now=new Date().toISOString(),planning){
 if(!planning){require('./schedule-core.cjs');planning=require('./schedule-planning.cjs');}
 if(typeof planning.dailyProgress!=='function')throw Error('Matching planning runtime is required');
 const date=new Date(now);if(!Number.isFinite(+date))throw Error('Invalid projection timestamp');
 const asOf=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
 const raw=new Map();for(const file of sourceFiles(snapshot))for(const row of file.rows)raw.set(file.path+'\0'+row.id,{file,row});
 const linked=new Map(),rowsById=new Map();for(const [month,value]of Object.entries(state.months||{}))for(const row of value.rows||[]){if(!rowsById.has(row.id))rowsById.set(row.id,row);const si=row.sourceIntegration;if(row.deleted||si?.repo!==snapshot.repo)continue;const key=si.path+'\0'+si.id;if(!linked.has(key))linked.set(key,[]);linked.get(key).push({month,row});}
 const indexes=new Map(),entries=[],targets=[],unsafeJobs=new Set(),unlinkedProducts=new Set(),ix=productIndex(state.products);
 const progressFor=({month,row})=>{if(!indexes.has(month))indexes.set(month,planning.dailyProgress(state,month,{asOf}));return indexes.get(month).get(row.id)};
 const jobKey=(progress,month)=>progress?.originId||[month,progress?.jobId].join(':');
 const conditionJobs=new Map(),conditionSchedules=new Map(),planningContext={jobs:new Map()};let allSchedules=null;
 const workerAt=(job,date)=>{try{return typeof planning.workerAt==='function'?planning.workerAt(job,date):job.worker}catch{return null}};
 const jobsFor=month=>{if(!conditionJobs.has(month)){const m=state.months[month];conditionJobs.set(month,m?.closed&&m.closeSnapshot?.schedule?.jobs||(typeof planning.jobs==='function'?planning.jobs(state,month,planningContext):[]))}return conditionJobs.get(month)};
 const canonicalRow=row=>{const product=ix.resolve(row);return product?{...row,product:product.name,productId:product.id}:row};
 const recordMatches=(job,row)=>{try{return typeof planning.recordMatchesJob==='function'?planning.recordMatchesJob(job,canonicalRow(row),state):!row.scheduleTarget&&workerAt(job,row.date)===row.worker&&ix.byName(job.product)?.id===ix.byName(row.product)?.id}catch{return false}};
 const targetFor=(month,job)=>{try{return typeof planning.targetForJob==='function'?planning.targetForJob(state,month,job):null}catch{return null}};
 const identityFor=job=>[job.originId||job.id,job.worker,ix.byName(job.product)?.id].join('\0');
 const jobChains=new Map(),latestJobs=new Map();
 const participantsFor=job=>[...new Set((jobChains.get(identityFor(job))||[{job}]).flatMap(({job:j})=>[j.worker,...(j.handoffs||[]).flatMap(h=>[h.from,h.to]),...(j.records||[]).map(row=>row.worker)]).filter(value=>typeof value==='string'&&value.trim()))].sort();
 if(typeof planning.targetForJob==='function')for(const month of Object.keys(state.months||{}).filter(month=>month<=asOf.slice(0,7)).sort()){
  const groups=new Map();for(const job of jobsFor(month)){const product=ix.byName(job.product),identity=[job.originId||job.id,job.worker,product?.id].join('\0');if(!groups.has(identity))groups.set(identity,[]);groups.get(identity).push(job)}
  for(const [identity,jobs]of groups){latestJobs.set(identity,{month,job:jobs.length===1?jobs[0]:null});if(jobs.length===1&&!jobs[0].carryBlocked&&!jobs[0].handoffBlocked){if(!jobChains.has(identity))jobChains.set(identity,[]);jobChains.get(identity).push({month,job:jobs[0]})}}
 }
 function holdSourceTarget(source){
  if(!source?.row?.scheduleTarget||source.row.off||source.file.date>asOf)return;
  let target,row;try{target=require('./schedule-core.cjs').scheduleTargetValue(source.row.scheduleTarget);row=canonicalRow({...source.row,date:source.file.date})}catch{return}
  if(!state.months[target.month]||jobsFor(target.month).filter(job=>hash(targetFor(target.month,job))===hash(target)).length!==1)return;
  for(const {month,job}of latestJobs.values())if(job&&typeof planning.scheduleTargetMatches==='function'&&planning.scheduleTargetMatches(job,row,state))unsafeJobs.add(jobKey({originId:job.originId||job.id,jobId:job.id},month));
 }
 for(const [key,source]of raw){if(linked.has(key)||source.row.off||source.file.date>asOf)continue;const r=source.row;if(r.scheduleTarget){holdSourceTarget(source);continue}const products=new Set([ix.ids.get(r.productId),ix.byName(r.product)].filter(Boolean));for(const product of products)unlinkedProducts.add(String(r.worker||'').trim()+'\0'+product.id);}
 function jobFor(link,progress){
  if(typeof planning.jobs!=='function'||!progress?.jobId||progress.warning)return null;
  const month=progress.progressMonth||link.month,m=state.months[month];if(!m)return null;
  const origin=progress.originId||progress.jobId,source=link.row.scheduleTarget&&month!==link.month?jobsFor(link.month).filter(j=>(j.originId||j.id)===origin&&recordMatches(j,link.row)&&!j.carryBlocked&&!j.handoffBlocked):null;
  const matches=jobsFor(month).filter(j=>(j.originId||j.id)===origin&&(source?source.length===1&&j.carried&&identityFor(j)===identityFor(source[0]):recordMatches(j,link.row)));
  return matches.length===1&&!matches[0].carryBlocked&&!matches[0].handoffBlocked?matches[0]:null;
 }
 function handoffFor(job){
  if(!job?.handoffs?.length)return null;
  // Only assignment evidence and its production rate are shared. Other-work notes and internal IDs stay private.
  let worker=job.worker,last='';const changes=[];
  for(const h of job.handoffs){if(typeof h.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(h.date)||h.date<=last||h.from!==worker||typeof h.to!=='string'||!h.to.trim()||h.to===worker)return null;const rate=typeof planning.dailyAt==='function'?planning.dailyAt(job,h.date):h.daily;changes.push({date:h.date,from:h.from,to:h.to,daily:Number.isFinite(rate)&&rate>0?rate:null});worker=h.to;last=h.date;}
  return{schema:1,originalWorker:job.worker,originalDaily:Number.isFinite(job.daily)&&job.daily>0?job.daily:null,changes};
 }
 function scheduleForJob(month,j){
  const m=state.months[month];if(!m||m.closed||m.closeSnapshot||!j)return null;
  const origin=j.originId||j.id;
  const machines=(j.machines||[]).map(m=>({name:m.name,qty:Number.isFinite(m.qty)&&m.qty>=0?m.qty:null,...(Number.isFinite(m.daily)&&m.daily>0?{daily:m.daily}:{})}));
  if(machines.length>50||machines.some(m=>typeof m.name!=='string'||!m.name.trim()||m.name.length>60))return null;
  const daily=typeof planning.dailyAt==='function'?planning.dailyAt(j,asOf):j.daily;
  const conditions={schema:1,machines,daily:Number.isFinite(daily)&&daily>0?daily:null};
  if(j.routing)try{conditions.routing=planning.normalizeRouting(j.routing)}catch{return null}
  if(!conditions.machines.length&&!conditions.daily&&!conditions.routing)return null;
  if(!conditionSchedules.has(month)){if(typeof planning.scheduleAll==='function')allSchedules??=planning.scheduleAll(state,asOf);const result=allSchedules?.[month]||(typeof planning.schedule==='function'?planning.schedule(state,month,asOf):{rows:[]});conditionSchedules.set(month,result.rows)}
  if(conditionSchedules.get(month).some(r=>r.jobId===j.id&&r.reservationBlocked))return null;
  const periods=conditionSchedules.get(month).filter(r=>r.jobId===j.id&&!r.actualOnly&&!r.reservationOnly&&r.start&&r.end),start=periods.map(r=>r.start).sort()[0]||j.firstActual||j.previousStart||j.start||null,end=periods.map(r=>r.end).sort().at(-1)||j.end||null;
  if(typeof start!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(start)||!Number.isFinite(Date.parse(start+'T00:00:00Z'))||new Date(start+'T00:00:00Z').toISOString().slice(0,10)!==start)return null;
  const handoff=handoffFor(j),value={schema:1,jobId:j.id,originId:origin,month,start,end,plan:Number.isFinite(j.totalPlan)?j.totalPlan:null,conditions,...(handoff?{assignmentRevision:hash(handoff)}:{})};
  return{...value,revision:hash(value)};
 }
 function scheduleFor(link,progress){if(!progress?.jobId||progress.warning)return null;return scheduleForJob(progress.progressMonth||link.month,jobFor(link,progress))}
 // A changed or ambiguous source member invalidates the whole linked job's old total.
 for(const [key,links]of linked){const source=raw.get(key);if(links.length!==1||!source||links.some(x=>x.row.sourceIntegration.sourceHash!==hash(source.row))){holdSourceTarget(source);for(const link of links){const p=progressFor(link);if(p?.jobId)unsafeJobs.add(jobKey(p,link.month));}}}
 for(const [key,links]of linked){if(links.length!==1)continue;const source=raw.get(key),{month,row}=links[0];if(!source||row.sourceIntegration.sourceHash!==hash(source.row))continue;
  // Closed rows retain their original spelling. Compare the catalog identity so
  // a renamed product cannot reuse old totals while a new source row is held.
  let product;try{product=ix.resolve({productId:row.sourceIntegration.productId,product:row.product})}catch{continue}
  const progress=progressFor(links[0]),job=jobFor(links[0],progress),handoff=handoffFor(job),workers=handoff?[handoff.originalWorker,...handoff.changes.map(h=>h.to)]:[job?.worker||row.worker];if(!product||!progress||unsafeJobs.has(jobKey(progress,month))||workers.some(worker=>unlinkedProducts.has(String(worker||'').trim()+'\0'+product.id)))continue;
  const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
  const completionRow=progress.completionRowId&&rowsById.get(progress.completionRowId);
  entries.push({path:source.file.path,id:source.row.id,worker:row.worker,productId:row.sourceIntegration.productId||source.row.productId||null,product:row.product,jobId:progress.jobId||null,plan:number(progress.plan),produced:number(progress.produced),remaining:number(progress.remaining),unproduced:number(progress.unproduced),percent:number(progress.percent),complete:progress.complete===true,completedAt:progress.completedAt||null,reason:progress.reason||null,stockQty:number(progress.stockQty),note:completionRow?.productionCompletion?.note||'',warning:progress.warning||null,...(handoff?{handoff}:{}),source:Object.fromEntries(SOURCE_FIELDS.filter(k=>own(source.row,k)).map(k=>[k,copy(source.row[k])]))});
 }
 for(const entry of entries){const link=linked.get(entry.path+'\0'+entry.id)[0],progress=progressFor(link);entry.originId=progress.originId||progress.jobId||null;entry.progressMonth=progress.progressMonth||link.month;const job=jobFor(link,progress),target=job&&targetFor(entry.progressMonth,job);if(target){entry.scheduleTarget=target;entry.scheduleWorker=workerAt(job,link.row.date);entry.participants=participantsFor(job)}const schedule=scheduleFor(link,progress);if(schedule)entry.schedule=schedule;}
 // Publish one shared catalog for both apps. A manual routing group is exposed
 // as a whole while one of its members is active, so the field app can show
 // the current parallel work and its next sequential item without importing
 // the future item early. Running legacy jobs remain available as before.
 const targetCandidates=[];
 for(const {month,job}of latestJobs.values()){
  const m=state.months[month];if(!job||m.closed||m.closeSnapshot||job.carryBlocked||job.handoffBlocked)continue;
  const target=targetFor(month,job),product=ix.byName(job.product);if(!target||!product||unsafeJobs.has(jobKey({originId:job.originId||job.id,jobId:job.id},month)))continue;
  const handoff=handoffFor(job),owners=handoff?[handoff.originalWorker,...handoff.changes.map(h=>h.to)]:[job.worker];if(owners.some(worker=>unlinkedProducts.has(String(worker||'').trim()+'\0'+product.id)))continue;
  const records=(job.records||[]).filter(row=>row.date<=asOf),progress=records.map(row=>progressFor({month:row.date.slice(0,7),row})).find(value=>value?.jobId&&(value.originId||value.jobId)===(job.originId||job.id));
  if(progress?.warning)continue;
  const start=typeof planning.productionStartDate==='function'?planning.productionStartDate(job):job.previousStart||job.firstActual||job.start,produced=progress?.produced??job.previousProduced??0,plan=progress?.plan??job.totalPlan;
  const hasActual=records.some(row=>Number.isFinite(row.pours)&&row.pours>0)||Number.isFinite(job.previousProduced)&&job.previousProduced>0;
  const schedule=scheduleForJob(month,job),route=schedule?.conditions?.routing,routeKey=route?.group?month+'\0'+job.worker+'\0'+route.group:null;
  if(!Number.isFinite(produced)||!Number.isFinite(plan)||plan<=0||!hasActual&&!job.manual||hasActual&&!(typeof start==='string'&&start<=asOf))continue;
  const scheduleActive=!!schedule&&schedule.start<=asOf&&(!schedule.end||asOf<=schedule.end),complete=progress?.complete===true||!progress&&job.complete===true;
  targetCandidates.push({month,job,target,product,progress,handoff,start,produced,plan,hasActual,schedule,routeKey,scheduleActive,complete});
 }
 const activeRouteKeys=new Set(targetCandidates.filter(candidate=>candidate.routeKey&&candidate.scheduleActive&&!candidate.complete).map(candidate=>candidate.routeKey));
 for(const candidate of targetCandidates){
  const {job,target,product,handoff,start,produced,plan,hasActual,schedule,routeKey,scheduleActive,complete}=candidate;
  if(!(hasActual&&!complete||job.manual&&(scheduleActive&&!complete||routeKey&&activeRouteKeys.has(routeKey))))continue;
  const activeFrom=schedule?.start||start;if(typeof activeFrom!=='string'||activeFrom>asOf&&!routeKey)continue;
  const value={target,worker:workerAt(job,asOf),product:product.name,start:schedule?.start||start,end:schedule?.end||null,activeFrom,plan,produced,schedule,participants:participantsFor(job),...(handoff?{handoff}:{})};targets.push({...value,revision:hash(value)});
 }
 entries.sort((a,b)=>(a.path+'\0'+a.id).localeCompare(b.path+'\0'+b.id));
 targets.sort((a,b)=>[a.target.originId,a.target.month,a.target.jobId].join('\0').localeCompare([b.target.originId,b.target.month,b.target.jobId].join('\0')));
 const receipts=[];for(const [key,links]of linked){const source=raw.get(key);if(links.length!==1||!source||links[0].row.sourceIntegration.sourceHash!==hash(source.row))continue;receipts.push({path:source.file.path,id:source.row.id,source:Object.fromEntries([...SOURCE_FIELDS,'hours','productionTeam','t','ts'].filter(k=>own(source.row,k)).map(k=>[k,copy(source.row[k])]))});}receipts.sort((a,b)=>(a.path+'#'+a.id).localeCompare(b.path+'#'+b.id));
 const history=[];for(const {file,row}of raw.values()){if(row.off||file.date>asOf||!(Number(row.prod)>0)||!Number.isFinite(Number(row.prod)))continue;let product,team;try{product=ix.resolve(row);team=require('./schedule-core.cjs').productionTeamValue(row.productionTeam,String(row.worker||'').trim())}catch{continue}if(!product||!row.worker)continue;const hours=v=>v!==''&&v!=null&&Number.isFinite(Number(v))&&Number(v)>=0&&Number(v)<=24?Number(v):null;history.push({date:file.date,id:row.id,productId:product.id,product:product.name,qty:Number(row.prod),people:[{worker:String(row.worker).trim(),hours:hours(row.hours)},...(team?.members||[]).map(m=>({worker:m.worker,hours:hours(m.hours)}))]})}history.sort((a,b)=>(a.date+'#'+a.id).localeCompare(b.date+'#'+b.id));
 const hourGroups=new Map();for(const {file,row}of raw.values()){if(file.date>asOf||!row.worker||row.off&&row.offKind!=='케이스 교체')continue;let team;try{team=require('./schedule-core.cjs').productionTeamValue(row.productionTeam,row.worker)}catch{team=null}for(const person of [{worker:row.worker,hours:row.hours},...(team?.members||[])]){if(person.hours==null||person.hours===''||!Number.isFinite(Number(person.hours))||Number(person.hours)<0||Number(person.hours)>24)continue;const key=file.date+'#'+person.worker;if(!hourGroups.has(key))hourGroups.set(key,{date:file.date,worker:person.worker,values:new Set()});hourGroups.get(key).values.add(Number(person.hours))}}
 const hoursHistory=[...hourGroups.values()].filter(r=>r.values.size===1).map(r=>({date:r.date,worker:r.worker,hours:[...r.values][0]})).sort((a,b)=>(a.date+'#'+a.worker).localeCompare(b.date+'#'+b.worker));
 const revision=hash({asOf,entries,targets,receipts,history,hoursHistory});if(previous?.schema===1&&previous.kind==='schedule-production-progress'&&previous.revision===revision&&hash({asOf:previous.asOf,entries:previous.entries,targets:previous.targets,receipts:previous.receipts,history:previous.history,hoursHistory:previous.hoursHistory})===revision)return copy(previous);
 return{schema:1,kind:'schedule-production-progress',revision,updatedAt:date.toISOString(),asOf,entries,targets,receipts,history,hoursHistory};
}
module.exports={projectProgress,SOURCE_FIELDS};
