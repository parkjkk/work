(function(root){
'use strict';
const text=x=>x==null?'':String(x).trim(), num=x=>x==null||String(x).trim()===''?null:(Number.isFinite(Number(x))?Number(x):null);
const col=n=>{let s='';while(n>0){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s};
const ci=s=>[...s].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
const val=(s,a)=>s?.cells?.[a]?.v??null;
const date=(y,m,d)=>{const x=new Date(Date.UTC(y,m-1,d));return x.getUTCFullYear()===y&&x.getUTCMonth()===m-1&&x.getUTCDate()===d?x.toISOString().slice(0,10):null};
const serial=n=>Number.isFinite(n)?new Date(Date.UTC(1899,11,30)+n*86400000).toISOString().slice(0,10):null;
const iso=x=>/^\d{4}-\d{2}-\d{2}$/.test(x)&&date(+x.slice(0,4),+x.slice(5,7),+x.slice(8))===x;
function scheduleSourceDate(sheets=[]){
 const grid=sheets.find(s=>s.name==='생산일정(계획)'),year=num(val(grid,'D1'));if(!Number.isInteger(year)||year<1900||year>2200)return null;
 const sync=sheets.find(s=>s.name==='_ScheduleSync'),stamp=num(val(sync,'B5')),saved=stamp>30000&&stamp<150000?serial(stamp):null;if(saved&&Number(saved.slice(0,4))===year)return saved;
 const summary=sheets.find(s=>s.name==='생산일정(요약)'),match=/기준\s*(\d{1,2})\/(\d{1,2})/.exec(text(val(summary,'A1')));return match?date(year,Number(match[1]),Number(match[2])):null;
}
// A historical bar is a saved worksheet span, not a new schedule calculation.
function savedSchedulePeriods(sheets=[],styles=null){
 const grid=sheets.find(s=>s.name==='생산일정(계획)'),year=num(val(grid,'D1'));
 if(!grid||!Number.isInteger(year)||year<1900||year>2200)return[];
 const leap=year%4===0&&(year%100!==0||year%400===0),day=column=>{const offset=column-6;if(offset<0||offset>365||!leap&&offset===59)return null;return new Date(Date.UTC(year,0,1+offset-(!leap&&offset>59?1:0))).toISOString().slice(0,10)};
 const merged=new Map((grid.merges||[]).map(range=>[range.split(':')[0],range]));
 const paint=cell=>cell?.s==null?null:styles?.cellXfs?.[cell.s]?.fillId??cell.s;
 const periods=[];
 for(let row=3;row<=100;row+=6){const worker=text(val(grid,'D'+row));if(!worker||text(val(grid,'E'+(row+2)))!=='기간')continue;
  for(let column=6;column<=371;column++){
   const address=col(column)+(row+2),cell=grid.cells[address],label=text(cell?.v);if(!label||!/^✅/.test(label))continue;
   let last=column,method='cell-style-run';const range=merged.get(address),endAddress=range?.split(':')[1],endMatch=/^([A-Z]+)(\d+)$/.exec(endAddress||'');
   if(endMatch&&Number(endMatch[2])===row+2&&ci(endMatch[1])>=column&&ci(endMatch[1])<=371){last=ci(endMatch[1]);method='merge'}
   else if(paint(cell)!=null){method=styles?'cell-fill-run':'cell-style-run';while(last<371){const next=grid.cells[col(last+1)+(row+2)];if(text(next?.v)||paint(next)==null||String(paint(next))!==String(paint(cell)))break;last++}}
   const start=day(column),end=day(last);if(!start||!end)continue;
   const items=[...label.matchAll(/(?:^|\s)([^\s/]+)\s+(\d+(?:\.\d+)?)\s*조/g)].map(match=>({product:match[1],qty:Number(match[2])}));
   const id='excel-period:'+year+':'+address;
   periods.push({id,jobId:id,groupId:id,worker,product:[...new Set(items.map(item=>item.product))].join(' / ')||label.replace(/^✅\s*/,''),machine:[...new Set([...label.matchAll(/\d+(?:\.\d+)?\s*호/g)].map(match=>match[0].replace(/\s/g,'')))].join(', '),qty:items.length?sum(items,item=>item.qty):null,start,end,groupStart:start,groupEnd:end,dry:null,status:'생산 완료',projected:false,archived:true,history:true,source:'생산일정(계획)!'+address,sourceLabel:label,sourceSpan:address+':'+col(last)+(row+2),sourceSpanMethod:method,sourceYear:year});
   column=last;
  }
 }
 return periods;
}
function savedScheduleDryMarkers(sheets=[]){
 const grid=sheets.find(sheet=>sheet.name==='생산일정(계획)'),summary=sheets.find(sheet=>sheet.name==='생산일정(요약)'),year=num(val(grid,'D1'));
 if(!grid||!Number.isInteger(year)||year<1900||year>2200)return[];
 const leap=year%4===0&&(year%100!==0||year%400===0),day=column=>{const offset=column-6;if(offset<0||offset>365||!leap&&offset===59)return null;return new Date(Date.UTC(year,0,1+offset-(!leap&&offset>59?1:0))).toISOString().slice(0,10)};
 const lookup=new Map(),machineNumber=value=>text(value).replace(/\s/g,'').replace(/호기?$/,'');
 if(summary)for(let row=3;row<=1000;row++){
  const worker=text(val(summary,'A'+row)),machine=machineNumber(val(summary,'B'+row)),dry=serial(num(val(summary,'D'+row))),product=text(val(summary,'E'+row));
  if(!worker||!/^\d+(?:\.\d+)?$/.test(machine)||!iso(dry)||!product)continue;
  const key=[worker,dry,machine].join('|');if(!lookup.has(key))lookup.set(key,[]);lookup.get(key).push({product,start:serial(num(val(summary,'H'+row))),end:serial(num(val(summary,'I'+row))),sourceSummary:'생산일정(요약)!'+row});
 }
 const markers=[];
 for(let row=3;row<=100;row+=6){const worker=text(val(grid,'D'+row));if(!worker||text(val(grid,'E'+(row+3)))!=='건조')continue;
  for(let column=6;column<=371;column++){
   const address=col(column)+(row+3),label=text(val(grid,address)),date=day(column);if(!date||!label)continue;
   const machines=[...new Set(label.split(',').map(machineNumber).filter(machine=>/^\d+(?:\.\d+)?$/.test(machine)))];
   for(const machine of machines){const matches=lookup.get([worker,date,machine].join('|'))||[{product:'',sourceSummary:''}];for(const match of matches){const id='excel-dry:'+year+':'+address+':'+machine+':'+(match.product||'unlinked');markers.push({id,jobId:id,worker,machine:machine+'호',...match,date,dry:date,source:'생산일정(계획)!'+address,sourceLabel:label,sourceRow:row+3,sourceColumn:column,archived:true,history:true,projected:false})}}
  }
 }
 return markers;
}
const clone=x=>JSON.parse(JSON.stringify(x));
const id=()=>globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+Math.random().toString(36).slice(2);
function dailyQuality(r){
 const fieldKg=Object.prototype.hasOwnProperty.call(r,'fieldScrapKg'),fieldCount=Object.prototype.hasOwnProperty.call(r,'fieldDefQty'),recorded=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null,k=num(r.defectUnit),l=num(r.defectCount);
 return{kg:fieldKg?recorded(r.fieldScrapKg):k!=null&&l!=null&&k*l!==0?k*l:null,count:fieldCount?recorded(r.fieldDefQty):l,fieldKg,fieldCount};
}
function daily(r){const i=num(r.plaster),j=num(r.pours),g=num(r.cases),h=num(r.waterRatio),quality=dailyQuality(r),l=quality.count;const plaster=i!=null&&j!=null&&i*j!==0?i*j:null,water=i!=null&&h!=null?i*h/100:null,defect=quality.kg,demould=g!=null&&j!=null&&g*j!==0?g*j:null;return{plaster,water,mix:i!=null&&water!=null&&(i>0||water>0)?i+water:null,demould,defect,rate:demould>0&&l!=null?l/demould:null}}
function dryDate(end,excluded=[],days=10){if(!iso(end)||!Number.isInteger(days)||days<0)throw Error('유효한 종료일과 건조일수가 필요합니다.');const set=new Set(excluded);let d=new Date(end+'T00:00:00Z'),n=0;while(n<days){d.setUTCDate(d.getUTCDate()+1);if(!set.has(d.toISOString().slice(0,10)))n++}return d.toISOString().slice(0,10)}
function sum(rows,f){return rows.reduce((s,r)=>s+(num(f(r))??0),0)}
const fields={B:'day',C:'worker',D:'hours',E:'product',F:'plan',G:'cases',H:'waterRatio',I:'plaster',J:'pours',K:'defectUnit',L:'defectCount',S:'defectPart',T:'lot'};
function managementProducts(master){
 const products=[],byName=new Map(),fields=['cases','waterRatio','kg','adjustedWaterRatio','measured','note'];
 const usable=name=>name&&!/합계|품명/.test(name),source=(column,row)=>({sheet:'관리',cell:column+row});
 for(let r=9;r<=300;r++){
  const name=text(val(master,'BD'+r));if(!usable(name))continue;
  const candidate={sourceRow:r,cases:num(val(master,'BC'+r)),waterRatio:num(val(master,'BE'+r)),kg:num(val(master,'BF'+r)),adjustedWaterRatio:num(val(master,'BH'+r)),measured:text(val(master,'BL'+r)),note:text(val(master,'BM'+r))};
  const existing=byName.get(name);
  if(existing){existing.catalogSources.push(source('BD',r));const first=existing.catalogReview?.candidates||[{sourceRow:existing.catalogSources[0].cell.slice(2)*1,...Object.fromEntries(fields.map(f=>[f,existing[f]]))}];const candidates=[...first,candidate];existing.catalogReview={status:'needs-review',candidates};for(const field of fields)existing[field]=candidates.every(c=>JSON.stringify(c[field])===JSON.stringify(candidates[0][field]))?candidates[0][field]:['measured','note'].includes(field)?'':null;}
  else{const product={id:'product:'+name,rev:1,name,...Object.fromEntries(fields.map(f=>[f,candidate[f]])),catalogSources:[source('BD',r)]};products.push(product);byName.set(name,product)}
 }
 const inventoryHeadings=new Set(['바디','림','세면기','탱크','뚜껑','스톨','부속','보형,토수구']);
 for(const column of ['V','AB'])for(let r=9;r<=300;r++){
  const name=text(val(master,column+r));if(!usable(name)||inventoryHeadings.has(name))continue;const existing=byName.get(name);
  if(existing)existing.catalogSources.push(source(column,r));else{const product={id:'product:'+name,rev:1,name,cases:null,waterRatio:null,kg:null,adjustedWaterRatio:null,measured:'',note:'',catalogSources:[source(column,r)]};products.push(product);byName.set(name,product)}
 }
 return products;
}
function catalogUnitSourceInfo(sheet){
 const cells=Object.entries(sheet.cells||{}),helper=cells.some(([a,c])=>/^C[J-M]\d+$/.test(a)&&/관리[\s'!]/.test(c.f||''));
 const references=f=>/관리[\s'!]/.test(f)||(helper&&/\$?C[J-M]/.test(f)&&/INDEX|VLOOKUP|XLOOKUP/i.test(f));
 return{references,shared:Object.fromEntries(['G','I'].map(column=>[column,cells.some(([a,c])=>new RegExp('^'+column+'\\d+$').test(a)&&references(c.f||''))]))};
}
function catalogUnitSources(sheet,row,info=catalogUnitSourceInfo(sheet)){
 const result={};
 for(const [column,field]of [['G','cases'],['I','plaster']]){
  const cell=sheet.cells?.[column+row];if(!cell||!('f'in cell))continue;
  const formula=cell.f||'';
  if(info.references(formula)||!formula&&info.shared[column])result[field]='catalog';
 }
 return result;
}
function refreshCatalogUnits(state){
 const keys=[],at=new Date().toISOString();
 for(const [key,month]of Object.entries(state.months||{})){
  if(month.closed)continue;let changed=false;
  for(const row of month.rows||[]){
   const matches=(state.products||[]).filter(p=>p.name===row.product);if(matches.length!==1||matches[0].catalogReview?.status==='needs-review')continue;
   const product=matches[0],fields=[];for(const [field,name]of [['cases','cases'],['plaster','kg']]){
    if(row.unitSources?.[field]!=='catalog')continue;const value=num(product[name]);if(value==null||value<0||value===row[field])continue;fields.push([field,value]);
   }
   if(!fields.length)continue;const before=clone(row);for(const [field,value]of fields)row[field]=value;
   // Only values actually linked to this catalog revision become save dependencies.
   const basis={productId:product.id||'product:'+product.name,productRev:product.rev??null};
   for(const [field,name]of [['cases','cases'],['plaster','kg']])if(row.unitSources?.[field]==='catalog'&&num(product[name])!=null&&num(product[name])>=0&&row[field]===num(product[name]))basis[name]=row[field];
   if(month.closedAt)basis.closedAt=month.closedAt;row.unitCatalogBasis=basis;row.rev=(row.rev||0)+1;changed=true;
   const event={id:id(),at,type:'관리 기준값 연결 반영',kind:'daily',month:key,before,after:clone(row),source:'관리'};state.changes??=[];state.changes.push(clone(event));month.history??=[];month.history.push(event);
  }
  if(changed){month.rev=(month.rev||0)+1;keys.push(key)}
 }
 return keys;
}
function normalize(book){
 if(!Array.isArray(book.sheets)||!book.sheets.some(s=>s.name==='관리'))throw Error('조형 데이터 관리 통합문서의 관리 시트를 찾지 못했습니다.');
 const master=book.sheets.find(s=>s.name==='관리'),products=managementProducts(master),scheduleAsOf=scheduleSourceDate(book.sheets);
 const workers=[];for(let r=9;r<60;r++){const w=text(val(master,'AQ'+r));if(w&&!/합계|평균|작업자/.test(w)&&!workers.includes(w))workers.push(w)}
 const issues=[],is=book.sheets.find(s=>s.name==='불출');if(is)for(let r=3;r<=10000;r++){let p=text(val(is,'C'+r)),d=num(val(is,'A'+r));if(p&&d>30000)issues.push({id:'issue:'+r,rev:1,date:serial(d),machine:text(val(is,'B'+r)),product:p,replacement:num(val(is,'D'+r)),issued:num(val(is,'E'+r)),reason:text(val(is,'G'+r)),source:'불출!'+r})}
 const months={};for(const s of book.sheets){const mt=/^(\d{2,4})년\s*(\d{1,2})월$/.exec(s.name);if(!mt)continue;const year=+mt[1]<100?2000+(+mt[1]):+mt[1],month=+mt[2],key=year+'-'+String(month).padStart(2,'0');let day=null,worker='',lot='';const rows=[],headerRows=[],unitInfo=catalogUnitSourceInfo(s);
 for(let r=9;r<=250;r++){const b=num(val(s,'B'+r));if(b>0&&b<32)day=b;const w=text(val(s,'C'+r));if(w)worker=w;const lt=text(val(s,'T'+r));if(lt)lot=lt;const explicit={day:val(s,'B'+r)!=null,worker:!!text(val(s,'C'+r)),hours:val(s,'D'+r)!=null,pours:val(s,'J'+r)!=null,lot:!!text(val(s,'T'+r))};const header=explicit.day||explicit.worker||explicit.hours;const p=text(val(s,'E'+r));if(header&&!p&&day)headerRows.push({id:key+':header:'+r,date:date(year,month,day),worker,hours:num(val(s,'D'+r)),explicit,header:true});if(!p||/합계|총계/.test(p)||!day)continue;const rec={id:key+':row:'+r,rev:1,explicit,header,sourceRow:r,date:date(year,month,day),worker,lot,source:s.name+'!'+r};for(const[c,f]of Object.entries(fields))if(!['day','worker','lot'].includes(f))rec[f]=['product','defectPart'].includes(f)?text(val(s,c+r)):num(val(s,c+r));const unitSources=catalogUnitSources(s,r,unitInfo);if(Object.keys(unitSources).length)rec.unitSources=unitSources;rec.original=Object.fromEntries(['M','N','O','P','Q','R'].map(c=>[c,num(val(s,c+r))]));rows.push(rec)}
 const modern=text(val(s,'U8'))==='품명'&&text(val(s,'AC8')).includes('재고');const stocks=[],plans=[],plaster=[];
 if(modern){for(const[name,op,prod,iss,cur]of [['AO','AT','AR','AS','AU'],['AV','BA','AY','AZ','BB']])for(let r=10;r<=200;r++){const p=text(val(s,name+r));if(!p||/합계|바디|림$/.test(p)&&p.length<4)continue;stocks.push({id:key+':stock:'+p,rev:1,product:p,opening:num(val(s,op+r)),production:num(val(s,prod+r)),deduction:num(val(s,iss+r)),current:num(val(s,cur+r)),source:s.name+'!'+op+r})}
 for(let r=10;r<=200;r++){const p=text(val(s,'U'+r));if(p)plans.push({id:key+':plan:'+r,rev:1,product:p,plan:num(val(s,'V'+r)),produced:num(val(s,'W'+r)),input:text(val(s,'X'+r)),sourceStart:num(val(s,'DI'+r)),sourceEnd:num(val(s,'DJ'+r)),previousPlan:num(val(s,'Y'+r)),previousProduced:num(val(s,'Z'+r)),source:s.name+'!U'+r})}
 for(let r=9;r<50;r++){const d=num(val(s,'BJ'+r));if(d>=1&&d<=31)plaster.push({id:key+':plaster:'+d,rev:1,date:date(year,month,d),used:num(val(s,'BK'+r)),actual:num(val(s,'BL'+r))})}}
 months[key]={id:key,rev:1,name:s.name,modern,closed:!Object.values(s.cells).some(c=>'f'in c),rows,headerRows,stocks,plans,plaster,issues:issues.filter(i=>i.date.startsWith(key)),summary:modern?{production:num(val(s,'W9')),kg:num(val(s,'AB9')),stock:num(val(s,'AD9')),stockKg:num(val(s,'AF9'))}:null,auditStamp:text(val(s,'DZ4'))};
 }
 const mem=book.sheets.find(s=>s.name==='_MemoMap'),memos=[];if(mem)for(let r=2;r<=1000;r++){const p=text(val(mem,'A'+r));if(p)memos.push({id:'memo:'+p,rev:1,product:p,values:['B','C','D','E'].map(c=>val(mem,c+r))})}
 const audit=book.sheets.find(s=>s.name==='몰드 실사');const counts=[];if(audit)for(let r=6;r<=500;r++){const p=text(val(audit,'B'+r));if(p&&!/합계/.test(p))counts.push({id:'count:'+r,rev:1,product:p,book:num(val(audit,'D'+r)),locations:['F','G','H','I','J'].map(c=>num(val(audit,c+r))),note:text(val(audit,'M'+r))})}
 const schedule=book.sheets.find(s=>s.name==='생산일정(요약)'),scheduleRows=[];if(schedule)for(let r=3;r<=1000;r++){const cells=Array.from({length:22},(_,i)=>val(schedule,col(i+1)+r));if(cells.some(v=>v!=null&&v!==''))scheduleRows.push({row:r,cells})}
 if(scheduleAsOf)for(const[key,m]of Object.entries(months))if(m.modern&&!m.closed&&key.slice(0,4)===scheduleAsOf.slice(0,4))m.scheduleAsOf=scheduleAsOf;
 return{schema:1,app:'johyeong-schedule',importedAt:new Date().toISOString(),source:book.source||'Excel',sourceHash:book.sha256||'',products,workers,months,memos,counts,locations:audit?['F','G','H','I','J'].map(c=>text(val(audit,c+'5'))):[],scheduleRows,scheduleHistory:savedSchedulePeriods(book.sheets,book.styles),scheduleDryHistory:savedScheduleDryMarkers(book.sheets),archive:book.sheets.map(s=>({name:s.name,state:s.state,cells:s.cells,merges:s.merges||[]})),changes:[]};
}
function inventory(state,key){const m=state.months[key];if(!m)return[];if(m.closed&&m.closeSnapshot?.inventory)return clone(m.closeSnapshot.inventory);const previous=m.openingSource&&m.openingSource<key?inventory(state,m.openingSource):[],names=new Set([...m.stocks,...m.rows,...m.issues,...previous].map(r=>r.product).filter(Boolean));return [...names].map(product=>{const ss=m.stocks.filter(s=>s.product===product);const opening=ss.length?sum(ss,s=>s.sourceType==='previous'?(previous.find(p=>p.product===product)?.current??(state.months[m.openingSource]?0:s.opening)):s.opening):(previous.find(p=>p.product===product)?.current??0);const production=sum(m.rows.filter(r=>r.product===product),r=>r.pours);const deduction=sum(m.issues.filter(r=>r.product===product),r=>r.replacement);const current=opening+production-deduction,kg=state.products.find(p=>p.name===product)?.kg;return{product,opening,production,deduction,current,kg:kg==null?null:current*kg,original:ss.some(s=>s.current!=null)?sum(ss,s=>s.current):null,source:ss.map(s=>s.source).join(', ')}})}
function completionValue(value){if(value==null)return null;if(!value||typeof value!=='object'||Array.isArray(value)||!['stock','plan-change','other'].includes(value.reason)||typeof value.note!=='string'||value.stockQty!=null&&(typeof value.stockQty!=='number'||!Number.isFinite(value.stockQty)||value.stockQty<0)||value.reason!=='stock'&&value.stockQty!=null)throw Error('완료 사유와 재고 활용 조수를 확인해 주세요.');return{reason:value.reason,note:value.note,stockQty:value.stockQty??null}}
function validateRecord(r){for(const f of['cases','plaster','pours','waterRatio','defectUnit','defectCount','fieldScrapKg','fieldDefQty','hours'])if(r[f]!=null&&(!Number.isFinite(r[f])||r[f]<0))throw Error('수량·시간에는 0 이상의 숫자를 입력해 주세요.');if(!iso(r.date)||!text(r.worker)||!text(r.product))throw Error('날짜·작업자·품명을 입력해 주세요.');if(r.missingPlan||r.plan!=null&&(!Number.isFinite(r.plan)||r.plan<0)||r.productionPlanQty!=null&&(!Number.isFinite(r.productionPlanQty)||r.productionPlanQty<=0))throw Error('계획수량을 확인해 주세요.');completionValue(r.productionCompletion);return true}
function updateDaily(state,key,row){const m=state.months[key];if(!m||m.closed)throw Error('마감된 월은 수정할 수 없습니다.');const i=m.rows.findIndex(x=>x.id===row.id),before=i<0?null:clone(m.rows[i]);const next={...before,...row,id:row.id||id(),rev:(before?.rev||0)+1};if(before?.plan>0&&next.plan===0&&next.productionPlanQty==null)next.productionPlanQty=before.plan;validateRecord(next);if(!next.date.startsWith(key))throw Error('선택한 월과 입력 날짜가 다릅니다.');if(Object.prototype.hasOwnProperty.call(next,'productionCompletion'))next.productionCompletion=completionValue(next.productionCompletion);if(next.productionCompletion&&root.SchedulePlanning){const staged={...state,months:{...state.months,[key]:{...m,rows:i<0?[...m.rows,next]:m.rows.map(r=>r.id===next.id?next:r)}}};if(root.SchedulePlanning.jobs(staged,key).filter(j=>j.records?.some(r=>r.id===next.id)).length!==1)throw Error('완료할 작업의 시작 계획 또는 연결을 확인해 주세요.')}if(i<0)m.rows.push(next);else m.rows[i]=next;m.rev++;const change={id:id(),at:new Date().toISOString(),type:'생산 입력',kind:'daily',month:key,before,after:clone(next)};state.changes??=[];state.changes.push(change);m.history??=[];m.history.push(clone(change));return next}
function workerStats(s,k){const m=s.months[k],all=[...m.rows,...(m.headerRows||[])],names=[...new Set(all.map(r=>r.worker).filter(Boolean))];return names.map(worker=>{const rows=all.filter(r=>r.worker===worker),headers=rows.filter(r=>r.header||r.explicit?.day||r.explicit?.worker||r.explicit?.hours),rawHours=sum(rows,r=>r.hours),max=Math.max(0,...headers.map(r=>r.hours||0)),adjusted=sum(headers,r=>r.hours)+max*headers.filter(r=>!r.hours).length-1.5*headers.length,explicit=rows.filter(r=>r.explicit?.worker),injectionDays=new Set(explicit.filter(r=>r.explicit?.day&&r.explicit?.hours&&r.explicit?.pours).map(r=>r.date)).size,qtyExplicit=sum(explicit,r=>r.pours),kg=sum(rows,r=>daily(r).plaster);return{worker,kg,quantity:sum(rows.filter(r=>!(r.product||'').includes('부속')),r=>r.pours),defectKg:sum(rows,r=>daily(r).defect),rawHours,workingDays:new Set(explicit.map(r=>r.date)).size,adjustedHours:adjusted,hourly:adjusted>0?kg/adjusted:null,cycle:qtyExplicit>0?(sum(explicit,r=>r.hours)-1.5*injectionDays)/qtyExplicit:null}})}
root.ScheduleCore={workerStats,text,num,col,ci,val,date,serial,iso,clone,id,daily,dailyQuality,dryDate,sum,managementProducts,catalogUnitSources,refreshCatalogUnits,scheduleSourceDate,savedSchedulePeriods,savedScheduleDryMarkers,normalize,inventory,completionValue,validateRecord,updateDaily};
if(typeof module!=='undefined')module.exports=root.ScheduleCore;
})(globalThis);
