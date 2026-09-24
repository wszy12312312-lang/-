// achievements.js — 成就徽章 / 里程碑 / 祝贺弹窗
import { db } from './db.js';

const MILESTONES = [
  {n:1,  badge:'🌱', title:'初读成章', desc:'读完人生第 1 本小说，旅程就此开始。'},
  {n:5,  badge:'📚', title:'小有所成', desc:'累计读完 5 本，书海初窥门径。'},
  {n:20, badge:'🏆', title:'博览群书', desc:'累计读完 20 本，已是非凡的坚持。'},
  {n:50, badge:'👑', title:'书林高手', desc:'累计读完 50 本，腹有诗书气自华。'},
  {n:100,badge:'💎', title:'万卷归宗', desc:'累计读完 100 本，堪称传奇书痴！'}
];

export async function onBookFinished(book){
  // 单本徽章（幂等）
  await db.put('achievements',{id:'book-'+book.id, bookId:book.id, title:book.title, date:Date.now()});

  const books = await db.getAll('books');
  const fc = books.filter(b=>b.finished).length;
  const summary = (await db.get('achievements','summary')) || {finishedCount:0, milestones:[]};
  const crossed = MILESTONES.filter(m=> summary.finishedCount < m.n && fc >= m.n);
  summary.finishedCount = fc;
  crossed.forEach(m=>{ if(!summary.milestones.includes(m.n)) summary.milestones.push(m.n); });
  await db.put('achievements',{id:'summary', finishedCount:fc, milestones:summary.milestones});

  if(crossed.length) showMilestone(crossed[crossed.length-1]);
}

let popupShown = {};   // 已在本次会话弹过的里程碑，避免重复弹出

function showMilestone(m){
  if(popupShown[m.n]) return;
  popupShown[m.n] = true;
  document.getElementById('ach-badge').textContent = m.badge;
  document.getElementById('ach-title').textContent = `🎉 成就达成：${m.title}`;
  document.getElementById('ach-desc').textContent = m.desc;
  const pop = document.getElementById('ach-popup');
  if(!pop) return;
  pop.hidden = false;
}

// 在 app 初始化时调用一次：关闭按钮与遮罩点击始终可用，
// 即便弹窗因任何原因被显示也能关掉（彻底解决"关不掉"）。
export function initAchievements(){
  const pop = document.getElementById('ach-popup');
  const close = document.getElementById('ach-close');
  if(!pop || !close) return;
  close.addEventListener('click', ()=> pop.hidden = true);
  pop.addEventListener('click', e=>{ if(e.target === pop) pop.hidden = true; });
}

export async function getFinishedCount(){
  const s = await db.get('achievements','summary');
  return s ? s.finishedCount : 0;
}

/**
 * 启动自愈：修复历史脏数据——因早期"打开即读完"缺陷被误标记 finished 的书，
 * 若其阅读进度仍为 0（基本没读过），则撤销 finished 标记，并重算已读本数。
 * 返回本次修正的本数。
 */
export async function reconcileFinished(){
  const books = await db.getAll('books');
  let fixed = 0;
  for(const b of books){
    const prog = b.progress || 0;
    const words = b.readWords || 0;
    // 进度极低却被判为读完 → 判定为误标
    if(b.finished && prog < 0.5 && words < (b.totalWords || 0) * 0.5){
      b.finished = false;
      await db.put('books', b);
      // 清理该书对应的单本成就
      const a = await db.get('achievements', 'book-'+b.id);
      if(a) await db.delete('achievements', 'book-'+b.id);
      fixed++;
    }
  }
  // 重算 summary，避免残留里程碑
  const fc = (await db.getAll('books')).filter(b=>b.finished).length;
  const summary = (await db.get('achievements','summary')) || {finishedCount:0, milestones:[]};
  summary.finishedCount = fc;
  summary.milestones = summary.milestones.filter(n => n <= fc);
  await db.put('achievements', {id:'summary', finishedCount:fc, milestones:summary.milestones});
  return fixed;
}

export async function resetAchievements(){
  await db.delete('achievements','summary');
  const all = await db.getAll('achievements');
  for(const a of all){ if(a.id.startsWith('book-')) await db.delete('achievements',a.id); }
  const books = await db.getAll('books');
  for(const b of books){ b.finished=false; b.progress=Math.min(b.progress,0.0); await db.put('books',b); }
}
