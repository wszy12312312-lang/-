// reader.js — 阅读引擎：主题 / 分页 / 翻页 / 进度 / 字数
import { db, getSetting, setSetting } from './db.js';
import { countWords, escapeHtml, fmtDate } from './utils.js';
import { onBookFinished } from './achievements.js';
import { chunkChapters } from './import.js';

let book=null, content=null, stage=null, pagesEl=null;
let ci=0, pi=0;                 // 当前章、当前页
let chapterLens=[];             // 各章字符数
let chapterStart=[];            // 各章起始累计字符
let totalChars=0;
let curPages=[];                // 当前章分页（{html,len}）
let app=null;                   // 回调集合

export function initReader(callbacks){
  app = callbacks;
  // 上下翻页的懒加载续接（只挂一次）
  const pg = document.getElementById('pages');
  if(pg) pg.addEventListener('scroll', onVerticalScroll, {passive:true});
}

export async function openBook(id){
  book = await db.get('books', id);
  if(!book) return false;
  content = await db.get('content', id);
  if(!content || !Array.isArray(content.chapters) || !content.chapters.length) return false;

  // 兼容历史数据：超长章节按块切分（并静默回写），否则打开时构建超大 DOM 会卡死
  try{
    const chunked = chunkChapters(content.chapters);
    if(chunked.length !== content.chapters.length){
      content.chapters = chunked;
      db.put('content', { id, chapters: chunked }).catch(()=>{});
    }
  }catch(e){ console.warn('章节切分失败', e); }

  ci = Math.min(Math.max(0, book.lastChapter||0), content.chapters.length-1);
  pi = Math.max(0, book.lastPage||0);
  chapterLens = content.chapters.map(c=>(c.text||'').length);
  chapterStart = []; let acc=0;
  for(const l of chapterLens){ chapterStart.push(acc); acc+=l; }
  totalChars = acc || 1;

  document.getElementById('reader-title').textContent = book.title;
  document.getElementById('reader-view').classList.add('active');
  document.getElementById('shelf-view').classList.remove('active');

  // 主题 / 翻页
  let theme='light', pt='simulation';
  try{
    theme = book.theme || await getSetting('theme','light');
    pt = book.pageturn || await getSetting('pageturn','simulation');
  }catch(e){ /* 设置读取失败不影响阅读 */ }
  const bg = book.bg || 'forest';
  setTheme(theme); setPageturn(pt); setBg(bg);

  try{
    buildTOC();
    if(pt==='vertical') renderVertical();
    else await renderPaged();
  }catch(e){
    console.error('渲染正文失败', e);
  }
  finishFlagReset();
  syncProgressUI();
  openedAt = Date.now();          // 首帧之后才开始允许判定"读完"
  return true;
}
function finishFlagReset(){ finishedFlag = false; }

export function closeReader(){
  flashSave();
  document.getElementById('reader-view').classList.remove('active');
  document.getElementById('shelf-view').classList.add('active');
  document.getElementById('toc-panel').hidden = true;
  document.getElementById('reader-settings').hidden = true;
}

/* ---------- 主题 / 翻页 / 背景 ---------- */
export function setTheme(t){
  document.body.dataset.readingTheme = t;
  book && (book.theme=t);
  if(t==='immersive') ensureImmersiveBg(); else removeImmersiveBg();
}
export function setPageturn(pt){
  document.body.dataset.pageturn = pt;
  stage = stage||document.getElementById('stage');
  stage.className = 'stage pageturn-'+pt;
  if(book) book.pageturn = pt;
}
export function setBg(bg){
  document.body.dataset.bg = bg;
  book && (book.bg=bg);
  if(document.body.dataset.readingTheme==='immersive') ensureImmersiveBg();
}
export async function changePageturn(pt){
  document.body.dataset.pageturn = pt;
  stage = stage||document.getElementById('stage');
  stage.className = 'stage pageturn-'+pt;
  if(book){ book.pageturn=pt; db.put('books',book); }
  ci = book ? (book.lastChapter||0) : 0; pi=0;
  if(pt==='vertical') renderVertical();
  else await renderPaged();
  syncProgressUI();
}
function ensureImmersiveBg(){
  let bgEl = document.querySelector('.immersive-bg');
  if(!bgEl){ bgEl=document.createElement('div'); bgEl.className='immersive-bg'; document.getElementById('reader-view').prepend(bgEl); }
}
function removeImmersiveBg(){ const e=document.querySelector('.immersive-bg'); if(e) e.remove(); }

