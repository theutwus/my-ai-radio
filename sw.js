// My AI Radio 0.2.0. Page/player media events are intentionally handled in app.js (0.1.2 behavior).
const CACHE='ai-radio-0.2.0-v2';
const ASSETS=['./','./index.html','./style.css','./app.js','./drive.js','./manifest.webmanifest','./audio/01-opening.wav','./audio/02-music.wav','./audio/03-ending.wav','./icons/icon-192.png','./icons/icon-512.png'];
let mediaToken=''; // Memory only. Never cache or persist private audio or credentials.
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('message',event=>{
  if(event.data?.type==='DRIVE_TOKEN' && typeof event.data.token==='string')mediaToken=event.data.token;
  if(event.data?.type==='CLEAR_TOKEN')mediaToken='';
});
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;
  const scopePath=new URL(self.registration.scope).pathname;
  const mediaPrefix=scopePath+'drive-media/';
  if(url.pathname.startsWith(mediaPrefix)){
    const id=decodeURIComponent(url.pathname.slice(mediaPrefix.length));
    event.respondWith(streamDrive(id,request));
    return;
  }
  // Previous test's network-first caching behavior is preserved for same-origin static files.
  event.respondWith(fetch(request).then(response=>{
    if(response.ok&&!request.headers.has('range')){
      const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy));
    }
    return response;
  }).catch(()=>caches.match(request)));
});
async function streamDrive(id,request){
  if(!/^[\w-]{8,200}$/.test(id))return new Response('invalid file id',{status:400});
  if(!mediaToken)return new Response('token not available in Service Worker',{status:401});
  const headers=new Headers({Authorization:`Bearer ${mediaToken}`});
  const range=request.headers.get('range');
  if(range)headers.set('Range',range);
  try{
    const response=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`,{headers,redirect:'follow',cache:'no-store'});
    if(!response.ok)return new Response('Google Drive media request failed',{status:response.status});
    const responseHeaders=new Headers();
    for(const header of ['content-type','content-length','content-range','accept-ranges','etag']){
      const value=response.headers.get(header);if(value)responseHeaders.set(header,value);
    }
    if(!responseHeaders.has('content-type'))responseHeaders.set('content-type','application/octet-stream');
    responseHeaders.set('Cache-Control','private, no-store');
    return new Response(response.body,{status:response.status,headers:responseHeaders});
  }catch(e){return new Response('media proxy request failed',{status:502});}
}
