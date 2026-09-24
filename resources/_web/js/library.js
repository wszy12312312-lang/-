// library.js — 3D 书架渲染 / 检索 / 分类 / 悬浮详情
import { db } from './db.js';
import { escapeHtml, gradientFor, toast } from './utils.js';

let onOpen = null;
let state = { books:[], filter:'all', query:'' };
const PER_BOARD = 14;

export function setOpenHandler(fn){ onOpen = fn; }

// 立即收起悬浮详情卡（例如打开书籍前）
export function hideDetailNow(){
  const card = document.getElementById('book-detail');
  if(!card) return;
  clearTimeout(detailTimer);
  card.classList.remove('show');
  card.hidden = true;
}

function statusOf(b){
  if(b.finished) return 'finished';
  if(b.progress>0 || b.readWords>0) return 'reading';
  return 'unread';
}

// 书脊竖向空间有限：按可用像素估算能容纳的字数，超长则截断并保留省略号（避免被硬裁切）
function spineClip(str, px, fs, ls){
  const s = (str == null ? '' : String(str));
  const n = Math.max(2, Math.floor(Math.max(36, px) / (fs + ls)));
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s;
}

export async function loadBooks(){
  state.books = await db.getAll('books');
  render();
}

// 单屏最多渲染的书本数：书库很大时避免一次性创建上万 DOM 节点导致卡顿
const RENDER_LIMIT = 600;

export function render(){
  const shelf = document.getElementById('shelf');
  const empty = document.getElementById('empty-hint');
  const q = state.query.trim().toLowerCase();

  const list = state.books.filter(b=>{
    const st = statusOf(b);
    if(state.filter!=='all' && st!==state.filter) return false;
    if(q && !(b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q))) return false;
    return true;
  });

  shelf.innerHTML = '';
  empty.hidden = state.books.length!==0;

  if(!list.length){
    document.getElementById('shelf-count').textContent = state.books.length ? '无匹配结果' : '';
    return;
  }

  const shown = list.length > RENDER_LIMIT ? list.slice(0, RENDER_LIMIT) : list;
  for(let i=0;i<shown.length;i+=PER_BOARD){
    const board = document.createElement('div');
    board.className = 'board';
    shown.slice(i,i+PER_BOARD).forEach(b=>board.appendChild(bookEl(b)));
    shelf.appendChild(board);
  }
  const fin = list.filter(b=>b.finished).length;
  const more = list.length > RENDER_LIMIT ? `（仅显示前 ${RENDER_LIMIT} 本，可搜索定位）` : '';
  document.getElementById('shelf-count').textContent = `共 ${list.length} 本 · 已读完 ${fin} 本${more}`;
}

function bookEl(b){
  const el = document.createElement('div');
  el.className = 'book ' + statusOf(b);
  el.style.width = b.width + 'px';
  el.style.height = b.height + 'px';
  el.style.background = `linear-gradient(160deg,${b.color1},${b.color2})`;
  el.dataset.id = b.id;
  // 书名 15px/字距3、作者 11px/字距2；按书本高度算出各自可显示的字数
  const h = b.height || 200;
  const t = spineClip(b.title, h * 0.62, 15, 3);
  const a = spineClip(b.author, h * 0.24, 11, 2);
  el.innerHTML = `<div class="spine"><div class="b-title">${escapeHtml(t)}</div><div class="b-author">${escapeHtml(a)}</div></div>`;

  el.addEventListener('click', ()=> onOpen && onOpen(b.id));
  el.addEventListener('mouseenter', e=> showDetail(b, el));
  el.addEventListener('mouseleave', hideDetail);
  return el;
}

let detailTimer;
function showDetail(b, el){
  clearTimeout(detailTimer);
  const card = document.getElementById('book-detail');
  const r = el.getBoundingClientRect();
  document.getElementById('bd-cover').style.background = gradientFor(b.title);
  document.getElementById('bd-cover').textContent = b.title.slice(0,2);
  document.getElementById('bd-title').textContent = b.title;
  document.getElementById('bd-author').textContent = '作者：' + b.author;
  document.getElementById('bd-stats').innerHTML =
    `<span>${b.totalWords.toLocaleString()} 字</span><span>${b.totalChapters} 章</span><span>进度 ${Math.round(b.progress*100)}%</span>`;
  document.getElementById('bd-intro').textContent = b.intro || '（暂无简介）';
  document.getElementById('bd-open').onclick = ()=> onOpen && onOpen(b.id);

  // 定位：优先放在书右侧，空间不足则放左侧
  const cw = 300, ch = 320;
  let left = r.right + 12;
  if(left + cw > window.innerWidth - 10) left = r.left - cw - 12;
  if(left < 10) left = Math.min(r.left, window.innerWidth - cw - 10);
  let top = Math.min(r.top, window.innerHeight - ch - 10);
  if(top < 70) top = 70;
  card.style.left = left + 'px';
  card.style.top = top + 'px';
  // 关键：去掉 hidden 属性，否则会被全局 [hidden]{display:none!important} 永久隐藏
  card.hidden = false;
  requestAnimationFrame(()=> card.classList.add('show'));
}
function hideDetail(){
  const card = document.getElementById('book-detail');
  detailTimer = setTimeout(()=>{
    card.classList.remove('show');
    // 等翻合过渡结束再真正隐藏，避免与全局 [hidden] 规则冲突
    setTimeout(()=>{ if(!card.classList.contains('show')) card.hidden = true; }, 240);
  }, 120);
  card.addEventListener('mouseenter',()=>clearTimeout(detailTimer),{once:true});
}

export function setFilter(f){ state.filter = f; render(); }
export function setQuery(q){ state.query = q; render(); }