export function setFont(size, lh){
  stage = stage||document.getElementById('stage');
  stage.style.setProperty('--rfs', size+'px');
  stage.style.setProperty('--rlh', lh);
  // 重新分页（仅分页模式）
  if(book && document.body.dataset.pageturn!=='vertical'){ rePaginate(); }
}
async function rePaginate(){
  if(document.body.dataset.pageturn==='vertical'){ renderVertical(); return; }
  const oldChar = charAt(ci,pi);
  await renderPaged();
  // 尽量恢复到相近位置
  seekChar(oldChar);
  syncProgressUI();
}

/* ---------- 分页 ---------- */
function pageHTML(text,title){
  const paras = text.split('\n').filter(Boolean).map(t=>`<p>${escapeHtml(t)}</p>`).join('');
  return (title?`<div class="ch-title">${escapeHtml(title)}</div>`:'') + paras;
}
function measureFits(probe, header, text, n){
  const paras = text.slice(0,n).split('\n').filter(Boolean).map(t=>`<p>${escapeHtml(t)}</p>`).join('');
  probe.innerHTML = header + paras;
  return probe.scrollHeight <= probe.clientHeight;
}
function fitSlice(text,title){
  const probe=document.createElement('div'); probe.className='page'; probe.style.visibility='hidden';
  stage.appendChild(probe);
  const header = title?`<div class="ch-title">${escapeHtml(title)}</div>`:'';
  let cut;
  if(measureFits(probe, header, text, text.length)){
    // 整段都放得下。原来的二分在"全部可行"时只会返回 len-1，
    // 留下 1 个字符的尾巴；下一轮对 1 个字符又返回 0 → 原地打转 → 渲染进程卡死/OOM。
    cut = text.length;
  } else {
    let lo=0,hi=text.length,last=0;
    while(lo<hi){
      const mid=(lo+hi)>>1;
      if(measureFits(probe, header, text, mid)){ lo=mid+1; last=mid; } else hi=mid;
    }
    cut=last;
    const near=text.slice(Math.max(0,cut-40),cut);
    const lb=near.lastIndexOf('\n');
    if(lb>0) cut=Math.max(0,cut-40)+lb;
  }
  stage.removeChild(probe);
  if(cut<=0) cut=text.length;                 // 兜底：绝不返回 0 让调用方空转
  return {len:cut, text:text.slice(0,cut)};
}
function buildChapterPages(chapter, withTitle){
  const pages=[]; let rem=(chapter && chapter.text)||''; let first=withTitle;
  let guard=0;
  while(rem.length>0 && guard++ < 5000){
    const title = first ? chapter.title : null;
    const f=fitSlice(rem, title);
    const take = f.len>0 ? f.len : rem.length;   // 兜底：每轮必须前进
    pages.push({html:pageHTML(rem.slice(0,take), title), len:take});
    rem=rem.slice(take).replace(/^\s+/,'');
    first=false;
  }
  if(pages.length===0) pages.push({html:pageHTML('',withTitle?chapter.title:null),len:0});
  return pages;
}

async function nextFrame(){ return new Promise(r=>requestAnimationFrame(r)); }

async function renderPaged(){
  // 等两帧，确保 #reader-view 已 display:block 并完成布局，否则测量高度为 0 → 空白页
  await nextFrame(); await nextFrame();
  const chap = content.chapters[ci];
  if(!chap){ ci = 0; }
  curPages = buildChapterPages(content.chapters[ci], true);
  if(pi>=curPages.length) pi=Math.max(0,curPages.length-1);
  pagesEl = document.getElementById('pages');
  pagesEl.className='pages';
  pagesEl.innerHTML='';
  curPages.forEach((p,i)=>{
    const d=document.createElement('div'); d.className='page'; d.innerHTML=p.html;
    if(i!==pi) d.style.transform='translateX('+(i-pi)*100+'%)';
    pagesEl.appendChild(d);
  });
  applyPageTransform();
}
function applyPageTransform(){
  const mode=document.body.dataset.pageturn;
  if(mode==='horizontal'){
    pagesEl.style.transform=`translateX(${-pi*100}%)`;
  } else if(mode==='simulation'){
    pagesEl.style.transform=`translateX(${-pi*100}%)`;
  }
}

/* ---------- 上下翻页（连续滚动，分块懒加载） ---------- */
// 一本书可能有上千个章节块，一次性铺满 DOM 会让滚动与渲染都卡顿；
// 这里按批追加，滚到底部自动续上。
let vRendered = 0;
const V_BATCH = 40;

