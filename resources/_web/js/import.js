// import.js — 扫描书库目录、解析小说、分章入库
// 关键约定：
//  1) 只导入"看起来像小说"的文本（正文/章节特征），过滤笔记、代码、README、日志等；
//  2) 单本体积有上限，且超长章节会被切成小块（否则阅读器一次性构建超大 DOM 会卡死）；
//  3) 先写正文(content)再写书目(books)，保证书架上出现的每一本都能打开；
//  4) 全盘扫描带路径缓存，重复扫描直接跳过，秒出结果。
import { db, getSetting, setSetting } from './db.js';
import { hashStr, countWords, colorFor, dimsFor } from './utils.js';

const TITLE_RE = /^\s*(第\s*[零一二三四五六七八九十百千万\d]+\s*[章回卷部节篇集]|chapter\s*\d+|卷\s*[一二三四五六七八九十百千\d]+|序章|序言|前言|引子|楔子|尾声|终章|大结局|后记|番外|间章|外传)/i;

export const MAX_BYTES = 8 * 1024 * 1024;   // 单文件上限 8MB（更大的基本不是小说）
export const MIN_BYTES = 3000;              // 小于 3KB 基本不是小说
export const MAX_TEXT  = 4 * 1024 * 1024;   // 解码后字符上限
const CHUNK = 4500;                         // 单个章节块的字数上限

/* ---------- 解码 ---------- */
function decode(buf){
  const utf8 = new TextDecoder('utf-8',{fatal:false}).decode(buf);
  if(!/�/.test(utf8)) return utf8;             // 无乱码 → 直接 UTF-8
  try { return new TextDecoder('gbk',{fatal:true}).decode(buf); } catch(e){}
  try { return new TextDecoder('gb18030',{fatal:false}).decode(buf); } catch(e){}
  return utf8;
}

/* ---------- 分章 ---------- */
export function splitChapters(text){
  const lines = text.replace(/^﻿/,'').split(/\r?\n/);
  const chapters = [];
  let cur = null;
  for(const raw of lines){
    const line = raw.trim();
    if(!line) continue;
    if(TITLE_RE.test(line) && line.length < 40){
      if(cur) chapters.push(cur);
      cur = { title: line, text: '' };
    } else {
      if(!cur) cur = { title: null, text: '' };
      cur.text += line + '\n';
    }
  }
  if(cur) chapters.push(cur);

  const out = chapters.map((c,i)=>({
    title: c.title || (i===0 ? '正文' : `第${i}节`),
    text: c.text.trim()
  })).filter(c=>c.text.length>0);

  return out.length ? out : [{title:'正文', text:text.trim()}];
}

/**
 * 把超长章节切成小块。这是"点书看不了 / 整个窗口卡死"的根治手段：
 * 原先是按"章"一次性构建 DOM 做二分测量，一本无章节标记的 1MB 文本
 * 会产生上万次超大 innerHTML 构建，直接把渲染进程卡死。
 */
export function chunkChapters(chapters){
  const out = [];
  for(const c of chapters||[]){
    const title = c && c.title ? c.title : '正文';
    const text = (c && c.text) || '';
    if(text.length <= CHUNK){ if(text.length) out.push({title, text}); continue; }
    let rem = text, part = 1;
    while(rem.length){
      let cut;
      if(rem.length > CHUNK){
        // 尽量在段落边界切开
        const winStart = Math.max(0, CHUNK - 600);
        const win = rem.slice(winStart, CHUNK + 600);
        const nl = win.lastIndexOf('\n');
        cut = nl > 0 ? winStart + nl : CHUNK;
      } else {
        cut = rem.length;
      }
      const piece = rem.slice(0, cut).trim();
      if(piece) out.push({ title: part===1 ? title : `${title}（续${part}）`, text: piece });
      rem = rem.slice(cut).replace(/^\s+/,'');
      part++;
      if(part > 4000) break;                  // 安全阀
    }
  }
  return out.length ? out : [{title:'正文', text:''}];
}

