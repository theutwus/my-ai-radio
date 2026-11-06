(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const audio = el('player');
  const samples = [
    {title:'オープニング（テスト）', kind:'AIトーク相当・短いテスト信号',url:'audio/01-opening.wav'},
    {title:'楽曲枠（テスト）',kind:'音楽相当・短いテスト信号',url:'audio/02-music.wav'},
    {title:'エンディング（テスト）',kind:'AIトーク相当・短いテスト信号',url:'audio/03-ending.wav'}
  ];
  let queue = samples.map(x => ({...x})), index = 0, localUrls=[], playingIntent=false, lastProgress=-1;
  const lines=[];
  function log(s){const t=new Date().toLocaleTimeString('ja-JP',{hour12:false});lines.push(`[${t}] ${s}`);if(lines.length>250)lines.shift();el('log').textContent=lines.slice(-90).join('\n');el('log').scrollTop=el('log').scrollHeight;}
  function fmt(t){if(!Number.isFinite(t))return '0:00';const n=Math.floor(t);return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;}
  function render(){el('track-title').textContent=queue[index]?.title||'再生する音源がありません';el('track-kind').textContent=queue[index]?.kind||'音源を選択してください';el('queue-count').textContent=`${queue.length}項目`;el('toggle').textContent=audio.paused?'▶ 再生':'Ⅱ 一時停止';el('state').textContent=audio.paused?'停止中':'再生中';el('queue').replaceChildren();queue.forEach((x,i)=>{const li=document.createElement('li');if(i===index)li.className='current';const num=document.createElement('span');num.className='number';num.textContent=String(i+1);const name=document.createElement('span');name.className='track-name';name.textContent=x.title;const btn=document.createElement('button');btn.textContent='この曲から';btn.type='button';btn.addEventListener('click',()=>startAt(i,true));li.append(num,name,btn);el('queue').append(li);});updateMedia();}
  function updateMedia(){if(!('mediaSession' in navigator)||!queue[index])return;try{navigator.mediaSession.metadata=new MediaMetadata({title:queue[index].title,artist:'My AI Radio',album:'Phase 0 Test'});navigator.mediaSession.playbackState=audio.paused?'paused':'playing';}catch(e){log(`MediaSession: ${e.message}`);}}
  async function play(){if(!queue.length)return;playingIntent=true;try{if('audioSession' in navigator)navigator.audioSession.type='playback';if(!audio.getAttribute('src'))load(index);await audio.play();log(`再生開始: ${queue[index].title}`);}catch(e){playingIntent=false;log(`再生できません: ${e.name}: ${e.message}`);}render();}
  function load(i){if(!queue[i])return;index=i;audio.src=queue[i].url;audio.load();el('seek').value='0';el('elapsed').textContent='0:00';el('duration').textContent='0:00';log(`音源切替: ${index+1}/${queue.length} ${queue[i].title} [${document.visibilityState}]`);render();}
  async function startAt(i,autoplay){load(i);if(autoplay)await play();}
  async function next(){if(index+1>=queue.length){playingIntent=false;audio.pause();log('全音源の再生終了');render();return;}load(index+1);if(playingIntent)await play();}
  function releaseLocal(){localUrls.forEach(url=>URL.revokeObjectURL(url));localUrls=[];}
  function setSample(){audio.pause();playingIntent=false;releaseLocal();queue=samples.map(x=>({...x}));el('sample').classList.add('active');el('local').classList.remove('active');load(0);}
  el('toggle').addEventListener('click',async()=>{if(audio.paused){await play();}else{playingIntent=false;audio.pause();log('手動で一時停止');render();}});
  el('prev').addEventListener('click',()=>startAt(Math.max(0,index-1),true));el('next').addEventListener('click',()=>{playingIntent=true;void next();});
  el('sample').addEventListener('click',setSample);el('local').addEventListener('click',()=>el('files').click());
  el('files').addEventListener('change',e=>{const files=Array.from(e.target.files||[]).filter(f=>f.type.startsWith('audio/')||/\.(mp3|aac|m4a|wav|ogg)$/i.test(f.name));if(!files.length){log('音声ファイルが選択されませんでした');return;}audio.pause();playingIntent=false;releaseLocal();queue=files.map(f=>{const url=URL.createObjectURL(f);localUrls.push(url);return{title:f.name,kind:'端末から選択した音源',url};});el('local').classList.add('active');el('sample').classList.remove('active');load(0);log(`ローカル音源 ${queue.length}件を読み込み`);e.target.value='';});
  audio.addEventListener('ended',()=>{log(`終了イベント: ${queue[index]?.title} [${document.visibilityState}]`);if(playingIntent)void next();});
  audio.addEventListener('timeupdate',()=>{el('elapsed').textContent=fmt(audio.currentTime);el('duration').textContent=fmt(audio.duration);if(Number.isFinite(audio.duration)&&audio.duration>0)el('seek').value=String(Math.floor(audio.currentTime/audio.duration*1000));if(Math.floor(audio.currentTime)!==lastProgress){lastProgress=Math.floor(audio.currentTime);if(lastProgress%5===0)log(`再生位置 ${fmt(audio.currentTime)} [${document.visibilityState}]`);}});
  audio.addEventListener('play',render);audio.addEventListener('pause',render);audio.addEventListener('error',()=>{const code=audio.error?.code||'?';log(`再生エラー code=${code} URL=${queue[index]?.url}`);});
  el('seek').addEventListener('change',e=>{if(Number.isFinite(audio.duration))audio.currentTime=Number(e.target.value)/1000*audio.duration;});
  el('clear').addEventListener('click',()=>{lines.length=0;el('log').textContent='';});
  el('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(lines.join('\n'));log('ログをコピーしました');}catch{log('クリップボードにコピーできませんでした');}});
  document.addEventListener('visibilitychange',()=>log(`画面状態: ${document.visibilityState}`));
  window.addEventListener('online',()=>{el('net').textContent='オンライン';log('オンラインへ復帰');});window.addEventListener('offline',()=>{el('net').textContent='オフライン';log('オフラインへ移行');});
  if('mediaSession' in navigator){const tryAction=(name,fn)=>{try{navigator.mediaSession.setActionHandler(name,fn);}catch{}};tryAction('play',()=>{void play();});tryAction('pause',()=>{playingIntent=false;audio.pause();render();});tryAction('previoustrack',()=>{void startAt(Math.max(0,index-1),true);});tryAction('nexttrack',()=>{playingIntent=true;void next();});}
  el('net').textContent=navigator.onLine?'オンライン':'オフライン';el('mode').textContent=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone?'ホーム画面版':'ブラウザ版';
  load(0);log('Prototype 0.1.0 起動');
  if('serviceWorker' in navigator && location.protocol==='https:')navigator.serviceWorker.register('./sw.js').then(()=>log('Service Worker登録')).catch(e=>log(`SW登録不可: ${e.message}`));
})();
