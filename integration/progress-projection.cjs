'use strict';
const {hash,sourceFiles,productIndex}=require('./ilbo-sync.cjs');
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k),copy=x=>JSON.parse(JSON.stringify(x));
const SOURCE_FIELDS=['id','worker','product','productId','plan','prod','planIntent','productionCompletion','productionPlanQty','scheduleConditions','machineActuals'];
function projectProgress(state,snapshot,previous,now=new Date().toISOString(),planning){
 if(!planning){require('./schedule-core.cjs');planning=require('./schedule-planning.cjs');}
 if(typeof planning.dailyProgress!=='function')throw Error('Matching planning runtime is required');
 const date=new Date(now);if(!Number.isFinite(+date))throw Error('Invalid projection timestamp');
 const asOf=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
 const raw=new Map();for(const file of sourceFiles(snapshot))for(const row of file.rows)raw.set(file.path+'\0'+row.id,{file,row});
 const linked=new Map(),rowsById=new Map();for(const [month,value]of Object.entries(state.months||{}))for(const row of value.rows||[]){if(!rowsById.has(row.id))rowsById.set(row.id,row);const si=row.sourceIntegration;if(row.deleted||si?.repo!==snapshot.repo)continue;const key=si.path+'\0'+si.id;if(!linked.has(key))linked.set(key,[]);linked.get(key).push({month,row});}
 const indexes=new Map(),entries=[],unsafeJobs=new Set(),unlinkedProducts=new Set(),ix=productIndex(state.products);
 for(const [key,source]of raw){if(linked.has(key)||source.row.off||source.file.date>asOf)continue;const r=source.row,products=new Set([ix.ids.get(r.productId),ix.byName(r.product)].filter(Boolean));for(const product of products)unlinkedProducts.add(String(r.worker||'').trim()+'\0'+product.id);}
 const progressFor=({month,row})=>{if(!indexes.has(month))indexes.set(month,planning.dailyProgress(state,month,{asOf}));return indexes.get(month).get(row.id)};
 const jobKey=(progress,month)=>progress?.originId||[month,progress?.jobId].join(':');
 const conditionJobs=new Map(),conditionSchedules=new Map();let allSchedules=null;
 const workerAt=(job,date)=>{try{return typeof planning.workerAt==='function'?planning.workerAt(job,date):job.worker}catch{return null}};
 function jobFor(link,progress){
  if(typeof planning.jobs!=='function'||!progress?.jobId||progress.warning)return null;
  const month=progress.progressMonth||link.month,m=state.months[month];if(!m)return null;
  if(!conditionJobs.has(month))conditionJobs.set(month,m.closed&&m.closeSnapshot?.schedule?.jobs||planning.jobs(state,month));
  const origin=progress.originId||progress.jobId,matches=conditionJobs.get(month).filter(j=>(j.originId||j.id)===origin&&workerAt(j,link.row.date)===link.row.worker&&ix.byName(j.product)?.id===ix.byName(link.row.product)?.id);
  return matches.length===1&&!matches[0].carryBlocked&&!matches[0].handoffBlocked?matches[0]:null;
 }
 function handoffFor(job){
  if(!job?.handoffs?.length)return null;
  // Only assignment evidence and its production rate are shared. Other-work notes and internal IDs stay private.
  let worker=job.worker,last='';const changes=[];
  for(const h of job.handoffs){if(typeof h.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(h.date)||h.date<=last||h.from!==worker||typeof h.to!=='string'||!h.to.trim()||h.to===worker)return null;const rate=typeof planning.dailyAt==='function'?planning.dailyAt(job,h.date):h.daily;changes.push({date:h.date,from:h.from,to:h.to,daily:Number.isFinite(rate)&&rate>0?rate:null});worker=h.to;last=h.date;}
  return{schema:1,originalWorker:job.worker,originalDaily:Number.isFinite(job.daily)&&job.daily>0?job.daily:null,changes};
 }
 function scheduleFor(link,progress){
  if(typeof planning.jobs!=='function'||!progress?.jobId||progress.warning)return null;
  const month=progress.progressMonth||link.month,m=state.months[month];if(!m||m.closed||m.closeSnapshot)return null;
  const origin=progress.originId||progress.jobId,j=jobFor(link,progress);if(!j)return null;
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
 // A changed or ambiguous source member invalidates the whole linked job's old total.
 for(const [key,links]of linked){const source=raw.get(key);if(links.length!==1||!source||links.some(x=>x.row.sourceIntegration.sourceHash!==hash(source.row)))for(const link of links){const p=progressFor(link);if(p?.jobId)unsafeJobs.add(jobKey(p,link.month));}}
 for(const [key,links]of linked){if(links.length!==1)continue;const source=raw.get(key),{month,row}=links[0];if(!source||row.sourceIntegration.sourceHash!==hash(source.row))continue;
  // Closed rows retain their original spelling. Compare the catalog identity so
  // a renamed product cannot reuse old totals while a new source row is held.
  let product;try{product=ix.resolve({productId:row.sourceIntegration.productId,product:row.product})}catch{continue}
  const progress=progressFor(links[0]),job=jobFor(links[0],progress),handoff=handoffFor(job),workers=handoff?[handoff.originalWorker,...handoff.changes.map(h=>h.to)]:[row.worker];if(!product||!progress||unsafeJobs.has(jobKey(progress,month))||workers.some(worker=>unlinkedProducts.has(String(worker||'').trim()+'\0'+product.id)))continue;
  const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
  const completionRow=progress.completionRowId&&rowsById.get(progress.completionRowId);
  entries.push({path:source.file.path,id:source.row.id,worker:row.worker,productId:row.sourceIntegration.productId||source.row.productId||null,product:row.product,jobId:progress.jobId||null,plan:number(progress.plan),produced:number(progress.produced),remaining:number(progress.remaining),unproduced:number(progress.unproduced),percent:number(progress.percent),complete:progress.complete===true,completedAt:progress.completedAt||null,reason:progress.reason||null,stockQty:number(progress.stockQty),note:completionRow?.productionCompletion?.note||'',warning:progress.warning||null,...(handoff?{handoff}:{}),source:Object.fromEntries(SOURCE_FIELDS.filter(k=>own(source.row,k)).map(k=>[k,copy(source.row[k])]))});
 }
 for(const entry of entries){const target=linked.get(entry.path+'\0'+entry.id)[0],progress=progressFor(target);entry.originId=progress.originId||progress.jobId||null;entry.progressMonth=progress.progressMonth||target.month;const schedule=scheduleFor(target,progress);if(schedule)entry.schedule=schedule;}
 entries.sort((a,b)=>(a.path+'\0'+a.id).localeCompare(b.path+'\0'+b.id));
 const revision=hash({asOf,entries});if(previous?.schema===1&&previous.kind==='schedule-production-progress'&&previous.revision===revision&&hash({asOf:previous.asOf,entries:previous.entries})===revision)return copy(previous);
 return{schema:1,kind:'schedule-production-progress',revision,updatedAt:date.toISOString(),asOf,entries};
}
module.exports={projectProgress,SOURCE_FIELDS};