function chunkHTML(c){
  return `<div class="page"><div class="ch-title">${escapeHtml(c.title)}</div>`
       + (c.text||'').split('\n').filter(Boolean).map(t=>`<p>${escapeHtml(t)}</p>`).join('')
       + `</div>`;
}
function verticalAppend(n){
  if(!pagesEl) return;
  const end = Math.min(content.chapters.length, vRendered + n);
  if(end <= vRendered) return;
  let html = '';
  for(let i=vRendered;i<end;i++) html += chunkHTML(content.chapters[i]);
  pagesEl.insertAdjacentHTML('beforeend', html);
  vRendered = end;
}
function verticalEnsure(idx){
  if(idx + 1 > vRendered) verticalAppend(idx + 1 - vRendered);
}
function renderVertical(){
  pagesEl=document.getElementById('pages');
  if(!pagesEl) return;
  pagesEl.className='pages';
  pagesEl.style.transform='';
  pagesEl.innerHTML='';
  vRendered = 0;
  verticalAppend(Math.max(V_BATCH, Math.min(content.chapters.length, ci+1)));
  const target = pagesEl.children[ci];
  if(ci > 0 && target) target.scrollIntoView({block:'start'});
  else pagesEl.scrollTop = 0;
}
function onVerticalScroll(){
  if(document.body.dataset.pageturn!=='vertical' || !pagesEl) return;
  const max = pagesEl.scrollHeight - pagesEl.clientHeight;
  if(vRendered < content.chapters.length && max - pagesEl.scrollTop < pagesEl.clientHeight*2){
    verticalAppend(V_BATCH);        // 在下方追加，不影响当前滚动位置
  }
  afterScroll();
}

/* ---------- 导航 ---------- */
export function goNext(){
  if(!book || !content || !pagesEl || !curPages.length) return;
  const mode=document.body.dataset.pageturn;
  if(mode==='vertical'){ pagesEl.scrollBy({top:pagesEl.clientHeight*0.9,behavior:'smooth'}); afterScroll(); return; }
  if(pi<curPages.length-1){
    flipTo(pi+1, 1);
  } else if(ci<content.chapters.length-1){
    ci++; pi=0; renderPaged().then(()=>{flashSave(); syncProgressUI();});
  } else {
    finishBook();
  }
}
export function goPrev(){
  if(!book || !content || !pagesEl || !curPages.length) return;
  const mode=document.body.dataset.pageturn;
  if(mode==='vertical'){ pagesEl.scrollBy({top:-pagesEl.clientHeight*0.9,behavior:'smooth'}); afterScroll(); return; }
  if(pi>0){
    flipTo(pi-1, -1);
  } else if(ci>0){
    ci--; pi=0; renderPaged().then(()=>{ syncProgressUI(); });
  }
}
function flipTo(n, dir){
  const mode=document.body.dataset.pageturn;
  const pages=pagesEl.children;
  const cur=pages[pi];
  if(cur && mode==='simulation'){
    cur.classList.add('flipping'); // 当前页翻走
    setTimeout(()=>{
      pi=n; applyPageTransform();
      Array.from(pages).forEach((p,i)=>{ p.style.transform=`translateX(${(i-pi)*100}%)`; });
      cur.classList.remove('flipping');
      syncProgressUI(); flashSave();
    }, 300);
  } else {
    pi=n; applyPageTransform(); syncProgressUI(); flashSave();
  }
}
function afterScroll(){
  const max=pagesEl.scrollHeight-pagesEl.clientHeight;
  if(max<=0 || pagesEl.scrollTop>=max-4){ /* 仍在最后 */ }
  syncProgressUI(); flashSave();
}

/* ---------- 进度 / 字数 ---------- */
function charAt(ci,pi){
  let c=chapterStart[ci]||0;
  for(let i=0;i<pi && i<curPages.length;i++) c+=curPages[i].len;
  return c;
}
function currentProgress(){
  const mode=document.body.dataset.pageturn;
  if(mode==='vertical'){
    if(!pagesEl) return 0;
    const total = content.chapters.length || 1;
    const max=pagesEl.scrollHeight-pagesEl.clientHeight;
    const within = max>0 ? Math.max(0, Math.min(1, pagesEl.scrollTop/max)) : 0;
    // 已渲染的块数 + 当前块内的滚动比例（懒加载模式下不能只看 scrollTop）
    return Math.max(0, Math.min(1, (Math.max(0, vRendered-1) + within) / total));
  }
  return Math.min(1, charAt(ci,pi)/totalChars);
}
function seekChar(target){
  // 找到目标字符所在的章/页
  for(let c=0;c<content.chapters.length;c++){
    if(chapterStart[c]+chapterLens[c] >= target){
      ci=c;
      curPages=buildChapterPages(content.chapters[c], true);
      pi=0;
      let acc=chapterStart[c];
      for(let p=0;p<curPages.length;p++){
        if(acc+curPages[p].len>=target) break;
        acc+=curPages[p].len; pi=p+1;
      }
      renderPaged();
      return;
    }
  }
}
export function syncProgressUI(opts){
  if(!book || !content || !pagesEl) return;
  const silent = opts && opts.silent;
  const p=currentProgress();
  book.progress=p;
  book.readWords=Math.round(p*(book.totalWords||0));
  const pct=Math.round(p*100);
  const progEl=document.getElementById('progress');
  if(progEl) progEl.value=pct;
  const plEl=document.getElementById('progress-label');
  if(plEl) plEl.textContent=pct+'%';
  const clEl=document.getElementById('chapter-label');
  if(clEl) clEl.textContent=(content.chapters[ci]&&content.chapters[ci].title)||'';
  app && app.onWordCount && app.onWordCount();
  // 竖向滚动到底 → 完成（silent 时跳过，避免内部调用再次触发）
  if(!silent && document.body.dataset.pageturn==='vertical'){
    const max=pagesEl.scrollHeight-pagesEl.clientHeight;
    if(max>4 && pagesEl.scrollTop>=max-4) finishBook();
  }
}
function flashSave(){
  if(!book) return;
  book.lastChapter=ci; book.lastPage=pi;
  db.put('books', book);
}

