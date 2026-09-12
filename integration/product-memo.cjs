'use strict';
const crypto=require('node:crypto');
const MAX_MEMO_LENGTH=100000,own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key),clean=value=>String(value??'').trim(),clone=value=>JSON.parse(JSON.stringify(value));
function failure(code,message,details={}){return Object.assign(Error(message),{code,...details})}
function memoText(value){
 if(value==null)return'';
 if(!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw failure('invalid-memo-data','품목 메모의 저장 형식을 확인해 주세요.');
 const memo=String(value);if(memo.length>MAX_MEMO_LENGTH)throw failure('invalid-memo-data','품목 메모의 길이를 확인해 주세요.');return memo;
}
// The selected product uses its stable catalog ID. Its memo uses only the
// current name, matching management memoFind; old-name memo rows stay untouched.
function productMemoIndex(products,memos=[],suppliedIndex){
 if(!Array.isArray(products)||!Array.isArray(memos))throw failure('invalid-catalog','품목과 메모 원장 형식을 확인해 주세요.');
 let ix;try{ix=suppliedIndex||require('./ilbo-sync.cjs').productIndex(products)}catch{throw failure('ambiguous-product','품목 ID와 이름의 중복을 확인해 주세요.')}
 const groups=new Map(),names=new Map([...ix.ids.values()].map(product=>[clean(product.name),product]));
 for(let recordIndex=0;recordIndex<memos.length;recordIndex++){
  const record=memos[recordIndex];if(!record||typeof record!=='object'||Array.isArray(record))throw failure('invalid-memo-data','품목 메모 원장 형식을 확인해 주세요.');if(record.deleted)continue;
  const product=names.get(clean(record.product));if(!product)continue;
  if(!groups.has(product.id))groups.set(product.id,[]);
  groups.get(product.id).push({record,recordIndex});
 }
 return{get(productId){
  const product=ix.ids.get(productId);if(!product)throw failure('unknown-product','현재 등록된 품목을 선택해 주세요.',{productId});
  const matches=groups.get(productId)||[];
  if(matches.length>1)throw failure('ambiguous-memo','같은 품목의 메모가 중복되어 확인이 필요합니다.',{productId});
  const selected=matches[0],record=selected?.record;if(record?.values!=null&&!Array.isArray(record.values))throw failure('invalid-memo-data','품목 메모의 저장 형식을 확인해 주세요.',{productId});
  return{productId,memo:memoText(record?.values?.[0]),record:record||null,recordIndex:selected?.recordIndex??-1,revision:record?.rev??null};
 }};
}
function resolveProductMemo(products,memos,productId,ix){return productMemoIndex(products,memos,ix).get(productId)}
function editProductMemo(envelope,input){
 if(!envelope||envelope.schema!==1||!Array.isArray(envelope.records)||envelope.records.some(record=>!record||typeof record!=='object'||Array.isArray(record))||envelope.records.filter(record=>record.kind==='catalog'&&record.id==='catalog'&&!record.deleted).length!==1)throw failure('invalid-catalog','관리 원장 형식을 확인해 주세요.');
 if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.productId!=='string'||!input.productId.trim()||input.productId.length>500||!own(input,'baseMemo')||!own(input,'memo')||typeof input.baseMemo!=='string'||typeof input.memo!=='string'||input.baseMemo.length>MAX_MEMO_LENGTH||input.memo.length>MAX_MEMO_LENGTH)throw failure('invalid-memo-input','품목과 메모 입력 형식·길이를 확인해 주세요.');
 const products=envelope.records.filter(record=>record.kind==='products'),memos=envelope.records.filter(record=>record.kind==='memos'),current=resolveProductMemo(products,memos,input.productId),local=input.memo,base=input.baseMemo;
 if(current.memo!==base&&current.memo!==local&&local!==base)throw failure('memo-conflict','공용 메모가 다른 곳에서 변경되었습니다. 최신 내용을 확인해 주세요.',{productId:input.productId,currentMemo:current.memo});
 const result={envelope:clone(envelope),productId:input.productId,memo:current.memo,changed:false,revision:current.revision};
 if(local===base||local===current.memo)return result;
 const previous=current.record,ids=new Set(envelope.records.map(record=>record.id));let record;
 if(previous){
  if(typeof previous.id!=='string'||!previous.id||envelope.records.filter(row=>row.id===previous.id).length!==1)throw failure('ambiguous-memo','메모의 고유 ID가 중복되거나 없습니다.',{productId:input.productId});
  const rev=previous.rev==null?0:Number(previous.rev);if(!Number.isSafeInteger(rev)||rev<0||rev===Number.MAX_SAFE_INTEGER)throw failure('invalid-memo-data','메모 저장 버전을 확인해 주세요.',{productId:input.productId});
  record=result.envelope.records[envelope.records.indexOf(previous)];record.values=record.values||[];record.values[0]=local;record.rev=rev+1;
 }else{
  const prefix='memo:product:'+crypto.createHash('sha256').update(input.productId).digest('hex');let id=prefix,suffix=0;while(ids.has(id))id=prefix+':'+(++suffix);
  const product=products.find(product=>product.id===input.productId&&!product.deleted);record={id,kind:'memos',product:product.name,values:[local,'','',null],rev:1};result.envelope.records.push(record);
 }
 return{...result,memo:local,changed:true,revision:record.rev};
}
module.exports={MAX_MEMO_LENGTH,productMemoIndex,resolveProductMemo,editProductMemo};
