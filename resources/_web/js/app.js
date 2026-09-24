// app.js — 入口：装配各模块、状态栏、设置、键盘交互
import { db, getSetting, setSetting } from './db.js';
import * as library from './library.js';
import * as reader from './reader.js';
import * as music from './music.js';
import { pickAndImport, scanAndImport, clearImportedPathCache } from './import.js';
import { resetAchievements, reconcileFinished, initAchievements } from './achievements.js';
import { toast, debounce } from './utils.js';

const THEMES = ['light','dark','green','immersive'];

// 隔离式装配：单个模块出错只告警，不影响其它交互（防止一处异常让整页"点不动"）
function safe(label, fn){
  try { fn(); }
  catch(e){ console.error(`装配模块失败 [${label}]：`, e); }
}

async function init(){
  // 申请持久化存储，避免浏览器在磁盘紧张时把书库清掉
  try { if(navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch(e){}

  safe('music', ()=> music.initMusic());
  safe('reader', ()=> reader.initReader({ onWordCount: updateWordCount }));
  safe('achievements', initAchievements);

  // 应用已保存偏好（任一步失败都不应中断后续装配）
  try {
    const shelf = await getSetting('shelf','sylva');
    document.body.dataset.shelf = shelf;
    document.getElementById('shelf-theme').value = shelf;
    document.getElementById('set-theme').value = await getSetting('theme','light');
    document.getElementById('set-pageturn').value = await getSetting('pageturn','simulation');
    document.getElementById('set-library-hint').value = await getSetting('libraryHint','');
  } catch(e){ console.error('init: 读取偏好设置失败', e); }

  // 加载书架（失败也继续，避免按钮全部失灵）
  try { await library.loadBooks(); }
  catch(e){ console.error('init: 加载书架失败', e); toast('书架加载失败：'+(e&&e.message||e)); }

  // 启动自愈：修正历史误标的"已读完"，避免一进来就弹成就（失败不影响其余功能）
  try {
    const fixed = await reconcileFinished();
    if(fixed > 0){
      await library.loadBooks();
      toast(`已修正 ${fixed} 本被误标记的"已读完"`);
    }
  } catch(e){ console.error('init: 自愈修正失败', e); }
  tickClock(); setInterval(tickClock, 1000);

  // 系统托盘音乐控制
  if(window.electronAPI && window.electronAPI.onMusicCommand){
    window.electronAPI.onMusicCommand(cmd=> music.trayControl(cmd));
  }

  // 尽早绑定"打开书籍"，避免后续任何 wiring 异常导致点书无反应
  library.setOpenHandler(openBookFlow);

  // 各模块独立装配：任一失败不影响其余（用 safe 隔离异常，杜绝"点不开/设置失效"）
  safe('topbar', wireTopbar);
  safe('shelfToolbar', wireShelfToolbar);
  safe('readerControls', wireReaderControls);
  safe('settings', wireSettings);
  safe('keyboard', wireKeyboard);
  safe('tapZones', buildTapZones);

  // 全盘扫描进度事件（桌面端）统一转发给弹窗
  if(window.electronAPI && window.electronAPI.onScanProgress){
    window.electronAPI.onScanProgress(arg => updateScanModal(arg));
  }

  // 后台清理：历史遗留的"有书目、无正文"的损坏条目（点开是空的），否则会一直点不开
  setTimeout(()=>{ pruneOrphanBooks().catch(()=>{}); }, 1200);
}

// 删除"只有书目没有正文"的坏数据——这类条目点开必然失败
async function pruneOrphanBooks(){
  let books = [];
  try { books = await db.getAll('books'); } catch(e){ return 0; }
  let n = 0;
  for(const b of books){
    try{
      const c = await db.get('content', b.id);
      if(!c || !Array.isArray(c.chapters) || !c.chapters.length){
        await db.delete('books', b.id);
        await db.delete('content', b.id);
        n++;
      }
    }catch(e){}
  }
  if(n){
    await library.loadBooks();
    toast(`已清理 ${n} 本损坏的书目（正文缺失，请重新导入）`);
  }
  return n;
}

function tickClock(){
  const d=new Date();
  const p=n=>String(n).padStart(2,'0');
  document.getElementById('clock').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function updateWordCount(){
  const books = await db.getAll('books');
  const total = books.reduce((s,b)=>s+(b.readWords||0),0);
  document.getElementById('wordcount').textContent = `累计已读 ${total.toLocaleString()} 字`;
}

async function openBookFlow(id){
  try{
    library.hideDetailNow();
    const ok = await reader.openBook(id);
    if(!ok){
      toast('这本书的正文缺失，无法打开；请用「＋ 导入书库」重新导入该书');
      return;
    }
    updateWordCount();
  }catch(e){
    console.error('打开书籍失败', e);
    toast('打开失败：' + (e && e.message || e));
  }
}

/* ---------- 顶部栏 ---------- */
// 扫描入库过程中节流刷新书架，让书"边导边上架"，不用等到全部结束
let _shelfRefreshTimer = null;
function scheduleShelfRefresh(){
  if(_shelfRefreshTimer) return;
  _shelfRefreshTimer = setTimeout(async ()=>{
    _shelfRefreshTimer = null;
    try { await library.loadBooks(); } catch(e){}
  }, 1200);
}

function wireTopbar(){
  document.getElementById('btn-import').onclick = async ()=>{
    try{
      const hint = await getSetting('libraryHint','');
      toast(hint ? `请选择书库目录（如 ${hint}）` : '请选择小说所在目录（.txt / .md）');
      const r = await pickAndImport(t=>toast(t, 1500));
      const extra = r.skipped ? `，跳过 ${r.skipped} 个非小说文件` : '';
      if(r.imported > 0){ await library.loadBooks(); toast(`成功导入 ${r.imported} 本小说${extra}`); }
      else if(r.total === 0) toast('未选择目录，或目录内没有 .txt / .md 文件');
      else toast(`没有发现新的小说（共扫描 ${r.total} 个文件${extra}）`);
    }catch(e){ console.error('导入失败', e); toast('导入失败：'+(e&&e.message||e)); }
  };

  // 全盘找书
  const scanBtn = document.getElementById('btn-scan');
  if(window.electronAPI && window.electronAPI.scanDiskForBooks){
    scanBtn.onclick = async ()=>{
      try{
        openScanModal();
        const r = await scanAndImport(msg=> updateScanImport(msg), ()=> scheduleShelfRefresh());
        closeScanModal();
        if(r.fatal){ toast('扫描失败：'+(r.fatal)); await library.loadBooks(); return; }
        await library.loadBooks();
        if(!r.supported){ toast('全盘找书仅桌面版支持'); return; }
        if(r.imported > 0) toast(`全盘扫描完成，成功导入 ${r.imported} 本小说`);
        else if(r.total > 0) toast(`没有发现新的小说（检查 ${r.total} 个文本文件，跳过 ${r.skipped} 个非小说）`);
        else toast('没有在磁盘上找到可导入的文本文件');
      }catch(e){ console.error('全盘扫描失败', e); closeScanModal(); toast('扫描失败：'+(e&&e.message||e)); }
    };
    document.getElementById('btn-scan-cancel').onclick = ()=>{
      try{ if(window.electronAPI && window.electronAPI.cancelScan) window.electronAPI.cancelScan(); }catch(e){}
      closeScanModal();
      toast('已停止扫描');
    };
  } else {
    scanBtn.hidden = true;
  }

  document.getElementById('shelf-theme').onchange = e=>{
    document.body.dataset.shelf = e.target.value;
    setSetting('shelf', e.target.value);
  };
}

/* ---------- 书架工具栏 ---------- */
function wireShelfToolbar(){
  const search = document.getElementById('search');
  search.oninput = debounce(()=> library.setQuery(search.value), 200);
  document.querySelectorAll('#filters .chip').forEach(c=>{
    c.onclick = ()=>{
      document.querySelectorAll('#filters .chip').forEach(x=>x.classList.remove('active'));
      c.classList.add('active');
      library.setFilter(c.dataset.cat);
    };
  });
}

/* ---------- 阅读器控制 ---------- */
function wireReaderControls(){
  document.getElementById('btn-back').onclick = ()=> reader.closeReader();
  document.getElementById('btn-toc').onclick = ()=> reader.toggleTOC();

  document.getElementById('btn-theme-cycle').onclick = ()=>{
    const cur = document.body.dataset.readingTheme || 'light';
    const next = THEMES[(THEMES.indexOf(cur)+1)%THEMES.length];
    reader.setTheme(next);
    syncThemeSeg(next);
    setSetting('theme', next);
  };

  // 字号 / 行距
  const fs=document.getElementById('font-size'), lh=document.getElementById('line-height');
  const applyFont=()=>{
    const size=+fs.value; const line=(+lh.value)/10;
    reader.setFont(size, line);
    document.getElementById('font-size-val').textContent=size;
    document.getElementById('line-height-val').textContent=line.toFixed(1);
  };
  fs.oninput=applyFont; lh.oninput=applyFont;

  // 翻页分段
  segHandler('pageturn-seg','pt', v=>{ reader.changePageturn(v); setSetting('pageturn',v); });
  // 主题分段
  segHandler('theme-seg','th', v=>{ reader.setTheme(v); setSetting('theme',v); });
  // 背景分段
  segHandler('bg-seg','bg', v=>{ reader.setBg(v); setSetting('bg',v); });

  // 翻页箭头 / 进度
  document.getElementById('nav-left').onclick = ()=> reader.goPrev();
  document.getElementById('nav-right').onclick = ()=> reader.goNext();
  const prog=document.getElementById('progress');
  prog.oninput = ()=> reader.seekProgress(prog.value/100);

  // 阅读内设置按钮：点章名区或悬浮
  document.getElementById('reader-title').onclick = ()=>{
    const rs=document.getElementById('reader-settings');
    rs.hidden=!rs.hidden;
  };
}

function segHandler(id, attr, cb){
  const seg=document.getElementById(id);
  seg.querySelectorAll('button').forEach(b=>{
    b.onclick=()=>{
      seg.querySelectorAll('button').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      cb(b.dataset[attr]);
    };
  });
}
function syncThemeSeg(t){
  document.querySelectorAll('#theme-seg button').forEach(x=>x.classList.toggle('active', x.dataset.th===t));
}

/* ---------- 设置面板 ---------- */
async function wireSettings(){
  const modal=document.getElementById('settings-modal');
  document.getElementById('btn-settings').onclick = async ()=>{ modal.hidden=false; await syncAutoStartUI(); };
  document.getElementById('btn-settings-close').onclick = ()=> modal.hidden=true;
  // 点遮罩空白处 / 按 Esc 也可关闭
  modal.addEventListener('click', e=>{ if(e.target===modal) modal.hidden=true; });
  document.addEventListener('keydown', e=>{ if(e.key==='Escape' && !modal.hidden) modal.hidden=true; });
  document.getElementById('set-theme').onchange = e=> setSetting('theme', e.target.value);
  document.getElementById('set-pageturn').onchange = e=> setSetting('pageturn', e.target.value);
  document.getElementById('set-library-hint').onchange = e=> setSetting('libraryHint', e.target.value);
  document.getElementById('btn-reset-ach').onclick = async ()=>{
    if(confirm('确定重置所有成就与已读完标记？')){
      await resetAchievements();
      await library.loadBooks();
      toast('成就已重置');
    }
  };
  // 桌面快捷方式（仅桌面端）
  const row=document.getElementById('desktop-shortcut-row');
  const btn=document.getElementById('btn-desktop-shortcut');
  if(window.electronAPI && window.electronAPI.createDesktopShortcut){
    btn.onclick = async ()=>{
      const r = await window.electronAPI.createDesktopShortcut();
      toast(r && r.ok ? (r.msg||'已创建桌面快捷方式') : (r&&r.msg ? r.msg : '创建失败'));
    };
  } else {
    row.style.display='none';
  }
  // 清空全盘扫描缓存：让下次「全盘找书」重新判定所有文件
  const resetBtn=document.getElementById('btn-scan-reset');
  if(resetBtn){
    resetBtn.onclick = async ()=>{
      try{
        await clearImportedPathCache();
        toast('已清空扫描缓存，下次「全盘找书」会重新判定所有文件');
      }catch(e){ toast('清空失败：'+(e&&e.message||e)); }
    };
  }
}
async function syncAutoStartUI(){}

/* ---------- 键盘 ---------- */
function wireKeyboard(){
  document.addEventListener('keydown', e=>{
    if(!document.getElementById('reader-view').classList.contains('active')) return;
    if(e.key==='ArrowRight') reader.goNext();
    else if(e.key==='ArrowLeft') reader.goPrev();
    else if(e.key==='Escape'){
      document.getElementById('toc-panel').hidden=true;
      document.getElementById('reader-settings').hidden=true;
    }
  });
}

function buildTapZones(){
  const z=document.getElementById('tap-zones');
  z.innerHTML='<div class="tz left"></div><div class="tz mid"></div><div class="tz right"></div>';
  z.querySelector('.left').onclick=()=>reader.goPrev();
  z.querySelector('.right').onclick=()=>reader.goNext();
  z.querySelector('.mid').onclick=()=>{
    const rs=document.getElementById('reader-settings');
    rs.hidden=!rs.hidden;
  };
}

// ---------- 全盘扫描趣味进度 ----------
const SCAN_QUIPS = [
  '在书海里捞针…','翻遍每一个抽屉…','灰尘里也可能有宝藏…',
  '嘘——正在悄悄翻看你的硬盘…','碰到一本就抱回家…','这一本，似乎是本好书？',
  '别急，好书值得等待…','把散落的章节都捡起来…'
];
let scanQuipTimer = null;

function openScanModal(){
  const m = document.getElementById('scan-modal');
  if(!m) return;
  m.hidden = false;
  document.getElementById('scan-dirs').textContent = '0';
  document.getElementById('scan-books').textContent = '0';
  document.getElementById('scan-path').textContent = '准备出发…';
  const quip = document.getElementById('scan-quip');
  quip.textContent = SCAN_QUIPS[0]; quip.style.opacity = '1';
  clearInterval(scanQuipTimer);
  let qi = 0;
  scanQuipTimer = setInterval(()=>{
    quip.style.opacity = '0';
    setTimeout(()=>{ qi=(qi+1)%SCAN_QUIPS.length; quip.textContent = SCAN_QUIPS[qi]; quip.style.opacity = '1'; }, 260);
  }, 2400);
}

function closeScanModal(){
  clearInterval(scanQuipTimer);
  const m = document.getElementById('scan-modal');
  if(m) m.hidden = true;
}

let _scanLast = 0;
function updateScanModal(arg){
  if(!arg) return;
  const now = Date.now();
  if(now - _scanLast < 80) return;  // 渲染节流
  _scanLast = now;
  document.getElementById('scan-dirs').textContent = (arg.dirsScanned||0).toLocaleString();
  document.getElementById('scan-books').textContent = (arg.booksFound||0).toLocaleString();
  if(arg.current) document.getElementById('scan-path').textContent = arg.current;
  if(arg.done) document.getElementById('scan-path').textContent = '扫描完成，开始入库…';
}

function updateScanImport(msg){
  const pathEl = document.getElementById('scan-path');
  if(pathEl) pathEl.textContent = msg;
  const quip = document.getElementById('scan-quip');
  if(quip){ quip.style.opacity = '1'; quip.textContent = '正在把书搬上书架…'; }
}

init().catch(e=>{
  console.error('初始化失败：', e);
  toast('初始化出错：' + (e && e.message || e));
});
