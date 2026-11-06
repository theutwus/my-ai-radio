const CACHE='ai-radio-phase0-v1';
const ASSETS=['./','./index.html','./style.css','./app.js','./manifest.webmanifest','./audio/01-opening.wav','./audio/02-music.wav','./audio/03-ending.wav','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{const r=event.request;if(r.method!=='GET'||new URL(r.url).origin!==self.location.origin)return;event.respondWith(fetch(r).then(res=>{if(res.ok&&!r.headers.has('range')){const cloned=res.clone();caches.open(CACHE).then(c=>c.put(r,cloned));}return res;}).catch(()=>caches.match(r)));});
