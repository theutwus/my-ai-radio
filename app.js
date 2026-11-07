(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const audio = el('player');
  const drive = window.RadioDrive;
  const samples = [
    {title:'オープニング（テスト）',kind:'AIトーク相当・短いテスト信号',url:'audio/01-opening.wav',source:'sample'},
    {title:'楽曲枠（テスト）',kind:'音楽相当・短いテスト信号',url:'audio/02-music.wav',source:'sample'},
    {title:'エンディング（テスト）',kind:'AIトーク相当・短いテスト信号',url:'audio/03-ending.wav',source:'sample'}
  ];
  const lines = [];
  const savedClientIdKey = 'ai-radio-oauth-client-id-v1';
  const savedFolderKey = 'ai-radio-folder-id-v1';
  let queue=samples.map(item=>({...item}));
  let driveTracks=[];
  let activeSource='sample';
  let index=0;
  let localUrls=[];
  let playingIntent=false;
  let loading=false;
  let serial=0;
  let lastProgress=-1;
  let oauthClient=null;
  let initialOAuthId='';
  let cached=new Map();
  let inFlight=new Map();
  let cacheEpoch=0;
  let lastPlaybackMode='compatible';

  function log(s){
    const ts=new Date().toLocaleTimeString('ja-JP',{hour12:false});
    lines.push(`[${ts}] ${s}`);
    if(lines.length>250)lines.shift();
    el('log').textContent=lines.slice(-90).join('\n');
    el('log').scrollTop=el('log').scrollHeight;
  }
  function fmt(t){if(!Number.isFinite(t)||t<0)return '0:00'; const n=Math.floor(t);return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;}
  function setMessage(msg,isError=false){el('drive-message').textContent=msg;el('drive-message').classList.toggle('error',isError);}
  function showConnected(connected){
    el('drive-status').textContent=connected?'接続済み（読み取り専用）':'未接続';
    el('disconnect').disabled=!connected;
    el('scan-drive').disabled=!connected;
  }
  function safeGetStorage(key){try{return localStorage.getItem(key)||'';}catch{return '';}}
  function safeSetStorage(key,value){try{localStorage.setItem(key,value);}catch{}}
  function setActive(mode){
    activeSource=mode;
    for(const name of ['sample','local','drive-mode'])el(name).classList.toggle('active',mode===({sample:'sample',local:'local','drive-mode':'drive'}[name]));
  }
  function render(){
    const current=queue[index];
    el('track-title').textContent=current?.title||'再生する音源がありません';
    el('track-kind').textContent=current?.kind||'音源を選択してください';
    el('queue-count').textContent=`${queue.length}項目`;
    el('toggle').textContent=loading?'読み込み中…':audio.paused?'▶ 再生':'Ⅱ 一時停止';
    el('toggle').disabled=loading||!queue.length;
    el('state').textContent=loading?'読込中':audio.paused?'停止中':'再生中';
    const term=el('filter').value.trim().toLocaleLowerCase();
    el('queue').replaceChildren();
    let shown=0, matched=0;
    queue.forEach((x,i)=>{
      if(term && !`${x.title} ${x.path||''}`.toLocaleLowerCase().includes(term))return;
      matched++;
      if(shown>=120)return;
      shown++;
      const li=document.createElement('li');if(i===index)li.className='current';
      const num=document.createElement('span');num.className='number';num.textContent=String(i+1);
      const name=document.createElement('span');name.className='track-name';name.textContent=x.title;
      if(x.path){const small=document.createElement('small');small.textContent=x.path;name.append(small);}
      const btn=document.createElement('button');btn.type='button';btn.textContent='この曲から';
      btn.addEventListener('click',()=>{playingIntent=true;void activate(i,true);});
      li.append(num,name,btn);el('queue').append(li);
    });
    const suffix=shown<matched?`（先頭${shown}曲を表示・検索で絞り込み）`:'';
    el('queue-summary').textContent=term?`検索結果 ${matched}曲 ${suffix}`:`${queue.length}項目 ${suffix}`;
    updateMedia();
  }
  function updateMedia(){
    if(!('mediaSession' in navigator)||!queue[index])return;
    try{
      navigator.mediaSession.metadata=new MediaMetadata({title:queue[index].title,artist:queue[index].source==='drive'?'My AI Radio / Google Drive':'My AI Radio',album:'Prototype 0.2.0'});
      navigator.mediaSession.playbackState=audio.paused?'paused':'playing';
    }catch(e){log(`MediaSession: ${e.message}`);}
  }
  function releaseLocal(){localUrls.forEach(url=>URL.revokeObjectURL(url));localUrls=[];}
  function releaseCache(){
    // Cancel downloads before releasing object URLs. A finished download from a
    // previous queue must never repopulate the next queue's private media cache.
    cacheEpoch++;
    for(const job of inFlight.values())job.abort.abort();
    inFlight.clear();
    for(const url of cached.values())URL.revokeObjectURL(url);
    cached.clear();
  }
  function resetAudio(){
    audio.pause();audio.removeAttribute('src');audio.load();
    el('seek').value='0';el('elapsed').textContent='0:00';el('duration').textContent='0:00';
  }
  function changeQueue(items,source){
    serial++;playingIntent=false;loading=false;
    resetAudio();releaseCache();
    queue=items.map(item=>({...item}));index=0;
    el('filter').value='';setActive(source);render();
  }
  function setSample(){changeQueue(samples,'sample');releaseLocal();log('サンプル音源に切り替え');}
  function switchDrive(){
    if(!driveTracks.length){setMessage('楽曲一覧を先に取得してください。',true);return;}
    changeQueue(driveTracks,'drive');releaseLocal();log(`Googleドライブ音源 ${queue.length}曲に切り替え`);
  }
  function sendTokenToSW(){
    if(!('serviceWorker' in navigator)||!drive.hasToken())return;
    const message={type:'DRIVE_TOKEN',token:drive.getToken()};
    try{navigator.serviceWorker.controller?.postMessage(message);}catch{}
    navigator.serviceWorker.ready.then(reg=>{try{reg.active?.postMessage(message);}catch{}}).catch(()=>{});
  }
  function clearSWToken(){
    if(!('serviceWorker' in navigator))return;
    try{navigator.serviceWorker.controller?.postMessage({type:'CLEAR_TOKEN'});}catch{}
    navigator.serviceWorker.ready.then(reg=>{try{reg.active?.postMessage({type:'CLEAR_TOKEN'});}catch{}}).catch(()=>{});
  }
  function ensureBlob(track){
    if(cached.has(track.id))return Promise.resolve(cached.get(track.id));
    if(inFlight.has(track.id))return inFlight.get(track.id).promise;
    const epoch=cacheEpoch;
    const abort=new AbortController();
    const promise=(async()=>{
      const blob=await drive.download(track,{signal:abort.signal});
      if(epoch!==cacheEpoch)throw new Error('別の音源一覧へ切り替わったため取得を中断しました。');
      const url=URL.createObjectURL(blob);
      cached.set(track.id,url);
      return url;
    })().finally(()=>{
      if(inFlight.get(track.id)?.promise===promise)inFlight.delete(track.id);
    });
    inFlight.set(track.id,{promise,abort});
    return promise;
  }
  function trimCache(){
    const currentId=queue[index]?.id;
    const nextId=queue[index+1]?.id;
    for(const [id,url] of cached.entries()){
      if(id!==currentId && id!==nextId){cached.delete(id);URL.revokeObjectURL(url);}
    }
  }
  function prefetchNext(){
    if(activeSource!=='drive'||el('playback-mode').value!=='compatible')return;
    const upcoming=queue[index+1];
    if(!upcoming||upcoming.size>25*1024*1024)return;
    void ensureBlob(upcoming).then(()=>{
      if(activeSource==='drive' && queue[index+1]?.id===upcoming.id){
        log(`次曲の先読み完了: ${upcoming.title}`);
        trimCache();
      }
    }).catch(e=>log(`次曲の先読み失敗: ${e.message}`));
  }
  async function mediaUrl(track){
    if(track.source!=='drive')return track.url;
    if(!drive.hasToken())throw new Error('Googleへの再接続が必要です。');
    if(el('playback-mode').value==='range'){
      if(!navigator.serviceWorker?.controller)throw new Error('ストリーミング実験モードにはService Workerが必要です。ページを再読み込みしてください。');
      sendTokenToSW();
      return new URL(`drive-media/${encodeURIComponent(track.id)}`,location.href).toString();
    }
    return ensureBlob(track);
  }
  async function beginPlay(){
    if(!queue.length)return;
    playingIntent=true;
    try{
      if('audioSession' in navigator)navigator.audioSession.type='playback';
      await audio.play();
      log(`再生開始: ${queue[index].title}`);
    }catch(e){playingIntent=false;log(`再生できません: ${e.name}: ${e.message}`);}
    render();
  }
  async function activate(nextIndex,autoplay){
    if(nextIndex<0||nextIndex>=queue.length){playingIntent=false;audio.pause();loading=false;render();return;}
    const requestNumber=++serial;
    playingIntent=Boolean(autoplay);
    loading=true;
    resetAudio();index=nextIndex;
    render();
    const track=queue[index];
    log(`音源切替: ${index+1}/${queue.length} ${track.title} [${document.visibilityState}]`);
    try{
      // 0.1.2 regression protection: local/sample loads and starts synchronously
      // within the original tap/ended handler, without awaiting an extra Promise.
      if(track.source!=='drive'){
        audio.src=track.url;audio.load();loading=false;render();
        if(autoplay && playingIntent)await beginPlay();
        return;
      }
      // A cached blob can be installed without waiting for a network promise.
      // This is especially important for audio transitions while iPhone is locked.
      const immediate=track.source==='drive' && el('playback-mode').value==='compatible' ? cached.get(track.id) : null;
      if(immediate){
        audio.src=immediate;audio.load();loading=false;render();
        if(autoplay && playingIntent)await beginPlay();
        trimCache();prefetchNext();
        return;
      }
      const url=await mediaUrl(track);
      if(serial!==requestNumber)return;
      audio.src=url;audio.load();loading=false;
      render();
      if(autoplay && playingIntent)await beginPlay();
      trimCache();
      if(activeSource==='drive')prefetchNext();
    }catch(e){
      if(serial!==requestNumber)return;
      loading=false;playingIntent=false;render();
      log(`音源取得失敗: ${e.message}`);
      if(activeSource==='drive')setMessage(`再生エラー：${e.message}。画面OFF中の次曲取得に失敗した場合は画面ONで再生を押してください。`,true);
    }
  }
  async function play(){
    if(!queue.length)return;
    if(audio.getAttribute('src')&&!loading){await beginPlay();return;}
    await activate(index,true);
  }
  async function next(){
    if(index+1>=queue.length){playingIntent=false;audio.pause();log('全音源の再生終了');render();return;}
    await activate(index+1,playingIntent);
  }
  function pause(){
    // Pause does not destroy the currently loaded media; this preserves lock-screen resume.
    playingIntent=false;
    audio.pause();log('手動で一時停止');render();
  }
  function handleGoogleToken(response){
    if(response.error){setMessage(`Google認証エラー：${response.error}`,true);log('Google認証失敗');return;}
    if(!response.access_token){setMessage('Googleからアクセストークンを受け取れませんでした。',true);return;}
    drive.setToken(response.access_token,response.expires_in);
    showConnected(true);sendTokenToSW();
    setMessage('Googleと接続しました。「楽曲一覧を取得」を押してください。');
    log('Google OAuth接続成功（アクセストークンはメモリ保持のみ）');
  }
  function onConnect(){
    const clientId=el('client-id').value.trim();
    if(!/^\d+-[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)){
      setMessage('Google Cloudで作成した「ウェブアプリケーション」のクライアントIDを入力してください。',true);return;
    }
    if(!window.google?.accounts?.oauth2){setMessage('Google認証ライブラリがまだ読み込まれていません。通信を確認し、再読み込みしてください。',true);return;}
    try{
      if(!oauthClient || initialOAuthId!==clientId){
        oauthClient=google.accounts.oauth2.initTokenClient({
          client_id:clientId,
          scope:'https://www.googleapis.com/auth/drive.readonly',
          callback:handleGoogleToken,
          error_callback:e=>{setMessage(`Google認証が中断されました: ${e.type||'error'}`,true);log(`OAuth popup error: ${e.type||'unknown'}`);}
        });
        initialOAuthId=clientId;
      }
      safeSetStorage(savedClientIdKey,clientId);
      oauthClient.requestAccessToken({prompt:drive.hasToken()?'':'consent'});
    }catch(e){setMessage(`Google認証を開始できません: ${e.message}`,true);}
  }
  function onDisconnect(){
    serial++;
    resetAudio();playingIntent=false;loading=false;
    const currentToken=drive.hasToken()?drive.getToken():'';
    drive.clearToken();clearSWToken();releaseCache();
    if(currentToken && window.google?.accounts?.oauth2?.revoke){
      try{google.accounts.oauth2.revoke(currentToken,()=>{});}catch{}
    }
    driveTracks=[];el('drive-mode').disabled=true;showConnected(false);
    changeQueue(samples,'sample');
    el('folder-chooser').hidden=true;
    setMessage('切断しました。Googleドライブの音声はこのページから再生できません。');
    log('Google接続を切断');
  }
  async function onScan(){
    if(!drive.hasToken()){showConnected(false);setMessage('Googleへ再接続してください。',true);return;}
    el('scan-drive').disabled=true;
    el('folder-chooser').hidden=true;
    try{
      const input=el('folder-id').value.trim();
      if(input && !drive.extractFolderId(input))throw new Error('フォルダURLまたはIDが正しくありません。');
      if(input){await scanFolder(drive.extractFolderId(input));return;}
      setMessage('AI-Radio-Music フォルダを検索しています…');
      const options=await drive.findFoldersByName('AI-Radio-Music');
      if(options.length===0)throw new Error('AI-Radio-Music が見つかりません。フォルダ名を確認するか、URLを入力してください。');
      if(options.length===1){await scanFolder(options[0].id);return;}
      const select=el('folder-select');select.replaceChildren();
      options.forEach((f,i)=>{const option=document.createElement('option');option.value=f.id;option.textContent=`候補${i+1}：${f.name}（ID末尾 ${f.id.slice(-6)}）`;select.append(option);});
      el('folder-chooser').hidden=false;
      setMessage('同名フォルダが複数あります。選択して「このフォルダを使う」を押してください。');
    }catch(e){setMessage(e.message,true);log(`楽曲一覧取得失敗: ${e.message}`);}finally{el('scan-drive').disabled=!drive.hasToken();}
  }
  async function scanFolder(folderId){
    el('scan-drive').disabled=true;
    try{
      const result=await drive.scan(folderId,{onProgress:p=>setMessage(`走査中：${p.folders}フォルダ・${p.tracks}曲、残り${p.remaining}フォルダ`)});
      driveTracks=result.tracks;
      safeSetStorage(savedFolderKey,folderId);el('folder-id').value=folderId;
      el('drive-mode').disabled=!driveTracks.length;
      el('folder-chooser').hidden=true;
      el('library-info').textContent=`${result.rootName}：${driveTracks.length}曲 / ${result.folders}フォルダ（対象外ファイル等 ${result.skipped}件）`;
      setMessage(`${result.rootName} 内の ${driveTracks.length}曲を取得しました。Googleドライブを選んで再生できます。`);
      log(`Drive走査成功: ${result.folders}フォルダ / ${driveTracks.length}曲`);
      if(driveTracks.length)switchDrive();
    }catch(e){setMessage(`走査失敗: ${e.message}`,true);log(`Drive走査失敗: ${e.message}`);}
    finally{el('scan-drive').disabled=!drive.hasToken();}
  }
  // Player: keep the proven 0.1.2 mediaSession action handlers and single <audio> element.
  el('toggle').addEventListener('click',()=>{if(audio.paused)void play();else pause();});
  el('prev').addEventListener('click',()=>{playingIntent=true;void activate(Math.max(0,index-1),true);});
  el('next').addEventListener('click',()=>{playingIntent=true;void next();});
  el('sample').addEventListener('click',setSample);
  el('local').addEventListener('click',()=>el('files').click());
  el('drive-mode').addEventListener('click',switchDrive);
  el('files').addEventListener('change',e=>{
    const files=Array.from(e.target.files||[]).filter(f=>f.type.startsWith('audio/')||/\.(mp3|aac|m4a|flac|wav|aif|aiff|ogg|oga|opus)$/i.test(f.name));
    if(!files.length){log('音声ファイルが選択されませんでした');return;}
    // Local object URLs are only revoked after audio has been detached from them.
    const newUrls=[];
    const items=files.map(f=>{const url=URL.createObjectURL(f);newUrls.push(url);return{title:f.name,kind:'端末から選択した音源',url,source:'local'};});
    changeQueue(items,'local');releaseLocal();localUrls=newUrls;
    log(`ローカル音源 ${items.length}件を読み込み`);
    e.target.value='';
  });
  audio.addEventListener('ended',()=>{log(`終了イベント: ${queue[index]?.title} [${document.visibilityState}]`);if(playingIntent)void next();});
  audio.addEventListener('timeupdate',()=>{
    el('elapsed').textContent=fmt(audio.currentTime);el('duration').textContent=fmt(audio.duration);
    if(Number.isFinite(audio.duration)&&audio.duration>0)el('seek').value=String(Math.floor(audio.currentTime/audio.duration*1000));
    if(Math.floor(audio.currentTime)!==lastProgress){lastProgress=Math.floor(audio.currentTime);if(lastProgress%10===0)log(`再生位置 ${fmt(audio.currentTime)} [${document.visibilityState}]`);}
  });
  audio.addEventListener('play',render);audio.addEventListener('pause',render);
  audio.addEventListener('error',()=>{const code=audio.error?.code||'?';log(`再生エラー code=${code} (モード: ${el('playback-mode').value})`);});
  el('seek').addEventListener('change',e=>{if(Number.isFinite(audio.duration))audio.currentTime=Number(e.target.value)/1000*audio.duration;});
  el('clear').addEventListener('click',()=>{lines.length=0;el('log').textContent='';});
  el('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(lines.join('\n'));log('ログをコピーしました');}catch{log('ログコピー不可。ブラウザのコピー権限を確認してください。');}});
  el('connect').addEventListener('click',onConnect);
  el('disconnect').addEventListener('click',onDisconnect);
  el('scan-drive').addEventListener('click',()=>void onScan());
  el('confirm-folder').addEventListener('click',()=>void scanFolder(el('folder-select').value));
  el('filter').addEventListener('input',render);
  el('playback-mode').addEventListener('change',()=>{
    const value=el('playback-mode').value;
    if(value===lastPlaybackMode)return;
    lastPlaybackMode=value;
    log(`再生方式を変更: ${value}`);
    if(activeSource==='drive'){changeQueue(driveTracks,'drive');setMessage('再生方式を変更しました。先頭の曲から再生してください。');}
  });
  document.addEventListener('visibilitychange',()=>log(`画面状態: ${document.visibilityState}`));
  window.addEventListener('online',()=>{el('net').textContent='オンライン';log('オンラインへ復帰');});
  window.addEventListener('offline',()=>{el('net').textContent='オフライン';log('オフラインへ移行');});
  if('mediaSession' in navigator){
    const tryAction=(name,fn)=>{try{navigator.mediaSession.setActionHandler(name,fn);}catch{}};
    tryAction('play',()=>{void play();});
    tryAction('pause',()=>{pause();});
    tryAction('previoustrack',()=>{void activate(Math.max(0,index-1),true);});
    tryAction('nexttrack',()=>{playingIntent=true;void next();});
  }
  el('net').textContent=navigator.onLine?'オンライン':'オフライン';
  el('mode').textContent=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone?'ホーム画面版':'ブラウザ版';
  el('client-id').value=safeGetStorage(savedClientIdKey);
  el('folder-id').value=safeGetStorage(savedFolderKey);
  el('queue').replaceChildren();
  render();
  log('Prototype 0.2.0 起動（Google Drive連携）');
  if('serviceWorker' in navigator&&location.protocol==='https:'){
    navigator.serviceWorker.register('./sw.js').then(()=>{
      log('Service Worker登録');
      if(drive.hasToken())sendTokenToSW();
    }).catch(e=>log(`SW登録不可: ${e.message}`));
    navigator.serviceWorker.addEventListener('controllerchange',()=>{if(drive.hasToken())sendTokenToSW();});
  }
})();
