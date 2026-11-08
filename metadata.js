/* My AI Radio: local-only music catalogue. No Google credentials stored. */
(function(global){
'use strict';
const DB_NAME='ai-radio-music-meta-v1';
const STORE='tracks';
const PREFS='preferences';
const dec=new TextDecoder('utf-8',{fatal:false});
const latin=new TextDecoder('iso-8859-1');
const u32=(d,p)=>((d[p]*16777216)+(d[p+1]<<16)+(d[p+2]<<8)+d[p+3])>>>0;
const synchsafe=(d,p)=>((d[p]&127)*2097152)+((d[p+1]&127)<<14)+((d[p+2]&127)<<7)+(d[p+3]&127);
function str(b,encoding){
  if(!b||!b.length)return '';
  const code=encoding===undefined?3:encoding;
  let s='';
  try{
    if(code===0)s=latin.decode(b);
    else if(code===1)s=new TextDecoder(b[0]===0xfe&&b[1]===0xff?'utf-16be':'utf-16le').decode(b.subarray(b[0]===0xfe||b[0]===0xff?2:0));
    else if(code===2)s=new TextDecoder('utf-16be').decode(b);
    else s=dec.decode(b);
  }catch{s=dec.decode(b);}
  return s.replace(/\0/g,'').trim().slice(0,500);
}
function id3(data){
 const result={};if(data.length<10||String.fromCharCode(...data.subarray(0,3))!=='ID3')return result;
 const version=data[3],size=Math.min(data.length,10+synchsafe(data,6));
 if(version!==3&&version!==4)return result;
 const map={TIT2:'title',TPE1:'artist',TALB:'album',TCON:'genre',TDRC:'year',TYER:'year'};
 let p=10;
 while(p+10<=size){let id=String.fromCharCode(...data.subarray(p,p+4));if(!/^[A-Z0-9]{4}$/.test(id))break;
 const len=version===4?synchsafe(data,p+4):u32(data,p+4);if(!len||p+10+len>size)break;
 if(map[id]&&!(data[p+9]&0x08)){
  const bytes=data.subarray(p+10,p+10+len);const v=str(bytes.subarray(1),bytes[0]);if(v)result[map[id]]=v;
 }p+=10+len;
 }
 return result;
}
function flac(data){
 const result={};if(data.length<8||String.fromCharCode(...data.subarray(0,4))!=='fLaC')return result;
 let p=4;const labels={TITLE:'title',ARTIST:'artist',ALBUM:'album',GENRE:'genre',DATE:'year'};
 while(p+4<=data.length){const header=data[p],kind=header&127,len=(data[p+1]<<16)+(data[p+2]<<8)+data[p+3];p+=4;
 if(p+len>data.length)break;
 if(kind===4){let n=p;const end=p+len;const readLE=()=>{const v=(data[n]|(data[n+1]<<8)|(data[n+2]<<16)|(data[n+3]*16777216))>>>0;n+=4;return v;};
 if(n+4>end)break;let vendor=readLE();n+=vendor;if(n+4>end)break;
 let count=Math.min(readLE(),1000);
 for(let i=0;i<count&&n+4<=end;i++){const size=readLE();if(n+size>end)break;const item=dec.decode(data.subarray(n,n+size));n+=size;const pos=item.indexOf('=');if(pos<0)continue;const key=labels[item.slice(0,pos).toUpperCase()];if(key&&!result[key])result[key]=item.slice(pos+1).slice(0,500);}
 }
 p+=len;if(header&128)break;
 }return result;
}
function mp4(data){
 const result={};const labels={'©nam':'title','©ART':'artist','aART':'artist','©alb':'album','©gen':'genre','©day':'year'};
 // Iterate ISO-BMFF atoms. Only descend through known container boxes, rather than
 // searching raw binary for tag names (which could misidentify album artwork bytes).
 function parse(start,end,depth){if(depth>12)return;
 let p=start;while(p+8<=end){let len=u32(data,p),type=latin.decode(data.subarray(p+4,p+8)),header=8;
 if(len===1){if(p+16>end)break;const high=u32(data,p+8),low=u32(data,p+12);if(high)break;len=low;header=16;}
 if(len===0)len=end-p;if(len<header||p+len>end)break;
 if(labels[type]){
  let d=p+header;while(d+16<=p+len){const n=u32(data,d),t=latin.decode(data.subarray(d+4,d+8));if(n<16||d+n>p+len)break;
   if(t==='data' && !result[labels[type]]){const bytes=data.subarray(d+16,d+n);const s=str(bytes,3);if(s)result[labels[type]]=s;}d+=n;
  }
 }else if(['moov','udta','meta','ilst','trak','mdia','minf','stbl'].includes(type)){
  parse(p+header+(type==='meta'?4:0),p+len,depth+1);
 }p+=len;
 }}parse(0,data.length,0);return result;
}
function parse(bytes,mime,name){
 const arr=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);const lower=(name||'').toLowerCase();
 let tags={};
 if(lower.endsWith('.mp3')||mime==='audio/mpeg')tags=id3(arr);
 else if(lower.endsWith('.flac'))tags=flac(arr);
 else if(/\.(m4a|mp4)$/i.test(lower)||mime==='audio/mp4')tags=mp4(arr);
 return tags;
}
function open(){return new Promise((resolve,reject)=>{
 if(!global.indexedDB){reject(new Error('このブラウザではIndexedDBを利用できません'));return;}
 const request=indexedDB.open(DB_NAME,2);
 request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'id'});if(!db.objectStoreNames.contains(PREFS))db.createObjectStore(PREFS,{keyPath:'id'});};
 request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error||new Error('DB unavailable'));
 });}
