'use strict';
// Return shared daily fields after the forward three-way merge has succeeded.
// Source baselines are acknowledged only by the next ordinary forward merge.
const {hash,stable,sourceFiles,productIndex,completionValue,machineActuals,outboundTarget}=require('./ilbo-sync.cjs');
const clone=x=>JSON.parse(JSON.stringify(x)),own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k),same=(a,b)=>stable(a??null)===stable(b??null),clean=x=>String(x??'').trim();
const POLICY='daily-two-way-v1';
const DETAIL_FIELDS=['defPart','gasa','cs','gap','inlet','face','bubble','b1','b2','remark'];
const FIELDS={pours:'prod',plan:'plan',productionCompletion:'productionCompletion',productionPlanQty:'productionPlanQty',machineActuals:'machineActuals',fieldScrapKg:'scrapKg',fieldDefQty:'defQty'};
const numeric=new Set(['pours','plan','productionPlanQty','fieldScrapKg','fieldDefQty']);
function validDate(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value}
function planFieldReturn(input,snapshot,forwardReport,options={}){
 const state=clone(input);
 const files=sourceFiles(snapshot),ix=productIndex(state.products),now=options.now||snapshot.readAt||new Date().toISOString(),asOf=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
 let data=new Map(files.map(f=>[f.path,clone(snapshot.files[f.path].data)]));const sourceRows=new Map(),links=new Map(),issues=[],changes=[],operations=[],changedMonths=new Set();
 const key=(path,id)=>path+'\0'+id,group=(date,worker)=>date+'\0'+clean(worker),blocked=new Set((forwardReport?.issues||[]).map(i=>key(i.path,i.id)));
 for(const f of files)for(const row of f.rows)sourceRows.set(key(f.path,row.id),{file:f,row});
 for(const [month,m]of Object.entries(state.months||{}))for(const row of m.rows||[]){const si=row.sourceIntegration;if(!row.deleted&&si?.repo===snapshot.repo){const k=key(si.path,si.id);if(!links.has(k))links.set(k,[]);links.get(k).push({month,m,row})}}
 const issue=(code,row,si,fields=[])=>issues.push({code,path:si?.path||'data/'+row.date+'.json',id:si?.id||row.id,date:row.date,worker:row.worker,sourceProduct:row.product,fields});
 const rawNumber=(value,field)=>value==null&&(field==='plan'||field==='fieldScrapKg'||field==='fieldDefQty')?'':value;
 function patchRow(row,raw,baseline,product,created=false){
  const next=clone(raw),changed=[];
  for(const [target,source]of Object.entries(FIELDS)){
   if(!own(row,target)||!created&&same(row[target],baseline[target]))continue;
   const value=row[target];if(numeric.has(target)&&value!==null&&!(typeof value==='number'&&Number.isFinite(value)&&value>=0))throw Error(target);
   if(target==='pours'&&value==null||target==='productionPlanQty'&&value!==null&&!(value>0))throw Error(target);
   if(target==='productionCompletion')try{completionValue(value)}catch{throw Error(target)}
   next[source]=clone(rawNumber(value,target));changed.push(target);
  }
  if(created||!same(row.worker,baseline.worker)){if(!clean(row.worker))throw Error('worker');next.worker=clean(row.worker);changed.push('worker')}
  if(created||!same(row.product,baseline.product)||clean(raw.product)!==product.name){
   if(!created&&clean(raw.product)!==product.name&&!own(next,'sourceProduct'))next.sourceProduct=raw.product;
   next.product=product.name;next.productId=product.id;changed.push('product');
  }
  for(const field of DETAIL_FIELDS)if(own(row.fieldDetails||{},field)&&(created||!same(row.fieldDetails[field],baseline.fieldDetails?.[field]))){if(typeof row.fieldDetails[field]!=='string')throw Error('fieldDetails');next[field]=row.fieldDetails[field];changed.push('fieldDetails.'+field)}
  if(changed.includes('plan')&&(own(raw,'planIntent')||own(row,'fieldPlanIntent')))next.planIntent=row.plan>0?'start':row.plan===0?'end':'continue';
  if(own(row,'fieldPlanIntent')&&!same(row.fieldPlanIntent,baseline.fieldPlanIntent)&&!changed.includes('plan')){const intent=row.fieldPlanIntent;if(!['start','continue','end'].includes(intent)||intent==='start'&&!(row.plan>0)||intent==='end'&&row.plan!==0||intent==='continue'&&row.plan!=null)throw Error('fieldPlanIntent');next.planIntent=intent;changed.push('fieldPlanIntent')}
  if(next.machineActuals!=null)try{next.machineActuals=machineActuals(next.machineActuals,next.prod)}catch{throw Error('machineActuals')}
  return{next,changed};
 }
 for(const [k,refs]of links){
  const {row,m,month}=refs[0],si=row.sourceIntegration,found=sourceRows.get(k);if(m.closed||m.closeSnapshot||blocked.has(k))continue;
  if(refs.length!==1){issue('return-duplicate-link',row,si);continue}
  if(!found||!si.baseline||si.sourceHash!==hash(found.row)){issue('return-source-changed',row,si);continue}
  if(found.row.off){issue('return-record-kind',row,si);continue}
  let product;try{product=ix.resolve({product:row.product})}catch{}if(!product){issue('return-product-review',row,si);continue}
  const baseline=si.baseline,moved=!same(row.date,baseline.date),workerChanged=!same(row.worker,baseline.worker);
  if(!validDate(row.date)||!row.date.startsWith(month)){issue('return-date-review',row,si);continue}
  let update;try{update=patchRow(row,found.row,baseline,product)}catch(e){issue('return-field-review',row,si,[e.message]);continue}
  if(moved){update.next.managementLink={schema:1,rowId:row.id,previousPath:si.path};if(own(update.next,'date'))update.next.date=row.date;update.changed.push('date')}
  const hourGroups=!same(row.hours,baseline.hours)||moved||workerChanged?[...new Set([group(baseline.date,baseline.worker),group(row.date,row.worker)])]:[];
  if(!update.changed.length&&!hourGroups.length)continue;
  const destination='data/'+row.date+'.json',old=data.get(si.path),target=data.get(destination)||{rows:[]};
  if(moved&&target.rows.some(r=>r.id===si.id)){issue('return-date-duplicate',row,si);continue}
  if(moved){old.rows=old.rows.filter(r=>r.id!==si.id);target.rows.push(update.next);data.set(destination,target)}else old.rows=old.rows.map(r=>r.id===si.id?update.next:r);
  operations.push({row,month,from:si.path,path:destination,id:si.id,next:update.next,fields:update.changed,hourGroups});
 }
 // New management input is identified by its actual creation event, never by
 // guessing that unmatched imported/archived rows should become field records.
 for(const [month,m]of Object.entries(state.months||{})){
  if(m.closed||m.closeSnapshot)continue;
  const created=new Set((m.history||[]).filter(e=>e.kind==='daily'&&!e.before&&e.after?.id&&e.type!=='ilbo-sync').map(e=>e.after.id));
  for(const row of m.rows||[]){
   if(row.deleted||row.sourceIntegration||!created.has(row.id)||!validDate(row.date)||!row.date.startsWith(month)||row.date>asOf||row.pours==null)continue;
   let product;try{product=ix.resolve({product:row.product})}catch{}if(!product){issue('return-product-review',row);continue}
   const path='data/'+row.date+'.json',day=data.get(path)||{rows:[]},id='management:'+row.id;
   if(day.rows.some(r=>r.id===id))continue;
   let update;try{update=patchRow(row,{id,managementLink:{schema:1,rowId:row.id}}, {},product,true)}catch(e){issue('return-field-review',row,null,[e.message]);continue}
   day.rows.push(update.next);data.set(path,day);operations.push({row,month,from:null,path,id,next:update.next,fields:['new'],hourGroups:[group(row.date,row.worker)]});
  }
 }
 // Identity moves and their two daily clock groups commit together. Rebuild
 // from the input after each newly held group, so no old clock can leak into a
 // destination that is blocked by a sibling's independent source conflict.
 const dailyRows=new Map();for(const m of Object.values(state.months||{}))for(const row of m.rows||[])if(!row.deleted){const g=group(row.date,row.worker);if(!dailyRows.has(g))dailyRows.set(g,[]);dailyRows.get(g).push(row)}
 const denied=new Set();let accepted=operations,affectedHours=new Set();
 function rebuild(ops){const value=new Map(files.map(f=>[f.path,clone(snapshot.files[f.path].data)]));for(const op of ops){if(op.from&&op.from!==op.path)value.get(op.from).rows=value.get(op.from).rows.filter(r=>r.id!==op.id);const day=value.get(op.path)||{rows:[]};if(op.from===op.path)day.rows=day.rows.map(r=>r.id===op.id?clone(op.next):r);else day.rows.push(clone(op.next));value.set(op.path,day)}return value}
 function clockGroup(g){const [date,worker]=g.split('\0'),path='data/'+date+'.json',rows=dailyRows.get(g)||[],hours=rows.map(r=>r.hours).filter(v=>v!=null&&v!==''),total=hours.length?hours.reduce((n,v)=>n+v,0):null,members=(data.get(path)?.rows||[]).filter(r=>!r.off&&clean(r.worker)===worker);const unsafe=members.some(raw=>sourceRows.has(key(path,raw.id))&&(blocked.has(key(path,raw.id))||links.get(key(path,raw.id))?.length!==1));return{date,worker,path,rows,total,members,unsafe:unsafe||hours.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0)||total>24}}
 for(let pass=0;pass<=operations.length;pass++){
  accepted=operations.filter(op=>!op.hourGroups.some(g=>denied.has(g)));data=rebuild(accepted);affectedHours=new Set(accepted.flatMap(op=>op.hourGroups));let changed=false;
  for(const g of affectedHours){const value=clockGroup(g);if(value.unsafe&&!denied.has(g)){denied.add(g);issue('return-hours-review',value.rows[0]||{date:value.date,worker:value.worker,product:''},null,['hours']);changed=true}}
  if(!changed)break;
 }
 for(const op of accepted)if(op.fields.length)changes.push({rowId:op.row.id,path:op.path,id:op.id,fields:op.fields});
 for(const g of affectedHours){const {path,total,members}=clockGroup(g);for(const raw of members)if(!same(raw.hours===''?null:raw.hours,total)){raw.hours=total===null?'':total;changes.push({path,id:raw.id,fields:['hours']})}}
 const sent=new Set(),outboundOwners=new Map(accepted.map(op=>[key(op.path,op.id),op]));
 for(const [path,day]of data)for(const raw of day.rows){
  const old=sourceRows.get(key(path,raw.id))?.row;if(same(raw,old))continue;
  const op=outboundOwners.get(key(path,raw.id)),refs=links.get(key(path,raw.id)),owner=op||refs?.length===1&&refs[0];if(!owner)continue;
  const row=owner.row,target=outboundTarget(row),from=op?.from??path,before=from?sourceRows.get(key(from,raw.id))?.row:null,beforeHash=before?hash(before):null;
  const id=hash({policy:POLICY,repo:snapshot.repo,path,sourceId:raw.id,beforeHash,target,targetRev:row.rev??null});raw.managementReceipt={schema:1,id};
  const receipt={schema:1,id,repo:snapshot.repo,path,sourceId:raw.id,beforeHash,sentHash:hash(raw),targetRev:row.rev??null,target};
  const prior=row.sourceIntegration?.outbound||row.integrationOutbound;if(!same(prior,receipt)){if(row.sourceIntegration)row.sourceIntegration.outbound=receipt;else row.integrationOutbound=receipt;changedMonths.add(owner.month)}sent.add(row);
 }
 // A failed source push followed by a management undo cancels the obsolete
 // pending receipt once the source is still exactly its pre-send version.
 for(const [month,m]of Object.entries(state.months||{}))if(!m.closed&&!m.closeSnapshot)for(const row of m.rows||[]){const receipt=row.sourceIntegration?.outbound||row.integrationOutbound;if(!receipt||sent.has(row))continue;const raw=sourceRows.get(key(row.sourceIntegration?.path||receipt.path,receipt.sourceId))?.row;if(raw&&hash(raw)===receipt.beforeHash&&!same(outboundTarget(row),receipt.target)){if(row.sourceIntegration)delete row.sourceIntegration.outbound;delete row.integrationOutbound;changedMonths.add(month)}}
 const writes={};for(const [path,day]of data)if(!same(day,snapshot.files[path]?.data))writes[path]=day;
 for(const month of changedMonths)state.months[month].rev=(state.months[month].rev||0)+1;
 return{policy:POLICY,state,changedMonths:[...changedMonths].sort(),writes,issues,changes,changedRows:new Set(changes.map(c=>key(c.path,c.id))).size};
}
function withReturnReport(report,returned,previous=null,changedMonths=[]){
 const next=clone(report);next.policyVersion='ilbo-sync-3';next.twoWay={policy:POLICY,pendingRows:returned.changedRows,issues:returned.issues};
 if(previous&&changedMonths.length===0&&previous.policyVersion===next.policyVersion&&same(previous.sourceFiles,next.sourceFiles)&&previous.sourceCommit===next.sourceCommit&&same(previous.qualityWarnings,next.qualityWarnings)&&same(previous.twoWay,next.twoWay)&&same(previous.issues,[...next.issues,...returned.issues]))return clone(previous);
 next.issues=[...next.issues,...returned.issues];next.counts.held=next.issues.length;next.status=next.issues.length?'review':returned.changedRows?'pending':'ok';next.revision=hash({...next,revision:undefined});return next;
}
module.exports={planFieldReturn,withReturnReport,POLICY,DETAIL_FIELDS};