/* ---------- 元信息 ---------- */
function parseMeta(name, chapters, text){
  let title = String(name||'').replace(/\.(txt|md|text)$/i,''), author = '佚名';
  const m = title.match(/^(.+?)[\s\-_·—–]+((?!第|卷|正文).{1,20})$/);
  if(m){ title = m[1].trim(); author = m[2].trim(); }
  const am = text.match(/(?:作者|著\s*者|文\s*∕|by)\s*[:：]\s*([^\n]{1,20})/i);
  if(am && am[1].length<15) author = am[1].trim();
  const intro = (chapters[0]?.text || '').slice(0,180).replace(/\n+/g,' ');
  return {title, author, intro};
}

/* ---------- 小说判定（"尽量只导入小说"） ---------- */
// 文件名明显不是小说的直接排除
const BAD_NAME = /(readme|license|licence|changelog|index|template|toc|summary|note|todo|log|config|package|lock|manifest|说明|模板|笔记|备忘|待办|清单|目录|配置|日志|草稿|大纲|设定|素材|规则|记账|账本|简历|合同|方案|报告|论\s*文|教程|文档|题库|试卷|习题|公文)/i;

export function looksLikeNovel(text, name){
  const base = String(name||'').replace(/\.(txt|md|text)$/i,'').trim();
  if(!base) return false;
  if(BAD_NAME.test(base)) return false;
  if(!text) return false;

  const t = text.replace(/\r/g,'');
  const len = t.length;
  if(len < MIN_BYTES) return false;                                  // 太短
  const cjk = (t.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g)||[]).length;
  if(cjk < 2000) return false;                                       // 中文字太少（英文/代码）
  if(cjk / len < 0.45) return false;                                 // 中文占比过低
  if(t.indexOf('```') >= 0) return false;                            // 代码块
  if((t.match(/https?:\/\//g)||[]).length > 8) return false;         // 大量链接

  const lines = t.split('\n');
  let chap = 0;
  for(let i=0;i<lines.length;i++){
    const l = lines[i].trim();
    if(l && l.length < 40 && TITLE_RE.test(l)) chap++;
  }
  const wiki = (t.match(/\[\[/g)||[]).length;                        // Obsidian 内链
  if(wiki > 15 && chap < 3) return false;
  const heads = lines.filter(l=>/^#{1,6}\s/.test(l)).length;         // markdown 标题
  if(heads >= 8 && chap < 2) return false;

  if(chap >= 2) return true;                                         // 有章节标记 → 小说
  const paras = lines.filter(l=>l.trim().length>0);
  const avg = len / Math.max(1, paras.length);
  return cjk >= 10000 && avg >= 40;                                  // 无标记但为长篇正文
}

/* ---------- 入库 ---------- */
async function storeBook(name, text, onProgress, i, total){
  if(!text) return 0;
  if(text.length > MAX_TEXT) return 0;
  if(!looksLikeNovel(text, name)) return -1;                         // -1 = 非小说，跳过

  const chapters = chunkChapters(splitChapters(text));
  if(!chapters.length) return 0;
  const {title, author, intro} = parseMeta(name, chapters, text);
  const id = hashStr(title + '|' + author);
  if(await db.get('books', id)) return 0;                            // 已存在

  const totalWords = chapters.reduce((s,c)=>s+countWords(c.text),0);
  const [c1,c2] = colorFor(title);
  const {height,width} = dimsFor(title, totalWords);
  const book = {
    id, title, author, intro, totalWords,
    totalChapters: chapters.length,
    finished:false, readWords:0, progress:0,
    lastChapter:0, lastPage:0,
    color1:c1, color2:c2, height, width,
    category: 'unread', addedAt: Date.now()
  };
  try {
    // 先正文、后书目：确保书架上的每一本都能打开
    await db.put('content', { id, chapters });
    await db.put('books', book);
  } catch(e){
    console.warn('入库失败（可能是存储空间不足）', name, e);
    try { await db.delete('content', id); } catch(_){}
    return -2;                                // -2 = 写入失败（不写缓存，允许重试）
  }
  return 1;
}

/* ---------- 并发池：读盘/IPC/入库都靠它加速（CPU 部分仍串行） ---------- */
async function runPool(items, limit, worker){
  let cursor = 0;
  const runners = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for(let k=0;k<n;k++){
    runners.push((async ()=>{
      while(true){
        const idx = cursor++;
        if(idx >= items.length) return;
        try { await worker(items[idx], idx); }
        catch(e){ console.warn('处理失败', items[idx], e); }
      }
    })());
  }
  await Promise.all(runners);
}

/* ---------- 导入：选择目录（桌面端） ---------- */
async function importElectron(onProgress){
  const result = { imported:0, skipped:0, failed:0, total:0 };
  onProgress && onProgress('读取书库目录…');
  let res;
  try {
    const lastDir = (window.electronAPI.getSetting && await window.electronAPI.getSetting('lastBookDir')) || '';
    res = await window.electronAPI.openBookDirectory(lastDir);
  } catch(e){ console.warn('选择目录失败', e); return result; }
  if(!res || !res.files || !res.files.length) return result;

  if(res.dir && window.electronAPI.setSetting) await window.electronAPI.setSetting('lastBookDir', res.dir);
  const files = res.files;
  result.total = files.length;

  await runPool(files, 4, async (f, idx)=>{
    onProgress && onProgress(`解析 ${idx+1}/${files.length}：${f.name}`);
    try{
      const data = await window.electronAPI.readBookFile(f.path);
      if(!data){ result.failed++; return; }
      const text = decode(data);
      if(text.length < MIN_BYTES){ result.skipped++; return; }
      const r = await storeBook(f.name, text);
      if(r > 0) result.imported++; else if(r < 0) result.skipped++; else result.failed++;
    }catch(e){ console.warn('解析失败', f.name, e); result.failed++; }
  });
  return result;
}

/* ---------- 导入：选择目录（浏览器端） ---------- */
async function walkDirHandle(dirHandle, out, depth=0){
  if(depth>8) return;
  for await (const [name, handle] of dirHandle.entries()){
    if(handle.kind === 'file'){
      if(/\.(txt|md)$/i.test(name)) out.push({name, handle});
    } else if(handle.kind === 'directory'){
      if(/^(\.|node_modules|assets|__)/i.test(name)) continue;
      await walkDirHandle(handle, out, depth+1);
    }
  }
}

export async function pickAndImport(onProgress){
  const result = { imported:0, skipped:0, failed:0, total:0 };
  // 桌面端：走 Electron 原生目录对话框
  if(window.electronAPI && window.electronAPI.openBookDirectory){
    return importElectron(onProgress);
  }
  if(!('showDirectoryPicker' in window)){
    alert('当前浏览器不支持目录选择，请使用 Chrome / Edge 并经由本应用提供的本地服务器打开。');
    return result;
  }
  let dirHandle;
  try { dirHandle = await window.showDirectoryPicker(); }
  catch(e){ return result; }                        // 用户取消

  const files = [];
  await walkDirHandle(dirHandle, files);
  result.total = files.length;

  for(let i=0;i<files.length;i++){
    const {name, handle} = files[i];
    onProgress && onProgress(`解析 ${i+1}/${files.length}：${name}`);
    try{
      const file = await handle.getFile();
      if(file.size > MAX_BYTES || file.size < MIN_BYTES){ result.skipped++; continue; }
      const text = decode(await file.arrayBuffer());
      if(text.length < MIN_BYTES){ result.skipped++; continue; }
      const r = await storeBook(name, text);
      if(r > 0) result.imported++; else if(r < 0) result.skipped++; else result.failed++;
    }catch(e){ console.warn('解析失败', name, e); result.failed++; }
  }
  return result;
}

/* ---------- 全盘扫描入库（桌面端，边扫边入库） ---------- */
// 路径缓存：已经处理过的文件第二次扫描直接跳过，避免重复读盘
async function loadSeenPaths(){
  try { return (await getSetting('importedPaths', {})) || {}; } catch(e){ return {}; }
}
async function saveSeenPaths(map){
  try {
    const keys = Object.keys(map);
    if(keys.length > 20000){                      // 控制设置体积
      const trimmed = {};
      keys.slice(keys.length-20000).forEach(k=> trimmed[k] = 1);
      map = trimmed;
    }
    await setSetting('importedPaths', map);
  } catch(e){}
}

// 批次分发器：只注册一次全局监听，避免反复扫描叠加监听器
let batchSink = null;
let batchListenerReady = false;
function ensureBatchListener(){
  if(batchListenerReady) return;
  batchListenerReady = true;
  if(window.electronAPI && window.electronAPI.onScanProgress){
    window.electronAPI.onScanProgress(arg=>{
      if(batchSink && arg && Array.isArray(arg.batch) && arg.batch.length) batchSink(arg.batch);
    });
  }
}

export async function scanAndImport(onImport, onBook){
  const result = { supported:true, imported:0, skipped:0, failed:0, total:0, fatal:null };
  if(!(window.electronAPI && window.electronAPI.scanDiskForBooks)){
    result.supported = false;
    return result;
  }
  ensureBatchListener();

  const seen = await loadSeenPaths();
  const queued = new Set();
  let dirty = false;
  const waiting = [];        // 待入库队列
  let consumer = null;

  async function consume(){
    if(consumer) return consumer;
    consumer = (async ()=>{
      while(waiting.length){
        const batch = waiting.splice(0, 20);
        await runPool(batch, 4, async (f)=>{
          onImport && onImport(`入库 ${result.imported+result.skipped+result.failed+1}：${f.name}`, 0, 0);
          try{
            const data = await window.electronAPI.readBookFile(f.path);
            if(!data){ result.failed++; return; }
            const text = decode(data);
            if(text.length < MIN_BYTES){ result.skipped++; seen[f.path]=1; dirty=true; return; }
            const r = await storeBook(f.name, text);
            if(r > 0){ result.imported++; onBook && onBook(); }
            else if(r < 0 && r !== -2) result.skipped++;
            else result.failed++;
            if(r !== -2){ seen[f.path] = 1; dirty = true; }   // 写入失败的留待下次重试
          }catch(e){ console.warn('入库失败', f.path, e); result.failed++; }
        });
      }
    })();
    await consumer;
    consumer = null;
  }

  const enqueue = (files)=>{
    const fresh = [];
    for(const f of files||[]){
      if(!f || !f.path) continue;
      if(queued.has(f.path) || seen[f.path]) continue;
      queued.add(f.path);
      fresh.push(f);
    }
    result.total = queued.size;
    if(fresh.length){ waiting.push(...fresh); consume(); }
  };

  batchSink = enqueue;                       // 扫描过程中源源不断回传的批次
  try{
    // 渲染端硬超时：万一主进程扫描卡死（如盘符无响应），最多等 5 分钟就放手，
    // 绝不让"扫描中"弹窗永远转圈；已收到的批次仍会尽量入库。
    const res = await Promise.race([
      window.electronAPI.scanDiskForBooks(),
      new Promise((_, rej)=> setTimeout(()=> rej(new Error('扫描超时（主进程 5 分钟未返回，已中止）')), 5*60*1000))
    ]);
    if(res && Array.isArray(res.files)) enqueue(res.files);   // 兜底：收尾时的完整清单
  } catch(e){
    console.warn('全盘扫描失败', e);
    result.fatal = (e && e.message) || String(e);            // 记录真实错误，供 UI 提示
  } finally {
    batchSink = null;
  }

  // 等队列清空（带超时保护，绝不卡死界面）
  const deadline = Date.now() + 5*60*1000;
  while((consumer || waiting.length) && Date.now() < deadline){
    await new Promise(r=>setTimeout(r, 60));
  }
  // 只有正常完成才写路径缓存；中途失败/超时则保留未判定文件，下次可重试
  if(dirty && !result.fatal) await saveSeenPaths(seen);
  return result;
}

export function clearImportedPathCache(){ return setSetting('importedPaths', {}); }