async function getAll(){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readonly'),r=tx.objectStore(STORE).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error);tx.oncomplete=()=>db.close();tx.onerror=()=>{db.close();reject(tx.error);};});}
async function put(record){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(record);tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(tx.error);};});}
async function removeAll(){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).clear();tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(tx.error);};});}
async function getPreferences(){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction(PREFS,'readonly');const req=tx.objectStore(PREFS).getAll();req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);tx.oncomplete=()=>db.close();tx.onerror=()=>{db.close();reject(tx.error);};});}
async function savePreference(id,enabled){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction(PREFS,'readwrite');tx.objectStore(PREFS).put({id,enabled:!!enabled,updatedAt:new Date().toISOString()});tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(tx.error);};});}
// Only call after a fully successful Drive scan; errors must never mark items missing.
// Old 0.3.0 records without rootId are preserved, never automatically deleted.
function planReconciliation(previous,tracks,rootId){
 if(!rootId)throw new Error('rootId required');
 const prior=new Map(previous.map(r=>[r.id,r]));
 const present=new Set(tracks.map(t=>t.id));const updates=[];let added=0,changed=0,missing=0,restored=0;
 const now=new Date().toISOString();
 for(const t of tracks){const old=prior.get(t.id);if(!old){
   updates.push({...infer(t),id:t.id,name:t.name,path:t.path,mimeType:t.mimeType,size:t.size,modifiedTime:t.modifiedTime,rootId,available:true,tagAnalyzed:false,origin:'folder / filename',indexedAt:now});added++;
 }else{
   const modified=old.modifiedTime!==t.modifiedTime||old.size!==t.size;
   if(modified)changed++;if(old.available===false)restored++;
   updates.push({...old,id:t.id,name:t.name,path:t.path,mimeType:t.mimeType,size:t.size,modifiedTime:t.modifiedTime,rootId,available:true,tagAnalyzed:modified?false:!!(old.tagAnalyzed||old.analyzedAt),...(modified?{origin:'folder / filename',title:infer(t).title,artist:infer(t).artist,album:infer(t).album,genre:'',year:'',analyzedAt:null}:{}),indexedAt:now});
 }}
 for(const old of previous){if(old.rootId===rootId && old.available!==false && !present.has(old.id)){updates.push({...old,available:false,indexedAt:now});missing++;}}
 return {updates,stats:{added,changed,missing,restored,total:tracks.length}};
}
async function reconcile(tracks,rootId){
 const previous=await getAll();
 const {updates,stats}=planReconciliation(previous,tracks,rootId);
 const db=await open();await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');const store=tx.objectStore(STORE);for(const rec of updates)store.put(rec);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('transaction aborted'));});db.close();
 return stats;
}
function infer(track){
 const parts=String(track.path||'').split('/').filter(Boolean);
 return {title:track.title||track.name?.replace(/\.[^.]+$/,'')||'不明',artist:parts.length>=2?parts[1]:'',album:parts.length>=3?parts[2]:'',genre:'',year:'',origin:'folder / filename'};
}
function merge(track,existing,tags){const fallback=infer(track);
 const result={...fallback,...(existing||{}),...tags,id:track.id,name:track.name,path:track.path,mimeType:track.mimeType,size:track.size,modifiedTime:track.modifiedTime,tagAnalyzed:true,available:true,origin:Object.keys(tags||{}).length?'embedded tags':(existing?.origin||fallback.origin),analyzedAt:new Date().toISOString()};
 return result;
}
global.RadioMetadata={parse,open,getAll,put,removeAll,getPreferences,savePreference,reconcile,planReconciliation,infer,merge};
if(typeof module!=='undefined'&&module.exports)module.exports=global.RadioMetadata;
})(typeof window!=='undefined'?window:globalThis);