/* ---------- 完成 / 成就 ---------- */
let finishedFlag=false;
let openedAt=0;                 // 打开本书的时间戳，用于抑制首帧误判
export function finishBook(){
  if(finishedFlag||!book||!content) return;
  // 刚打开不足 1.2 秒内不判定完成，避免首帧布局把"打开"当成"读完"
  if(openedAt && Date.now()-openedAt < 1200) return;
  const mode=document.body.dataset.pageturn;
  if(mode==='vertical'){
    if(vRendered < content.chapters.length) return;   // 还没加载到最后一章，不算读完
    const max=pagesEl.scrollHeight-pagesEl.clientHeight;
    if(max<=0) return;                              // 没有可滚动内容，不算读完
    if(pagesEl.scrollTop < max-4) return;           // 必须真正滚到底
    if(book.progress<0.95) return;
  } else {
    if(!curPages.length) return;
    if(book.progress<0.95) return;                  // 分页模式必须读到 95% 以上
  }
  finishedFlag=true;
  book.finished=true; book.progress=1; book.readWords=book.totalWords;
  book.lastChapter=content.chapters.length-1; book.lastPage=Math.max(0,curPages.length-1);
  db.put('books', book);
  syncProgressUI({silent:true});
  onBookFinished(book);
  setTimeout(()=>finishedFlag=false, 1500);
}

/* ---------- 目录 ---------- */
function buildTOC(){
  const sel=document.getElementById('chapter-select');
  sel.innerHTML='';
  content.chapters.forEach((c,i)=>{
    const o=document.createElement('option'); o.value=i; o.textContent=c.title; sel.appendChild(o);
  });
  sel.value=ci;
  sel.onchange=()=>jumpChapter(+sel.value);
}
function jumpChapter(i){
  if(!content) return;
  ci=Math.max(0, Math.min(i, content.chapters.length-1)); pi=0;
  if(document.body.dataset.pageturn==='vertical'){
    if(!pagesEl) return;
    verticalEnsure(ci);
    const pages=pagesEl.children;
    if(pages[ci]) pages[ci].scrollIntoView();
  } else {
    renderPaged().then(syncProgressUI);
  }
  document.getElementById('toc-panel').hidden=true;
}
export function toggleTOC(){
  if(!content) return;
  const p=document.getElementById('toc-panel');
  if(!p.hidden){ p.hidden=true; return; }
  p.innerHTML='<h3 style="margin:0 0 10px;font-size:15px">目录</h3>'+
    content.chapters.map((c,i)=>`<div class="toc-item ${i===ci?'active':''}" data-i="${i}">${escapeHtml(c.title)}</div>`).join('');
  p.querySelectorAll('.toc-item').forEach(el=>el.onclick=()=>jumpChapter(+el.dataset.i));
  p.hidden=false;
}

/* ---------- 进度条拖拽 ---------- */
export function seekProgress(ratio){
  if(!book || !content || !pagesEl) return;
  if(document.body.dataset.pageturn==='vertical'){
    const need = Math.min(content.chapters.length, Math.ceil(ratio*content.chapters.length)+2);
    verticalEnsure(need-1);
    pagesEl.scrollTop=(pagesEl.scrollHeight-pagesEl.clientHeight)*ratio;
    syncProgressUI(); flashSave();
  } else {
    seekChar(Math.round(ratio*totalChars));
    syncProgressUI(); flashSave();
  }
}
