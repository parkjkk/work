'use strict';
const {hash,sourceFiles,productIndex}=require('./ilbo-sync.cjs');
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k),copy=x=>JSON.parse(JSON.stringify(x));
const SOURCE_FIELDS=['id','worker','product','productId','plan','prod','planIntent','productionCompletion','productionPlanQty','scheduleConditions'];
function projectProgress(state,snapshot,previous,now=new Date().toISOString(),planning){
 if(!planning){require('./schedule-core.cjs');planning=require('./schedule-planning.cjs');}
 if(typeof planning.dailyProgress!=='function')throw Error('Matching planning runtime is required');
 const date=new Date(now);if(!Number.isFinite(+date))throw Error('Invalid projection timestamp');
 const asOf=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
 const raw=new Map();for(const file of sourceFiles(snapshot))for(const row of file.rows)raw.set(file.path+'\0'+row.id,{file,row});
 const linked=new Map(),rowsById=new Map();for(const [month,value]of Object.entries(state.months||{}))for(const row of value.rows||[]){if(!rowsById.has(row.id))rowsById.set(row.id,row);const si=row.sourceIntegration;if(row.deleted||si?.repo!==snapshot.repo)continue;const key=si.path+'\0'+si.id;if(!linked.has(key))linked.set(key,[]);linked.get(key).push({month,row});}
 const indexes=new Map(),entries=[],unsafeJobs=new Set(),unlinkedProducts=new Set(),ix=productIndex(state.products);
 for(const [key,source]of raw){if(linked.has(key)||source.row.off||source.file.date>asOf)continue;const r=source.row,products=new Set([ix.ids.get(r.productId),ix.names.get(String(r.product||'').trim())].filter(Boolean));for(const product of products)unlinkedProducts.add(String(r.worker||'').trim()+'\0'+product.id);}
 const progressFor=({month,row})=>{if(!indexes.has(month))indexes.set(month,planning.dailyProgress(state,month,{asOf}));return indexes.get(month).get(row.id)};
 const jobKey=(progress,month)=>progress?.originId||[month,progress?.jobId].join(':');
 // A changed or ambiguous source member invalidates the whole linked job's old total.
 for(const [key,links]of linked){const source=raw.get(key);if(links.length!==1||!source||links.some(x=>x.row.sourceIntegration.sourceHash!==hash(source.row)))for(const link of links){const p=progressFor(link);if(p?.jobId)unsafeJobs.add(jobKey(p,link.month));}}
 for(const [key,links]of linked){if(links.length!==1)continue;const source=raw.get(key),{month,row}=links[0];if(!source||row.sourceIntegration.sourceHash!==hash(source.row))continue;
  // Closed rows retain their original spelling. Compare the catalog identity so
  // a renamed product cannot reuse old totals while a new source row is held.
  let product;try{product=ix.resolve({productId:row.sourceIntegration.productId,product:row.product})}catch{continue}
  const progress=progressFor(links[0]);if(!product||!progress||unsafeJobs.has(jobKey(progress,month))||unlinkedProducts.has(String(row.worker||'').trim()+'\0'+product.id))continue;
  const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
  const completionRow=progress.completionRowId&&rowsById.get(progress.completionRowId);
  entries.push({path:source.file.path,id:source.row.id,worker:row.worker,productId:row.sourceIntegration.productId||source.row.productId||null,product:row.product,jobId:progress.jobId||null,plan:number(progress.plan),produced:number(progress.produced),remaining:number(progress.remaining),unproduced:number(progress.unproduced),percent:number(progress.percent),complete:progress.complete===true,completedAt:progress.completedAt||null,reason:progress.reason||null,stockQty:number(progress.stockQty),note:completionRow?.productionCompletion?.note||'',warning:progress.warning||null,source:Object.fromEntries(SOURCE_FIELDS.filter(k=>own(source.row,k)).map(k=>[k,copy(source.row[k])]))});
 }
 for(const entry of entries){const target=linked.get(entry.path+'\0'+entry.id)[0],progress=progressFor(target);entry.originId=progress.originId||progress.jobId||null;entry.progressMonth=progress.progressMonth||target.month;}
 entries.sort((a,b)=>(a.path+'\0'+a.id).localeCompare(b.path+'\0'+b.id));
 const revision=hash({asOf,entries});if(previous?.schema===1&&previous.kind==='schedule-production-progress'&&previous.revision===revision&&hash({asOf:previous.asOf,entries:previous.entries})===revision)return copy(previous);
 return{schema:1,kind:'schedule-production-progress',revision,updatedAt:date.toISOString(),asOf,entries};
}
module.exports={projectProgress,SOURCE_FIELDS};
