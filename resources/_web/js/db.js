// db.js — IndexedDB 持久层（书库元数据 / 正文 / 设置 / 成就 / 音乐）
const DB_NAME = 'juanwei-reader';
const DB_VER = 1;

let _db = null;

export function openDB(){
  if(_db) return Promise.resolve(_db);
  return new Promise((res,rej)=>{
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e=>{
      const db = e.target.result;
      if(!db.objectStoreNames.contains('books'))
        db.createObjectStore('books',{keyPath:'id'});
      if(!db.objectStoreNames.contains('content'))
        db.createObjectStore('content',{keyPath:'id'});
      if(!db.objectStoreNames.contains('settings'))
        db.createObjectStore('settings',{keyPath:'key'});
      if(!db.objectStoreNames.contains('achievements'))
        db.createObjectStore('achievements',{keyPath:'id'});
      if(!db.objectStoreNames.contains('music'))
        db.createObjectStore('music',{keyPath:'id'});
    };
    req.onsuccess = ()=>{_db=req.result;res(_db)};
    req.onerror = ()=>rej(req.error);
  });
}

function tx(store, mode){
  return openDB().then(db=>db.transaction(store,mode).objectStore(store));
}
function wrap(req){
  return new Promise((res,rej)=>{req.onsuccess=()=>res(req.result);req.onerror=()=>rej(req.error);});
}

export const db = {
  put(store,val){ return tx(store,'readwrite').then(s=>wrap(s.put(val))); },
  get(store,key){ return tx(store,'readonly').then(s=>wrap(s.get(key))); },
  getAll(store){ return tx(store,'readonly').then(s=>wrap(s.getAll())); },
  delete(store,key){ return tx(store,'readwrite').then(s=>wrap(s.delete(key))); },
  async clear(store){ return tx(store,'readwrite').then(s=>wrap(s.clear())); }
};

// 设置快捷读写
export async function getSetting(key, fallback){
  const r = await db.get('settings', key);
  return r ? r.value : fallback;
}
export async function setSetting(key, value){
  return db.put('settings', {key, value});
}
