// music.js — 内置音乐播放器（系统当前音乐控制 + 旋转封面）
import { db } from './db.js';
import { toast } from './utils.js';

let audio=null, tracks=[], idx=0, coverURL=null, objectURLs=[];

export function initMusic(){
  audio=document.getElementById('audio');
  audio.volume = (+document.getElementById('music-vol').value)/100;

  document.getElementById('music-play').onclick = togglePlay;
  document.getElementById('music-next').onclick = ()=> step(1);
  document.getElementById('music-prev').onclick = ()=> step(-1);
  document.getElementById('music-vol').oninput = e=>{ audio.volume=e.target.value/100; };
  document.getElementById('music-import').onclick = importMusic;
  document.getElementById('music-close').onclick = ()=> document.getElementById('music-bar').hidden=true;
  document.getElementById('btn-music').onclick = ()=>{
    const bar=document.getElementById('music-bar');
    bar.hidden=!bar.hidden;
    if(!bar.hidden && !tracks.length) toast('点击「📁 导入」选择音乐目录');
  };
  audio.onended = ()=> step(1);
  audio.onplay = spinCover(true);
  audio.onpause = spinCover(false);

  loadLib();
}

async function loadLib(){
  const lib = await db.get('music','lib');
  if(lib){
    tracks = lib.tracks||[];
    objectURLs.forEach(u=>URL.revokeObjectURL(u)); objectURLs=[];
    tracks.forEach(t=>{ const u=URL.createObjectURL(t.data); objectURLs.push(u); });
    if(lib.cover){ coverURL=URL.createObjectURL(lib.cover); setCover(coverURL); }
    if(tracks.length) load(idx, false);
  }
}

async function importMusic(){
  // 桌面端：Electron 原生目录对话框
  if(window.electronAPI && window.electronAPI.openMusicDirectory){
    let res;
    try{
      const lastDir = (window.electronAPI.getSetting && await window.electronAPI.getSetting('lastMusicDir')) || '';
      res = await window.electronAPI.openMusicDirectory(lastDir);
    }catch(e){ return; }
    if(!res || !res.tracks.length){ toast('目录内未找到音频文件'); return; }
    if(res.dir && window.electronAPI.setSetting) await window.electronAPI.setSetting('lastMusicDir', res.dir);
    const tracksData = res.tracks.map(t=>({name:t.name, data:new Blob([t.data])}));
    const cover = res.cover ? new Blob([res.cover]) : null;
    await applyPlaylist(tracksData, cover);
    return;
  }
  // 浏览器端：File System Access API
  if(!('showDirectoryPicker' in window)){ alert('请使用 Chrome / Edge 打开本应用以导入音乐目录。'); return; }
  let dir; try{ dir=await window.showDirectoryPicker(); }catch(e){ return; }
  const aud=[], imgs=[];
  for await (const [name,handle] of dir.entries()){
    if(handle.kind!=='file') continue;
    if(/\.(mp3|flac|wav|ogg|m4a|aac)$/i.test(name)) aud.push({name,handle});
    else if(/\.(jpg|jpeg|png|webp)$/i.test(name)) imgs.push({name,handle});
  }
  if(!aud.length){ toast('目录内未找到音频文件'); return; }
  // 封面：优先 cover/folder/album，否则第一张图
  const coverHit = imgs.find(f=>/^(cover|folder|album|front)/i.test(f.name)) || imgs[0];
  const tracksData=[];
  for(const f of aud){
    const file=await f.handle.getFile();
    tracksData.push({name:file.name, data:file});
  }
  const cover = coverHit ? await (await coverHit.handle.getFile()) : null;
  await applyPlaylist(tracksData, cover);
}

async function applyPlaylist(tracksData, cover){
  await db.put('music',{id:'lib', tracks:tracksData, cover});
  await loadLib();
  idx=0; load(0,true);
  toast(`已导入 ${tracksData.length} 首，封面：${cover?'已识别':'默认'}`);
}

function load(i, autoplay){
  idx=(i+tracks.length)%tracks.length;
  audio.src=objectURLs[idx];
  document.getElementById('music-title').textContent=tracks[idx].name.replace(/\.[^.]+$/,'');
  document.getElementById('music-sub').textContent=`第 ${idx+1} / ${tracks.length} 首`;
  if(autoplay) audio.play().catch(()=>{});
}
function togglePlay(){
  if(!tracks.length){ toast('请先导入音乐'); return; }
  if(audio.paused) audio.play().catch(()=>{}); else audio.pause();
}
function step(d){ if(!tracks.length) return; load(idx+d, !audio.paused); }

// 供系统托盘调用
export function trayControl(cmd){
  if(cmd==='toggle') togglePlay();
  else if(cmd==='next') step(1);
  else if(cmd==='prev') step(-1);
}
function setCover(url){
  const cover=document.getElementById('music-cover');
  cover.innerHTML='';
  const img=new Image(); img.src=url; img.onerror=()=>{cover.innerHTML='<div class="cover-fallback">♪</div>';};
  cover.appendChild(img);
}
function spinCover(on){
  return ()=>{ document.getElementById('music-cover').classList.toggle('spinning', on && !audio.paused); };
}
