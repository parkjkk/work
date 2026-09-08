(function(root){'use strict';const C=root.ScheduleCore,clone=C.clone;
const add=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)};
const days=(a,b)=>{const out=[];if(!C.iso(a)||!C.iso(b)||a>b)return out;for(let d=a;d<=b&&out.length<1100;d=add(d,1))out.push(d);return out};
const startPlan=r=>r.plan>0?r.plan:r.plan===0&&r.productionPlanQty>0?r.productionPlanQty:null;
const completion=r=>{try{return C.completionValue(r.productionCompletion)}catch{return null}};
const endsProduction=r=>r.plan===0||!!completion(r);
const named=(s,r)=>({...r,product:C.catalogName(s,r.product)});
function parseInput(text,k,workers=[]){let year=+k.slice(0,4),month=+k.slice(5),match=/(?:([0-9]{1,2})월\s*)?([0-9]{1,2})일/.exec(text),start=null;if(match){const mo=match[1]?+match[1]:month;if(mo-month>=9)year--;if(month===12&&mo===1)year++;start=C.date(year,mo,+match[2])}const daily=Number(/([0-9]+(?:\.[0-9]+)?)\s*조/.exec(text)?.[1])||null,worker=[...workers].sort((a,b)=>b.length-a.length).find(w=>text.includes(w))||'',group=/\((\d+)\)/.exec(text)?.[1]||'',machines=[...text.matchAll(/(\d+)\s*호(?:\s*\[\s*([0-9]+(?:\.[0-9]+)?)\s*\])?/g)].map(m=>({name:m[1]+'호',qty:C.num(m[2])}));return{start,daily,worker,group,machines,legacyInput:text}}
function sourceContinuationLinks(s,m,stored){
 const links=new Map(),original=new Map(),date=v=>C.iso(v)?v:C.serial(C.num(v)),machine=v=>/^(\d+)호(?:기)?$/.exec(String(v||'').trim())?.[1]||'';
 for(const e of m.history||[])if(e.type==='ilbo-sync'&&e.action==='initial-link'&&e.before&&e.after?.sourceIntegration?.key&&e.before.plan==null&&e.before.sourceRow!=null)original.set(e.before.id,{row:e.before,key:e.after.sourceIntegration.key});
 for(const r of m.rows){const saved=original.get(r.id),si=r.sourceIntegration;if(!(startPlan(r)>0)||r.fieldPlanIntent==='start'||r.jobId||!saved||saved.key!==si?.key||r.plan!==si.baseline?.plan||saved.row.date!==r.date||saved.row.worker!==r.worker||C.catalogName(s,saved.row.product)!==r.product||saved.row.sourceRow!==r.sourceRow)continue;
  const candidates=stored.filter(j=>!j.manual&&j.sourceRowId&&j.sourceRowId!==r.id&&j.worker===r.worker&&j.product===r.product&&j.daily>0&&j.machines?.length&&m.rows.some(a=>a.id===j.sourceRowId&&!a.deleted&&a.date<=r.date)).filter(j=>{
   const anchor=m.rows.find(x=>x.id===j.sourceRowId),anchorIndex=m.rows.indexOf(anchor),rowIndex=m.rows.indexOf(r);if(m.rows.some((x,i)=>!x.deleted&&x.worker===r.worker&&x.product===r.product&&endsProduction(x)&&(!x.jobId||x.jobId===j.id)&&(x.date>anchor.date||x.date===anchor.date&&i>=anchorIndex)&&(x.date<r.date||x.date===r.date&&i<rowIndex)))return false;
   const start=j.previousStart||j.start,names=j.machines.map(x=>machine(x.name));if(!C.iso(start)||names.some(n=>!n))return false;
   const periods=(s.scheduleRows||[]).filter(x=>{const c=x.cells||[];return c[0]===j.worker&&C.catalogName(s,c[4])===j.product&&date(c[7])===start&&C.iso(date(c[8]))&&r.date>=start&&r.date<=date(c[8])});
   return names.every(n=>periods.filter(x=>machine(x.cells[1])===n).length===1);
  });
  if(candidates.length===1)links.set(r.id,{jobId:candidates[0].id,sourceRowId:candidates[0].sourceRowId,date:r.date,rowId:r.id,sourcePlan:startPlan(r),originalPlan:candidates[0].plan,message:'현장 계획값은 원장에 보존하고, 원본 Excel에서 계속 작업으로 확인된 기존 배치와 계획을 적용합니다.'});
 }
 return links;
}
function jobs(s,k){const source=s.months[k],m={...source,rows:(source.rows||[]).map(r=>named(s,r)),plans:(source.plans||[]).map(r=>named(s,r)),jobs:(source.jobs||[]).map(r=>named(s,r))};if(m.closed&&m.plans?.length){return(m.jobs||[]).map(j=>{const p=m.plans.find(p=>p.source===j.source),current=p?.produced??0,previous=j.carried?(p?.previousProduced||0):0,total=(p?.plan||j.plan||0)+previous;return{...j,records:[],currentProduced:current,produced:current+previous,totalPlan:total,remaining:Math.max(0,total-current-previous),complete:current+previous>=total,archived:true}})}if(m.modern===false)return[];
 const stored=m.jobs||[],continuations=sourceContinuationLinks(s,m,stored),out=[],starts=m.rows.filter(r=>!r.deleted&&startPlan(r)>0&&!r.jobId&&!C.catalogIdentity(s,r.product).includes('부속')&&!continuations.has(r.id)),occ={};
 for(const r of starts){const index=occ[r.product]||0;occ[r.product]=index+1;const cfg=stored.find(j=>j.sourceRowId===r.id)||{},legacy=r.sourceIntegration&&!cfg.sourceRowId?null:m.plans.filter(p=>p.product===r.product)[index],parsed=parseInput(legacy?.input||'',k,s.workers);out.push({id:'job:'+r.id,originId:'job:'+r.id,sourceRowId:r.id,product:r.product,worker:r.worker,start:r.date,previousProduced:legacy?.previousProduced||0,previousPlan:legacy?.previousPlan||0,...parsed,...cfg,plan:startPlan(r),start:cfg.start||parsed.start||r.date,worker:cfg.worker||parsed.worker||r.worker})}
 for(const j of stored){if(!j.sourceRowId)out.push({...j,originId:j.originId||j.id});else if(!out.some(x=>x.sourceRowId===j.sourceRowId)&&m.rows.some(r=>r.id===j.sourceRowId&&!r.deleted))out.push({...j,originId:j.originId||j.id})}
 // Dates order backfilled web rows; physical row order breaks ties on the same date.
 // The original ledger order and its IDs are never rewritten.
 const ordered=m.rows.map((row,index)=>({row,index})).filter(x=>!x.row.deleted).sort((a,b)=>(a.row.date||'').localeCompare(b.row.date||'')||a.index-b.index).map(x=>x.row);
 for(const j of out){
  const startIndex=j.sourceRowId?ordered.findIndex(r=>r.id===j.sourceRowId):-1;let endIndex=ordered.length,nextStart=false;
  if(startIndex>=0)for(let i=startIndex;i<ordered.length;i++){const r=ordered[i];if(r.product!==j.product||r.worker!==j.worker||r.jobId&&r.jobId!==j.id)continue;if(i>startIndex&&startPlan(r)>0&&!r.jobId&&continuations.get(r.id)?.sourceRowId!==j.sourceRowId){endIndex=i;nextStart=true;break}if(endsProduction(r)){endIndex=i+1;break}}
  let records=ordered.filter((r,i)=>r.jobId===j.id&&i<endIndex||(!r.jobId&&r.product===j.product&&r.worker===j.worker&&(startIndex>=0?i>=startIndex&&i<endIndex:j.sourceStart!=null?r.sourceRow>=j.sourceStart&&r.sourceRow<(j.sourceEnd||1000):!out.some(x=>x.sourceRowId&&x.product===j.product&&x.worker===j.worker)&&(!j.start||r.date>=j.start))));
  if(startIndex<0&&!j.sourceRowId&&j.sourceStart==null){const siblings=out.filter(x=>!x.sourceRowId&&x.product===j.product&&x.worker===j.worker&&x.start<=j.start);if(siblings.length>1)records=records.filter(r=>r.jobId===j.id)}
  const terminalIndex=records.findIndex(endsProduction);if(terminalIndex>=0)records=records.slice(0,terminalIndex+1);const terminal=terminalIndex>=0?records.at(-1):null,ended=completion(terminal||{});
  j.records=records;j.fieldPlanNotes=[...continuations.values()].filter(x=>x.sourceRowId===j.sourceRowId);j.originId||=j.id;j.currentProduced=C.sum(records,r=>r.pours);j.produced=(j.carried?(j.previousProduced||0):0)+j.currentProduced;j.totalPlan=j.carried?(j.previousProduced||0)+(j.plan||0):(j.plan||0);j.stopped=!!j.stoppedAt||nextStart&&j.produced>0;j.interruptedAt=j.stopped?(j.stoppedAt||ordered[endIndex]?.date||null):null;j.ended=!!terminal;j.unproduced=Math.max(0,j.totalPlan-j.produced);j.remaining=j.stopped||j.ended?0:j.unproduced;j.complete=j.stopped||j.ended||j.totalPlan>0&&j.remaining===0;j.firstActual=records.filter(r=>r.pours>0).map(r=>r.date).sort()[0]||null;j.lastActual=records.filter(r=>r.pours>0||endsProduction(r)).map(r=>r.date).sort().at(-1)||null;j.completedAt=j.stopped?null:j.complete?(terminal?.date||j.lastActual):null;j.completionRowId=terminal?.id||null;j.completionReason=ended?.reason||(terminal?'legacy-end':j.stopped?'stopped':j.complete?'target-reached':null);j.completionStockQty=ended?.stockQty??null;j.completionNote=ended?.note||'';j.lot=[...new Set(records.map(r=>r.lot).filter(Boolean))].join(', ');j.machines??=[];j.group=String(j.group||'');delete j.carrySignature
 }
 return out;
}
function dailyProgress(s,k,options={}){
 const month=s.months?.[k];if(!month)throw Error('생산 월을 찾을 수 없습니다.');
 const selected=Array.isArray(options.rows)&&!month.closed?options.rows:month.rows||[],invalidRows=new Set(),normalized=selected.map(r=>{const row={...r};for(const field of['plan','pours','productionPlanQty']){if(r[field]!=null&&String(r[field]).trim()!==''&&(C.num(r[field])==null||C.num(r[field])<0))invalidRows.add(r.id);if(Object.prototype.hasOwnProperty.call(r,field))row[field]=C.num(r[field])}try{C.completionValue(r.productionCompletion)}catch{invalidRows.add(r.id)}return row}),working={...s,months:{...s.months,[k]:{...month,rows:normalized}}},cutoff=C.iso(options.asOf)?options.asOf:asOf(working,k),result=new Map(),all=[],owners=new Map();
 for(const [key,m]of Object.entries(working.months).sort(([a],[b])=>a.localeCompare(b))){
  const values=m.closed&&m.closeSnapshot?.schedule?.jobs?m.closeSnapshot.schedule.jobs.map(j=>named(working,clone(j))):jobs(working,key);
  const inferred=m.closed&&values.some(j=>!j.records?.length)?jobs({...working,months:{...working.months,[key]:{...m,closed:false}}},key):[];
  for(const j of values){const matches=inferred.filter(x=>x.id===j.id||j.sourceRowId&&x.sourceRowId===j.sourceRowId),frozenAggregate=!!m.closed&&!j.records?.length,rowLinks=j.records?.length?j.records:matches.length===1?matches[0].records:[],entry={key,job:j,rowLinks,frozenAggregate};all.push(entry);if(key===k)for(const r of rowLinks){if(!owners.has(r.id))owners.set(r.id,[]);owners.get(r.id).push(entry)}}
 }
 const calculations=new Map();
 function progress(entry){
  const j=entry.job,origin=j.originId||j.id,chainKey=origin+'\0'+j.worker+'\0'+j.product;if(calculations.has(chainKey))return calculations.get(chainKey);
  const chain=all.filter(e=>(e.job.originId||e.job.id)===origin&&e.job.worker===j.worker&&e.job.product===j.product&&e.key<=cutoff.slice(0,7)&&(!month.closed||e.key<=k)).sort((a,b)=>a.key.localeCompare(b.key));
  // Only explicit origin IDs connect months. No product/date-only carry inference.
  const latest=chain.at(-1)?.job||j,records=[],seen=new Set(),archiveIds=new Set();let produced=chain[0]?.job.carried?(chain[0].job.previousProduced||0):0,ambiguous=false,archiveUncertain=false;
  for(const e of chain){const dated=(e.rowLinks||[]).filter(r=>!r.deleted&&C.iso(r.date)&&r.date<=cutoff);if(e.frozenAggregate){const last=(e.rowLinks||[]).map(r=>r.date).filter(C.iso).sort().at(-1),saved=C.num(e.job.currentProduced);if(saved==null||e.key===cutoff.slice(0,7)&&(!last||cutoff<last))archiveUncertain=true;else produced+=saved;for(const r of dated)archiveIds.add(r.id)}for(const r of dated){if(seen.has(r.id)){ambiguous=true;continue}seen.add(r.id);records.push(r)}}
  records.sort((a,b)=>a.date.localeCompare(b.date));const terminal=records.find(endsProduction),terminalIndex=terminal?records.indexOf(terminal):-1,applicable=terminalIndex>=0?records.slice(0,terminalIndex+1):records;produced+=C.sum(applicable.filter(r=>!archiveIds.has(r.id)),r=>r.pours);
  const plan=latest.totalPlan>0?latest.totalPlan:null,unproduced=plan==null?null:Math.max(0,plan-produced),ended=terminal&&completion(terminal),stopped=!!latest.stoppedAt&&latest.stoppedAt<=cutoff||!!latest.interruptedAt&&latest.interruptedAt<=cutoff,complete=!!terminal||!stopped&&plan!=null&&produced>=plan;
  const completedAt=complete?(terminal?.date||applicable.filter(r=>r.pours>0).at(-1)?.date||latest.completedAt||null):null;
  const value={jobId:j.id,originId:origin,plan,produced,remaining:complete||stopped?0:unproduced,unproduced,percent:plan>0?produced/plan*100:null,complete,completedAt,completionRowId:terminal?.id||null,reason:ended?.reason||(terminal?'legacy-end':stopped?'stopped':complete?'target-reached':null),stockQty:ended?.stockQty??null,note:ended?.note||'',asOf:cutoff,progressMonth:chain.at(-1)?.key||entry.key,lastRecordAt:applicable.filter(r=>C.num(r.pours)!=null||endsProduction(r)).at(-1)?.date||null,lastRecordRowId:applicable.filter(r=>C.num(r.pours)!=null||endsProduction(r)).at(-1)?.id||null,lastRecordMonth:applicable.filter(r=>C.num(r.pours)!=null||endsProduction(r)).at(-1)?.date?.slice(0,7)||null,warning:ambiguous?'같은 실적이 여러 이월 작업에 연결되어 중복을 제외했습니다.':plan==null?'작업 계획수량을 확인해 주세요.':records.length>applicable.length?'완료 뒤의 실적은 이 작업 누적에 포함하지 않았습니다. 새 작업 연결을 확인해 주세요.':''};
  if(archiveUncertain||applicable.some(r=>invalidRows.has(r.id)))Object.assign(value,{produced:null,remaining:null,unproduced:null,percent:null,complete:false,warning:archiveUncertain?'마감된 작업의 해당 기준일까지 누적을 확인할 자료가 부족합니다.':'이 작업의 생산·계획 또는 완료 입력값을 확인해 주세요.'});
  calculations.set(chainKey,value);return value;
 }
 for(const r of selected){if(r.deleted)continue;const linked=owners.get(r.id)||[];if(linked.length===1){const v=progress(linked[0]);result.set(r.id,{...v,jobId:linked[0].job.id})}else result.set(r.id,{jobId:null,plan:null,produced:null,remaining:null,unproduced:null,percent:null,complete:false,completedAt:null,completionRowId:null,reason:null,stockQty:null,asOf:cutoff,warning:linked.length?'한 실적이 여러 작업에 연결되어 확인이 필요합니다.':'연결된 작업이 없습니다. 시작 계획 또는 작업 연결을 확인해 주세요.'})}
 return result;
}
function factory(s){return (s.calendar?.factory||[]).map(r=>typeof r==='string'?r:r.date)}
function holiday(s,worker,d){return(s.calendar?.workers||[]).some(r=>r.worker===worker&&r.date===d&&r.mark!==''&&!Number.isFinite(Number(r.mark)))}
function work(s,worker,d,today,force=null){if(d===force)return true;if(d<=today)return Object.values(s.months).some(m=>m.rows.some(r=>r.worker===worker&&r.date===d&&r.pours>0));return !factory(s).includes(d)&&!holiday(s,worker,d)}
function nextWork(s,w,d,today,force=null){for(let i=0;i<740;i++,d=add(d,1))if(work(s,w,d,today,force))return d;throw Error('2년 안에 작업 가능한 날짜가 없습니다.')}
const manualCalendarPolicy='marked-holidays-v2';
const manualUsesCalendar=j=>!!j.manual&&!j.firstActual&&!j.complete&&!(j.carried&&j.previousProduced>0);
function manualWork(s,worker,d){if(!C.iso(d))return false;return !factory(s).includes(d)&&!holiday(s,worker,d)}
function nextManualWork(s,worker,d){for(let i=0;i<740;i++,d=add(d,1))if(manualWork(s,worker,d))return d;throw Error('2년 안에 수기 작업 가능한 날짜이 없습니다.')}
function machineQty(job){const a=clone(job.machines||[]),known=C.sum(a,x=>x.qty),missing=a.filter(x=>x.qty==null).length;if(missing){const q=Math.max(0,Math.ceil((job.totalPlan-known)/missing));for(const m of a)if(m.qty==null)m.qty=q}return a}
function asOf(s,k){
 const m=s.months?.[k];if(!m)throw Error('계획 월자료가 없습니다.');const saved=C.iso(m.scheduleAsOf)?m.scheduleAsOf:null,original=!saved?C.scheduleSourceDate(s.archive||[]):null;
 const imported=original&&original.slice(0,4)===k.slice(0,4)?original:null,actual=(m.rows||[]).filter(r=>!r.deleted&&C.iso(r.date)&&r.date.slice(0,7)===k&&(C.num(r.pours)!=null||endsProduction(r))).map(r=>r.date).sort().at(-1);
 return [saved||imported||add(k+'-01',-1),actual].filter(C.iso).sort().at(-1);
}
function dryInputData(s,key,worker,asOfOverride=null){
 const fields=['id','originId','sourceRowId','product','worker','plan','start','end','previousStart','previousPlan','previousProduced','carried','daily','group','duration','afterPrevious','machines','manual','manualSource','stoppedAt','sourceStart','sourceEnd'];
 const inputs=jobs(s,key).filter(job=>job.worker===worker).map(job=>Object.fromEntries(fields.map(field=>[field,field==='product'?C.catalogIdentity(s,job.product):job[field]??null])));
 const actual=Object.keys(s.months||{}).sort().map(month=>[month,(s.months[month].rows||[]).filter(row=>row.worker===worker).map(row=>({...Object.fromEntries(['id','date','worker','product','plan','pours','jobId','sourceRow','deleted'].map(field=>[field,field==='product'?C.catalogIdentity(s,row.product):row[field]??null])),...(row.productionCompletion?{productionCompletion:row.productionCompletion}:{}),...(row.productionPlanQty>0?{productionPlanQty:row.productionPlanQty}:{})})) ]).filter(([,rows])=>rows.length);
 return{version:1,asOf:C.iso(asOfOverride)?asOfOverride:asOf(s,key),jobs:inputs,actual};
}
function dryFingerprint(prefix,value){
 const input=JSON.stringify(value);
 // Compact equality fingerprint, not an authentication or security signature.
 let a=0x811c9dc5,b=0x9e3779b9;for(let i=0;i<input.length;i++){const code=input.charCodeAt(i);a=Math.imul(a^code,0x01000193);b=Math.imul(b^(code+257),0x85ebca6b)}
 return prefix+(a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0');
}
function dryInputSignature(s,key,worker,asOfOverride=null){
 // Keep the v1 serialization unchanged so existing saved provenance remains verifiable.
 return dryFingerprint('dry-input-v1:',{...dryInputData(s,key,worker,asOfOverride),factory:factory(s).slice().sort(),holidays:(s.calendar?.workers||[]).filter(row=>row.worker===worker).map(row=>[row.date,row.mark]).sort((a,b)=>a[0].localeCompare(b[0]))});
}
function dryCoreSignature(s,key,worker,asOfOverride=null){return dryFingerprint('dry-core-v1:',dryInputData(s,key,worker,asOfOverride))}
function sourceDryRows(s){return(Array.isArray(s.scheduleDryHistory)&&s.scheduleDryHistory.length?s.scheduleDryHistory:C.savedScheduleDryMarkers(s.archive||[])).map(row=>named(s,row))}
function sourceDryCandidates(source,row){return source.filter(saved=>saved.worker===row.worker&&saved.product===row.product&&saved.machine===row.machine&&C.iso(saved.start)&&C.iso(saved.end)&&saved.start<=saved.end&&C.iso(saved.dry))}
function sourceDryMatches(source,row){return sourceDryCandidates(source,row).filter(saved=>saved.start===(row.groupStart||row.start)&&saved.end===(row.groupEnd||row.end))}
function dryOutcomeSignature(s,row,saved){
 // Personal rest days matter only when they change the calculated production allocation.
 // Yellow days throughout the saved drying interval still invalidate the original marker,
 // including a saved endpoint that lies one day beyond the current calculated endpoint.
 const through=[row.dry,saved.dry].filter(C.iso).sort().at(-1);
 return dryFingerprint('dry-outcome-v1:',{id:row.id,worker:row.worker,product:C.catalogIdentity(s,row.product),machine:row.machine,start:row.start,end:row.end,groupStart:row.groupStart,groupEnd:row.groupEnd,dry:row.dry,source:saved.source||'',sourceDry:saved.dry,factory:[...new Set(factory(s).filter(date=>date>row.end&&date<=through))].sort()});
}
function captureDryEquivalence(s,baseline){
 if(baseline?.version!==1||baseline.sourceHash!==s.sourceHash)return baseline;
 if(baseline.dryEquivalence&&baseline.dryEquivalence.version!==1)return baseline;
 const source=sourceDryRows(s);if(!source.length)return baseline;
 for(const [key,signatures]of Object.entries(baseline.signatures||{})){
  if(!s.months?.[key]||s.months[key].closed||s.months[key].modern===false)continue;
  const eligible=Object.keys(signatures).filter(worker=>!baseline.dryEquivalence?.months?.[key]?.[worker]&&signatures[worker]===dryInputSignature(s,key,worker));
  if(!eligible.length)continue;
  const calculated=schedule(s,key,null,{skipSourceDry:true}).rows;
  for(const worker of eligible){
   const outcomes={};for(const row of calculated.filter(row=>row.worker===worker&&row.manualCalendarPolicy!==manualCalendarPolicy)){const matches=sourceDryMatches(source,row);if(matches.length===1)outcomes[row.id]=dryOutcomeSignature(s,row,matches[0])}
   if(!Object.keys(outcomes).length)continue;
   // Supplement only a still-verifiable v1 baseline; never relabel edited inputs as source.
   baseline.dryEquivalence??={version:1,months:{}};baseline.dryEquivalence.months??={};baseline.dryEquivalence.months[key]??={};
   baseline.dryEquivalence.months[key][worker]={inputs:dryCoreSignature(s,key,worker),outcomes};
  }
 }
 return baseline;
}
function captureSourceBaseline(s,options={}){
 if(s.scheduleSourceBaseline)return captureDryEquivalence(s,s.scheduleSourceBaseline);
 if(!s.sourceHash||!s.archive?.some(sheet=>sheet.name==='생산일정(계획)'))return null;
 // Older caches with saved edits cannot safely be relabelled as an untouched import.
 if(!options.fromImport&&((s.changes||[]).length||Object.values(s.months||{}).some(month=>(month.history||[]).length)))return null;
 const signatures={};for(const [key,month]of Object.entries(s.months||{}))if(!month.closed&&month.modern!==false){const workers=[...new Set(jobs(s,key).map(job=>job.worker).filter(Boolean))];signatures[key]=Object.fromEntries(workers.map(worker=>[worker,dryInputSignature(s,key,worker)]))}
 const baseline={version:1,sourceHash:s.sourceHash,signatures};s.scheduleSourceBaseline=baseline;return captureDryEquivalence(s,baseline);
}
function preserveSourceDryDates(s,key,rows,asOfOverride=null){
 const baseline=s.scheduleSourceBaseline,verified=baseline?.version===1&&baseline.sourceHash===s.sourceHash,signatures=verified?baseline.signatures?.[key]:null,equivalence=verified&&baseline.dryEquivalence?.version===1?baseline.dryEquivalence.months?.[key]:null,source=sourceDryRows(s),valid=new Map();
 return rows.map(row=>{
  // A new pending manual reservation uses the current weekday policy, even if
  // its imported inputs still match the old workbook's saved drying marker.
  if(row.manualCalendarPolicy===manualCalendarPolicy)return{...row,drySource:row.reservationOnly?'작업일 없는 수기 예약':'재계산 건조일'};
  if(!valid.has(row.worker))valid.set(row.worker,{exact:!!signatures?.[row.worker]&&signatures[row.worker]===dryInputSignature(s,key,row.worker,asOfOverride),equivalent:!!equivalence?.[row.worker]&&equivalence[row.worker].inputs===dryCoreSignature(s,key,row.worker,asOfOverride)});
  const check=valid.get(row.worker),matches=sourceDryCandidates(source,row).filter(saved=>{
   if(check.exact&&saved.start===(row.groupStart||row.start)&&saved.end===(row.groupEnd||row.end))return true;
   // The v1 proof includes the original group bounds. Restore those bounds only in
   // this verification copy: a sibling's later finish cannot invalidate this member's
   // unchanged allocation. Own dates, source cell/dry date and yellow days still match.
   return check.equivalent&&equivalence[row.worker].outcomes?.[row.id]===dryOutcomeSignature(s,{...row,groupStart:saved.start,groupEnd:saved.end},saved);
  });
  // Multiple matching source candidates remain ambiguous even if their dates agree.
  return matches.length===1?{...row,dry:matches[0].dry,drySource:'원본 저장 건조일',drySourceCell:matches[0].source}:{...row,drySource:'재계산 건조일'};
 });
}
function dryHistory(s,start,end){
 if(!C.iso(start)||!C.iso(end)||start>end)return[];
 const saved=Array.isArray(s.scheduleDryHistory)&&s.scheduleDryHistory.length?s.scheduleDryHistory:C.savedScheduleDryMarkers(s.archive||[]);
 return saved.filter(row=>C.iso(row.dry)&&row.dry>=start&&row.dry<=end).map(row=>clone(row));
}
function history(s,start,end){
 if(!C.iso(start)||!C.iso(end)||start>end)return[];
 const saved=Array.isArray(s.scheduleHistory)&&s.scheduleHistory.length?s.scheduleHistory:C.savedSchedulePeriods(s.archive||[]),snapshots=[];
 for(const [key,month]of Object.entries(s.months||{}))if(month.closed&&month.closeSnapshot?.schedule?.rows){
  for(const row of month.closeSnapshot.schedule.rows){if(!C.iso(row.start)||!C.iso(row.end))continue;const id='closed-period:'+key+':'+row.id;snapshots.push({...clone(row),id,jobId:id,groupId:row.groupId?'closed-period:'+key+':'+row.groupId:id,archived:true,history:true,editMonth:key,sourceMonth:key,source:row.source||'월 마감 일정 '+key})}
 }
 // A web close snapshot supersedes the imported period it explicitly captured.
 const superseded=row=>String(row.product||'').split(' / ').every(product=>snapshots.some(other=>other.sourceMonth===row.start.slice(0,7)&&other.worker===row.worker&&other.start<=(row.groupEnd||row.end)&&other.end>=(row.groupStart||row.start)&&C.catalogName(s,product)===C.catalogName(s,other.product)));
 const rows=[...saved.filter(row=>!superseded(row)),...snapshots],seen=new Set();
 return rows.filter(row=>C.iso(row.start)&&C.iso(row.end)&&row.start<=end&&row.end>=start).filter(row=>{const key=row.id||[row.worker,row.product,row.machine,row.start,row.end].join('|');if(seen.has(key))return false;seen.add(key);return true}).map(row=>clone(row)).sort((a,b)=>a.start.localeCompare(b.start)||String(a.worker).localeCompare(String(b.worker)));
}
function schedule(s,k,requestedToday,options={}){const today=C.iso(options.asOf)?options.asOf:asOf(s,k),statusToday=C.iso(requestedToday)?requestedToday:today;if(s.months[k].closed&&s.months[k].closeSnapshot?.schedule)return clone(s.months[k].closeSnapshot.schedule);if(s.months[k].closed){const saved=history(s,k+'-01',add(add(k+'-01',32).slice(0,7)+'-01',-1));if(saved.length)return{jobs:jobs(s,k),rows:saved,warnings:[]};return{jobs:jobs(s,k),rows:(s.scheduleRows||[]).map(r=>({id:'archive:'+r.row,jobId:'',worker:r.cells[0],machine:r.cells[1],dry:C.serial(C.num(r.cells[3])),product:r.cells[4],qty:r.cells[5],start:C.serial(C.num(r.cells[7])),end:C.serial(C.num(r.cells[8])),status:r.cells[9],lot:r.cells[10],archived:true})).filter(r=>r.product&&r.start&&r.end&&r.start<=add(k+'-01',31)&&r.end>=k+'-01'),warnings:[]}}const raw=jobs(s,k),all=raw.filter(j=>!j.manual||j.manualSource==='timeline'||!raw.some(a=>!a.manual&&a.worker===j.worker&&a.product===j.product&&JSON.stringify(machineQty(a))===JSON.stringify(machineQty(j))&&a.start<=j.end)),output=[],warnings=[],groups=new Map();for(const j of all){const key=j.worker+'|'+(Number(j.group)>0||String(j.group).startsWith('manual:')?'group:'+j.group:'job:'+j.id);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(j)}const cursors={};const reservations=all.filter(j=>j.manual&&C.iso(j.start)&&C.iso(j.end));const list=[...groups.values()].sort((a,b)=>Number(b.every(j=>j.complete))-Number(a.every(j=>j.complete))||(a[0].start||'').localeCompare(b[0].start||''));
 for(const members of list){try{const active=members.filter(j=>!j.complete),leader=[...(active.length?active:members)].sort((a,b)=>((b.remaining/(b.daily||1))-(a.remaining/(a.daily||1)))||b.remaining-a.remaining||b.totalPlan-a.totalPlan)[0],w=leader.worker;const invalid=members.filter(j=>!j.worker||!j.start||!j.machines.length||!j.complete&&!(j.daily>0)&&!j.duration&&!j.end);if(invalid.length){for(const j of invalid)warnings.push({id:j.id,product:j.product,message:'작업자·시작일·하루 조수·호기 배치를 확인해 주세요.'});continue}let start=leader.previousStart||leader.firstActual||leader.start,end=leader.lastActual||start,used=[];if(!C.iso(start))throw Error('유효한 시작일이 필요합니다.');if(start.slice(0,7)>k&&!leader.manual){warnings.push({id:leader.id,product:leader.product,message:'다음달 이후 시작 예정입니다.'});continue}
 if(leader.manual&&!leader.firstActual&&!leader.complete){const calendarBased=manualUsesCalendar(leader),allowed=d=>calendarBased?manualWork(s,w,d):!factory(s).includes(d)&&!holiday(s,w,d);start=leader.start;if(leader.duration&&!leader.end){if(leader.afterPrevious&&cursors[w]){start=add(cursors[w],1);for(let i=0;i<3;i++){start=calendarBased?nextManualWork(s,w,start):nextWork(s,w,start,today);if(i<2)start=add(start,1)}}for(let d=start,n=0;used.length<leader.duration;d=add(d,1),n++){if(n>=740)throw Error('수기 기간이 너무 깁니다.');if(allowed(d))used.push(d)}if(calendarBased)start=used[0];end=used.at(-1)}else{end=leader.end;if(!C.iso(end)||end<start)throw Error('수기 종료일은 시작일 이후의 날짜여야 합니다.');used=days(start,end).filter(allowed)}}
 else if(leader.complete){end=leader.stoppedAt||leader.lastActual||start;used=days(start,end).filter(d=>work(s,w,d,today,start))}
 else{let produced=leader.carried?(leader.previousProduced||0):0;const dailyActual={};for(const r of leader.records)dailyActual[r.date]=(dailyActual[r.date]||0)+(r.pours||0);let d=start;if(!leader.firstActual&&cursors[w]&&start<=cursors[w])d=add(cursors[w],1);for(let i=0;i<740;i++,d=add(d,1)){if(d<=today){produced+=dailyActual[d]||0;if(work(s,w,d,today,leader.start))used.push(d)}else if(work(s,w,d,today,leader.start)){used.push(d);produced+=leader.daily}if(produced>=leader.totalPlan){end=d;break}if(i===739)throw Error('2년 안에 목표수량을 채우지 못합니다.')}if(!leader.firstActual)start=used[0]||start}
 if(!used.length&&!manualUsesCalendar(leader))used=[start];const pacer=members.find(j=>j.machines.length>1),pacerQuant=pacer?machineQty(pacer):[],pacerEnds=[];if(pacer){let remaining=0;for(let i=pacerQuant.length-1;i>=0;i--){pacerEnds[i]=i===pacerQuant.length-1?used.length-1:Math.max(0,Math.min(used.length-1,Math.ceil(C.sum(pacerQuant,x=>x.qty)/(pacer.daily||1))-1-remaining));remaining+=Math.ceil(pacerQuant[i].qty/(pacer.daily||1))}}
 let wave=0;for(const j of members){const pendingManual=manualUsesCalendar(j),manualDays=pendingManual?used.filter(d=>manualWork(s,j.worker,d)):null,reservationOnly=pendingManual&&!manualDays.length,fixedManualPeriod=pendingManual&&C.iso(leader.end);if(reservationOnly)warnings.push({id:j.id,product:j.product,message:'수기 기간에 작업 가능한 날짜이 없습니다. 예약 기간은 보존하며 생산·건조일은 계산하지 않습니다.'});const alloc=machineQty(j),total=C.sum(alloc,x=>x.qty);if(Math.abs(total-j.totalPlan)>.00001)warnings.push({id:j.id,product:j.product,message:'호기 배정 '+total+'조 / 계획 '+j.totalPlan+'조. 수량을 확인해 주세요.'});let prior=0;for(let i=0;i<alloc.length;i++){let segStart=start,segEnd=end;if(j.complete){const events=(j.carried?Object.values(s.months).flatMap(m=>m.rows).filter(r=>r.worker===j.worker&&C.catalogName(s,r.product)===j.product&&r.date>=(j.previousStart||j.start)&&r.date<=(j.lastActual||end)):j.records).filter(r=>r.pours>0).sort((a,b)=>a.date.localeCompare(b.date));const before=C.sum(alloc.slice(0,i),x=>x.qty),target=C.sum(alloc.slice(0,i+1),x=>x.qty);if((j.stopped||j.ended)&&before>=j.produced)continue;let cumulative=0;segStart=j.previousStart||j.firstActual||j.start;segEnd=j.stoppedAt||j.lastActual||end;let begun=false;for(const event of events){cumulative+=event.pours;if(!begun&&cumulative>before){segStart=event.date;begun=true}if(cumulative>=target){segEnd=event.date;break}}if(i===alloc.length-1)segEnd=j.stoppedAt||j.lastActual||end}else if(pendingManual){if(!reservationOnly){const fraction=C.sum(alloc.slice(0,i+1),x=>x.qty)/(total||1),idx=i===alloc.length-1?manualDays.length-1:Math.max(0,Math.min(manualDays.length-1,Math.ceil(manualDays.length*fraction)-1));segStart=manualDays[Math.min(prior,manualDays.length-1)];segEnd=fixedManualPeriod&&i===alloc.length-1?end:manualDays[idx];prior=idx+1}}else if(j.manual){const fraction=C.sum(alloc.slice(0,i+1),x=>x.qty)/(total||1);const idx=i===alloc.length-1?used.length-1:Math.max(0,Math.ceil(used.length*fraction)-1);segStart=used[Math.min(prior,used.length-1)];segEnd=i===alloc.length-1?end:used[idx];prior=idx+1}else if(alloc.length>1){const later=C.sum(alloc.slice(i+1),x=>Math.ceil(x.qty/(j.daily||1)));const idx=i===alloc.length-1?used.length-1:Math.max(0,Math.min(used.length-1,Math.ceil(total/(j.daily||1))-1-later));segStart=used[Math.min(prior,used.length-1)];segEnd=used[idx];prior=idx+1}else if(pacer&&j!==pacer){const wi=Math.min(wave++,pacerEnds.length-1),prev=wi? pacerEnds[wi-1]+1:0;segStart=used[Math.min(prev,used.length-1)];segEnd=used[Math.max(prev,Math.min(used.length-1,pacerEnds[wi]))];let delta=Math.ceil(alloc[0].qty/(j.daily||1))-Math.ceil(pacerQuant[wi].qty/(pacer.daily||1));while(delta>0){segEnd=nextWork(s,w,add(segEnd,1),today);delta--}while(delta<0&&segEnd>segStart){segEnd=add(segEnd,-1);if(work(s,w,segEnd,today))delta++}}
 const conflicts=reservations.filter(r=>r.id!==j.id&&r.worker===j.worker&&r.start<=segEnd&&r.end>=segStart&&!((r.product===j.product)&&JSON.stringify(r.machines)===JSON.stringify(j.machines)));if(!j.manual&&conflicts.length){const cap=conflicts.map(r=>r.start).sort()[0];if(cap<=segStart){warnings.push({id:j.id,product:j.product,message:'수기 예약과 시작일이 겹쳐 배치하지 못했습니다.'});continue}segEnd=add(cap,-1);warnings.push({id:j.id,product:j.product,message:'수기 예약 앞에서 기간을 제한했습니다. 계획수량은 보존됩니다.'})}
 const dry=reservationOnly?null:C.dryDate(segEnd,factory(s));output.push({...(pendingManual?{manualCalendarPolicy,manualWorkdays:manualDays.length,reservationOnly,fixedManualPeriod}:{}),id:j.id+':'+i,jobId:j.id,worker:j.worker,product:j.product,machine:alloc[i].name,qty:alloc[i].qty,start:segStart,end:segEnd,groupStart:start,groupEnd:end,requestedStart:leader.start,groupId:w+'|'+(Number(leader.group)>0||String(leader.group).startsWith('manual:')?'group:'+leader.group:'job:'+leader.id),dry,lot:j.lot,manual:!!j.manual,produced:j.produced,plan:j.totalPlan,remaining:j.remaining,status:j.stopped?'중단':j.complete?(statusToday>=dry?'건조 완료':'건조 중'):!j.firstActual?'미착수':'생산중',projected:!j.complete,description:j.legacyInput||'',source:j.sourceRowId?'생산일보':'웹 작업'})}}cursors[w]=!cursors[w]||cursors[w]<end?end:cursors[w]}
 catch(e){warnings.push({id:members[0].id,product:members.map(j=>j.product).join(', '),message:e.message})}}
 // Fixed pending manual dates remain the reservation bounds; other groups use
 // final allocated spans after reservation caps and paired-wave extensions.
 const bounds=new Map();for(const r of output){const start=r.fixedManualPeriod?r.groupStart:r.start,end=r.fixedManualPeriod?r.groupEnd:r.end,b=bounds.get(r.groupId);if(!b)bounds.set(r.groupId,{start,end});else{if(start<b.start)b.start=start;if(end>b.end)b.end=end}}for(const r of output){const b=bounds.get(r.groupId);r.groupStart=b.start;r.groupEnd=b.end}
 const directIds=new Set(raw.filter(j=>j.manual&&j.manualSource==='timeline').map(j=>j.id)),warned=new Set();for(const r of output){if(!directIds.has(r.jobId)||warned.has(r.jobId))continue;if(output.some(a=>!a.manual&&a.worker===r.worker&&a.machine===r.machine&&a.start<=r.end&&a.end>=r.start)){warnings.push({id:r.jobId,product:r.product,message:'직접 입력한 수기 예약과 자동 일정의 호기·기간이 겹칩니다. 두 일정을 보존했으니 배치를 확인해 주세요.'});warned.add(r.jobId)}}
 return{rows:(options.skipSourceDry?output:preserveSourceDryDates(s,k,output,today)).sort((a,b)=>a.start.localeCompare(b.start)),jobs:all,warnings,asOf:today}}
function extendHolidays(s,worker,start,weeks){if(!C.iso(start)||!Number.isInteger(weeks)||weeks<1||weeks>26)throw Error('휴일 연장은 1~26주입니다.');s.calendar??={factory:[],workers:[]};const totals={};for(const d of days(add(start,-28),add(start,-1)))if(holiday(s,worker,d)){const dow=new Date(d).getUTCDay();totals[dow]=(totals[dow]||0)+1}const inserted=[];for(const d of days(start,add(start,weeks*7-1))){if(d.slice(0,4)!==start.slice(0,4))continue;const dow=new Date(d).getUTCDay();if(totals[dow]>=3&&!s.calendar.workers.some(r=>r.worker===worker&&r.date===d)){const r={id:C.id(),worker,date:d,mark:'휴'};s.calendar.workers.push(r);inserted.push(r.id)}}s.calendar.undo={year:start.slice(0,4),ids:inserted};return inserted.length}
function undoHolidays(s,year){const undo=s.calendar?.undo;if(!undo||undo.year!==year)throw Error('같은 연도의 연장 이력이 없습니다.');s.calendar.workers=s.calendar.workers.filter(r=>!undo.ids.includes(r.id)||r.mark!=='휴');delete s.calendar.undo}
root.SchedulePlanning={add,days,parseInput,jobs,dailyProgress,factory,holiday,work,nextWork,manualCalendarPolicy,manualWork,nextManualWork,machineQty,asOf,dryInputSignature,captureSourceBaseline,preserveSourceDryDates,history,dryHistory,schedule,extendHolidays,undoHolidays};if(typeof module!=='undefined')module.exports=root.SchedulePlanning;
})(globalThis);
