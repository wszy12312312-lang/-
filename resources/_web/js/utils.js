// utils.js — 通用工具
export function hashStr(s){
  let h = 5381;
  for(let i=0;i<s.length;i++) h = ((h<<5)+h + s.charCodeAt(i))|0;
  return (h>>>0).toString(36);
}

// 中文按字计 + 英文按词计
export function countWords(text){
  if(!text) return 0;
  const cjk = (text.match(/[一-鿿]/g)||[]).length;
  const en = (text.replace(/[一-鿿]/g,' ').match(/[A-Za-z0-9]+/g)||[]).length;
  return cjk + en;
}

// 依据字符串生成稳定的书脊颜色（柔和莫兰迪色系）
const PALETTE = [
  ['#6b8e9e','#4f6e7e'],['#a9716b','#7d4f4a'],['#7d8a5a','#58633d'],
  ['#8a7aa0','#5f5378'],['#5e8a86','#3f605d'],['#b08a5a','#7d6240'],
  ['#9a6b8a','#6d4a61'],['#6b6b6b','#4a4a4a'],['#5a7d8a','#3f5863'],
  ['#a98a6b','#7d6249']
];
export function colorFor(str){
  let h=0; for(let i=0;i<str.length;i++) h=(h*31+str.charCodeAt(i))>>>0;
  return PALETTE[h % PALETTE.length];
}
export function gradientFor(str){
  const [a,b]=colorFor(str);
  return `linear-gradient(160deg,${a},${b})`;
}

// 书脊尺寸（稳定、错落有致：高度由书名决定，厚度（宽）随字数增大）
export function dimsFor(str, totalWords){
  let h=0; for(let i=0;i<str.length;i++) h=(h*37+str.charCodeAt(i))>>>0;
  const height = 168 + (h % 132);                       // 168~299，高度错落更明显
  let width = 30;
  if(totalWords && totalWords>0){
    width = Math.round(Math.min(66, 28 + Math.log10(totalWords+1)*10)); // 字数越多越"厚"
  }
  width = Math.max(26, width) + ((h>>5) % 8);            // 叠加少量随机错落
  return {height, width};
}

export function escapeHtml(s){
  return (s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

export function debounce(fn,ms){
  let t; return (...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};
}

let _toastTimer;
export function toast(msg, ms){
  const el = document.getElementById('toast');
  if(!el) return;
  el.textContent = msg; el.hidden=false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(()=>el.hidden=true, ms || 2200);
}

export function fmtDate(ts){
  const d=new Date(ts);
  const p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}
