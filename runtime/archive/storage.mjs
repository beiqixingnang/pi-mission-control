import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const privateKey = key => /^(?:thinking|reasoning|thinkingSignature|reasoningSignature|signature|system_?prompt|api_?key|authorization|password|secret|access_?token|refresh_?token|token)$/i.test(key);
export function sanitize(value, depth=0) {
  if(depth>128)throw Error('Archive metadata nesting exceeds 128 levels');
  if(Array.isArray(value))return value.map(v=>sanitize(v,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!privateKey(k)).map(([k,v])=>[k,sanitize(v,depth+1)]));
  return value;
}
export function safeJson(value) {return JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');}
export function writeJson(root, name, value) {
  const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify(value));
}
// A compact advisory index. A negative test can safely discard a candidate;
// positive matches are always verified against the original text.
export function bloom(text) {
  const words=new Uint32Array(256),s=text.toLowerCase();
  for(let i=0;i+1<s.length;i++) {
    const a=s.charCodeAt(i),b=s.charCodeAt(i+1),c=i+2<s.length?s.charCodeAt(i+2):0;
    for(const h of [Math.imul(a^0x9e37,65599)^b,Math.imul(Math.imul(a^0x85eb,65599)^b,65599)^c]) {
      const x=h>>>0;words[(x&8191)>>>5]|=1<<(x&31);
      const y=(Math.imul(x,0x45d9f3b)^x>>>16)>>>0;words[(y&8191)>>>5]|=1<<(y&31);
    }
  }
  return Buffer.from(words.buffer).toString('base64');
}
export class ArchiveStorage {
  constructor(root,db) {
    this.root=root;this.db=db;this.sequence=0;this.directoryMade=new Set();this.openAssets=new Set();
    this.chunkGet=db.prepare('SELECT path FROM chunks WHERE sha=?');
    this.chunkPut=db.prepare('INSERT INTO chunks VALUES(?,?,?)');
    this.segmentPut=db.prepare('INSERT INTO body_segments VALUES(?,?,?,?)');
    this.searchPut=db.prepare('INSERT INTO search_segments(body,part,path,before_text,bits) VALUES(?,?,?,?,?)');
  }
  body({search=true}={}) {return new BodyWriter(this,++this.sequence,search);}
  asset(){return new AssetWriter(this,++this.sequence);}
  close(){for(const asset of this.openAssets){try{fs.closeSync(asset.fd);}catch{}}this.openAssets.clear();}
  storeChunk(text) {
    const encoded=JSON.stringify({text}),sha=hash(encoded),existing=this.chunkGet.get(sha);
    if(existing)return existing.path;
    const name=`chunks/${sha.slice(0,2)}/${sha}.json`,dir=path.dirname(path.join(this.root,name));
    if(!this.directoryMade.has(dir)){fs.mkdirSync(dir,{recursive:true});this.directoryMade.add(dir);}
    fs.writeFileSync(path.join(this.root,name),encoded,{flag:'wx'});this.chunkPut.run(sha,name,Buffer.byteLength(encoded));return name;
  }
}
class AssetWriter {
  constructor(storage,id){this.s=storage;this.file=path.join(storage.root,`assets/.part-${id}`);fs.mkdirSync(path.dirname(this.file),{recursive:true});this.fd=fs.openSync(this.file,'wx');storage.openAssets.add(this);this.pending='';this.bytes=0;this.digest=createHash('sha256');}
  append(value){const text=value.replace(/\s/g,'');if(/[^A-Za-z0-9+/=]/.test(text))throw Error('Invalid embedded image base64');this.pending+=text;const n=Math.floor(this.pending.length/4)*4;if(n){const b=Buffer.from(this.pending.slice(0,n),'base64');this.pending=this.pending.slice(n);fs.writeSync(this.fd,b);this.digest.update(b);this.bytes+=b.length;}}
  finish(mimeType){if(this.pending){if(this.pending.length===1)throw Error('Incomplete embedded image base64');const b=Buffer.from(this.pending,'base64');fs.writeSync(this.fd,b);this.digest.update(b);this.bytes+=b.length;}fs.closeSync(this.fd);this.s.openAssets.delete(this);const sha256=this.digest.digest('hex'),ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'}[mimeType]??'bin',name=`assets/${sha256}.${ext}`,target=path.join(this.s.root,name);if(fs.existsSync(target))fs.unlinkSync(this.file);else fs.renameSync(this.file,target);const result={path:name,sha256,bytes:this.bytes,mimeType:mimeType??'application/octet-stream'};this.s.db.prepare('INSERT OR IGNORE INTO assets VALUES(?,?)').run(name,JSON.stringify(result));return result;}
}
class BodyWriter {
  constructor(storage,id,search) {
    this.s=storage;this.id=id;this.search=search;this.parts=0;this.chars=0;this.bytes=0;
    this.buffer=[];this.bufferBytes=0;this.preview='';this.previous='';this.carry='';this.large=false;this.hash=createHash('sha256');
  }
  append(value) {
    if(!value)return;
    let text=this.carry+value;this.carry='';
    if(/[\uD800-\uDBFF]$/.test(text)){this.carry=text.at(-1);text=text.slice(0,-1);}
    if(!text)return;this._append(text);
  }
  _append(text) {
    const bytes=Buffer.byteLength(text);this.chars+=text.length;this.bytes+=bytes;this.hash.update(text);
    if(this.preview.length<512)this.preview+=text.slice(0,512-this.preview.length);
    this.buffer.push(text);this.bufferBytes+=bytes;
    if(this.bytes>16384)this.large=true;
    if(this.bufferBytes>=256*1024)this.flush();
  }
  flush() {
    if(!this.buffer.length)return;const text=this.buffer.join(''),name=this.s.storeChunk(text);
    if(!this.parts)this.firstChunk=name;
    this.s.segmentPut.run(this.id,this.parts,name,text.length);
    if(this.search)this.s.searchPut.run(this.id,this.parts,name,this.previous,bloom(this.previous+text));
    this.previous=text.slice(-256);this.parts++;this.buffer=[];this.bufferBytes=0;
  }
  finish() {
    if(this.carry){this._append(this.carry);this.carry='';}
    const digest=this.hash.digest('hex');
    if(!this.large) {
      const text=this.buffer.join('');
      // Small bodies are indexed in exactly the same way; dedup storage keeps
      // their original text available to full-text verification.
      if(this.search&&text)this.s.searchPut.run(this.id,0,'','',bloom(text));
      return {id:this.id,text,preview:this.preview,chars:this.chars,bytes:this.bytes,sha256:digest,segments:this.parts};
    }
    this.flush();const result={id:this.id,preview:this.preview,chars:this.chars,bytes:this.bytes,sha256:digest,segments:this.parts,...(this.parts===1?{chunk:this.firstChunk}:{})};
    return result;
  }
}

/** Stream a JSON value as data, omitting only structural private keys. */
export class JsonBody {
  constructor(writer,onRedaction=()=>{}){this.writer=writer;this.onRedaction=onRedaction;this.frames=[];this.skipNext=false;this.skipDepth=0;this.skipString=false;this.string=false;this.done=false;}
  before() {const f=this.frames.at(-1);if(f?.array){if(!f.first)this.writer.append(',');f.first=false;}}
  feed(t) {
    const n=t.name;
    if(this.skipDepth){if(n==='startObject'||n==='startArray')this.skipDepth++;else if(n==='endObject'||n==='endArray')this.skipDepth--;return;}
    if(this.skipString){if(n==='endString'){this.skipString=false;this.skipNext=false;}return;}
    if(n==='keyValue') {
      if(privateKey(t.value)){this.skipNext=true;this.onRedaction();return;}
      const f=this.frames.at(-1);if(!f.first)this.writer.append(',');f.first=false;this.writer.append(JSON.stringify(t.value)+':');return;
    }
    if(this.skipNext) {
      if(n==='startObject'||n==='startArray'){this.skipDepth=1;this.skipNext=false;}else if(n==='startString')this.skipString=true;else this.skipNext=false;
      return;
    }
    if(n==='startObject'||n==='startArray'){this.before();this.writer.append(n==='startObject'?'{':'[');this.frames.push({array:n==='startArray',first:true});}
    else if(n==='endObject'||n==='endArray'){this.writer.append(n==='endObject'?'}':']');this.frames.pop();if(!this.frames.length)this.done=true;}
    else if(n==='startString'){this.before();this.string=true;this.writer.append('"');}
    else if(n==='stringChunk')this.writer.append(JSON.stringify(t.value).slice(1,-1));
    else if(n==='endString'){this.writer.append('"');this.string=false;if(!this.frames.length)this.done=true;}
    else if(['numberValue','nullValue','trueValue','falseValue'].includes(n)){this.before();this.writer.append(n==='numberValue'?String(t.value):n==='nullValue'?'null':n==='trueValue'?'true':'false');if(!this.frames.length)this.done=true;}
  }
  finish(){return this.writer.finish();}
}
