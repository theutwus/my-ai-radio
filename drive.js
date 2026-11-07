/* Drive client: Drive API v3 + short-lived in-memory OAuth token. No private credentials in this file. */
(function(global) {
  'use strict';
  const API = 'https://www.googleapis.com/drive/v3/files';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|aif|aiff|ogg|oga|opus)$/i;
  const MAX_DEPTH = 24;
  const MAX_FOLDERS = 3000;
  const MAX_TRACKS = 12000;
  const MAX_BLOB_BYTES = 128 * 1024 * 1024;
  const MIME_BY_EXT = {mp3:'audio/mpeg',m4a:'audio/mp4',aac:'audio/aac',flac:'audio/flac',wav:'audio/wav',aif:'audio/aiff',aiff:'audio/aiff',ogg:'audio/ogg',oga:'audio/ogg',opus:'audio/ogg'};
  let token = '';
  let expiry = 0;
  function setToken(value, seconds) {
    token = String(value || '');
    expiry = token ? Date.now() + Math.max(0,Number(seconds || 3600) - 60)*1000 : 0;
  }
  function clearToken() { token=''; expiry=0; }
  function hasToken(){return Boolean(token) && Date.now() < expiry;}
  function getToken(){if(!hasToken()) throw new Error('Google接続の有効期限が切れました。「Googleに接続」で再認証してください。'); return token;}
  function fileMime(file) {const ext=(file.name.split('.').pop() || '').toLowerCase();return MIME_BY_EXT[ext] || (file.mimeType && file.mimeType.startsWith('audio/') ? file.mimeType : 'application/octet-stream');}
  function isAudio(file) {return file.mimeType?.startsWith('audio/') || AUDIO_EXT.test(file.name);}
  function escapeQuery(value){return String(value).replace(/\\/g,'\\\\').replace(/'/g,"\\'");}
  async function api(url, options={}){
    const response = await fetch(url, {method:'GET',...options,cache:'no-store',headers:{Authorization:`Bearer ${getToken()}`, ...(options.headers||{})}});
    if(!response.ok){let msg='';try{const payload=await response.json();msg=payload.error?.message || '';}catch{} 
      if(response.status===401) throw new Error('Googleの認証が失効しました。再接続してください。');
      if(response.status===403) throw new Error('Driveへのアクセスが拒否されました（403）。OAuth権限と共有設定を確認してください。 '+msg);
      throw new Error(`Drive API ${response.status}: ${msg || response.statusText}`);
    }
    return response;
  }
  async function list(query){
    const all=[];
    let pageToken='';
    do {
      const url=new URL(API);
      url.searchParams.set('q',query);
      url.searchParams.set('fields','nextPageToken,files(id,name,mimeType,size,modifiedTime,description,capabilities(canDownload)),incompleteSearch');
      url.searchParams.set('pageSize','1000');
      if(pageToken)url.searchParams.set('pageToken',pageToken);
      const data=await (await api(url.toString())).json();
      if(data.incompleteSearch) throw new Error('Google Driveの検索結果が不完全でした。再実行してください。');
      all.push(...(data.files||[]));
      pageToken=data.nextPageToken||'';
    }while(pageToken);
    return all;
  }
  async function findFoldersByName(name) {
    const result=await list(`name = '${escapeQuery(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`);
    return result.sort((a,b)=>a.name.localeCompare(b.name,'ja'));
  }
  async function scan(rootId,{onProgress}={}){
    if(!/^[\w-]{8,200}$/.test(rootId))throw new Error('フォルダIDが正しくありません。');
    const root=new URL(`${API}/${encodeURIComponent(rootId)}`);
    root.searchParams.set('fields','id,name,mimeType,trashed');
    const info=await (await api(root.toString())).json();
    if(info.mimeType!==FOLDER_MIME || info.trashed)throw new Error('指定したIDは利用可能なフォルダではありません。');
    const folders=[{id:rootId,path:info.name,depth:0}];
    const visited=new Set();
    const tracks=[];
    let skipped=0;
    while(folders.length) {
      const folder=folders.shift();
      if(visited.has(folder.id))continue;
      visited.add(folder.id);
      if(visited.size>MAX_FOLDERS)throw new Error(`フォルダが${MAX_FOLDERS}件を超えたので中断しました。`);
      const items=await list(`'${escapeQuery(folder.id)}' in parents and trashed = false`);
      for(const f of items) {
        if(f.mimeType===FOLDER_MIME){
          if(folder.depth>=MAX_DEPTH){skipped++;continue;}
          folders.push({id:f.id,path:`${folder.path}/${f.name}`,depth:folder.depth+1});
        }else if(isAudio(f)){
          if(tracks.length>=MAX_TRACKS)throw new Error(`音声ファイルが${MAX_TRACKS}件を超えたので中断しました。`);
          if(f.capabilities && f.capabilities.canDownload===false){skipped++;continue;}
          tracks.push({id:f.id,title:f.name.replace(/\.[^.]+$/,''),name:f.name,path:folder.path,kind:`Googleドライブ · ${folder.path}`,size:Number(f.size||0),mimeType:fileMime(f),modifiedTime:f.modifiedTime||'',source:'drive'});
        } else {skipped++;}
      }
      onProgress?.({folders:visited.size,tracks:tracks.length,remaining:folders.length});
    }
    tracks.sort((a,b)=>`${a.path}/${a.name}`.localeCompare(`${b.path}/${b.name}`,'ja'));
    return {tracks,folders:visited.size,skipped,rootName:info.name};
  }
  async function download(track,{signal}={}){
    if(track.size > MAX_BLOB_BYTES)throw new Error(`この曲は${Math.ceil(track.size/1024/1024)}MBです。試作版の安全上限（128MB）を超えています。`);
    const url=`${API}/${encodeURIComponent(track.id)}?alt=media`;
    const res=await api(url,{signal});
    const length=Number(res.headers.get('content-length')||0);
    if(length>MAX_BLOB_BYTES){res.body?.cancel();throw new Error('音声ファイルが128MBを超えるため取得を中断しました。');}
    // 0.2.0 compatible mode fetches the whole selected file, not byte-range playback.
    const blob=await res.blob();
    if(blob.size>MAX_BLOB_BYTES)throw new Error('音声ファイルが128MBを超えています。');
    if(blob.size===0)throw new Error('音声ファイルが空です。');
    return new Blob([blob],{type:track.mimeType||blob.type||'application/octet-stream'});
  }
  function extractFolderId(input){
    const s=String(input||'').trim();
    if(!s)return '';
    const match=s.match(/\/folders\/([\w-]+)/);
    if(match)return match[1];
    return /^[\w-]{8,200}$/.test(s)?s:'';
  }
  global.RadioDrive={setToken,clearToken,hasToken,getToken,findFoldersByName,scan,download,extractFolderId,MAX_BLOB_BYTES};
})(window);
