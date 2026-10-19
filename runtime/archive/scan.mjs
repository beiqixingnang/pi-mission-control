import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Transform,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import Parser from 'stream-json/Parser.js';

export function nativePath(value) {
  if(process.platform!=='win32'&&/^[a-z]:[\\/]/i.test(value))return '/mnt/'+value[0].toLowerCase()+'/'+value.slice(3).replace(/\\/g,'/');
  if(process.platform==='win32'&&/^\/mnt\/[a-z]\//i.test(value))return value[5].toUpperCase()+':/'+value.slice(7);
  return value;
}
export function canonical(file){const p=fs.realpathSync.native(nativePath(file));return process.platform==='win32'?p.toLowerCase():p;}
export function inside(file,base){return file===base||file.startsWith(base+path.sep);}
export function captureFile(file,allowedRoots) {
  const native=nativePath(file),name=canonical(native);
  if(!allowedRoots.some(root=>inside(name,root)))throw Error('Session source is outside the selected session roots: '+file);
  if(fs.lstatSync(native).isSymbolicLink())throw Error('Symbolic-link session files are not exported: '+file);
  const fd=fs.openSync(native,'r'),stat=fs.fstatSync(fd);
  if(!stat.isFile()){fs.closeSync(fd);throw Error('Session source is not a regular file: '+file);}
  const buffer=Buffer.alloc(32768);let end=stat.size;
  while(end>0){const length=Math.min(buffer.length,end),start=end-length;fs.readSync(fd,buffer,0,length,start);const i=buffer.lastIndexOf(10,length-1);if(i>=0){end=start+i+1;break;}end=start;}
  return {fd,file:path.resolve(native),canonical:name,size:stat.size,end,incompleteTail:stat.size-end,capturedAt:new Date().toISOString(),dev:stat.dev,ino:stat.ino};
}

/** Primitive strings and keys stay streamed. No complete entry is assembled. */
export async function scanJson(source,handlers={},signal) {
  signal?.throwIfAborted();let bytes=0,first=true,key,number,stringPath,numberPath,records=0;
  const digest=createHash('sha256'),stack=[];
  const valuePath=()=>{const f=stack.at(-1);return f?[...f.path,f.array?f.index:f.key]:[];};
  const advance=()=>{const f=stack.at(-1);if(f?.array)f.index++;};
  const consume=token=>{
    const n=token.name;
    if(n==='startKey'){key='';return;}
    if(n==='stringChunk'&&key!==undefined){key+=token.value;if(key.length>65536)throw Error('JSON property name exceeds the supported 64 KiB bound');return;}
    if(n==='endKey'){stack.at(-1).key=key;handlers.token?.({name:'keyValue',value:key},stack.at(-1).path);key=undefined;return;}
    if(n==='startNumber'){number='';numberPath=valuePath();return;}
    if(n==='numberChunk'){number+=token.value;if(number.length>128)throw Error('JSON number exceeds the supported bound');return;}
    if(n==='endNumber'){handlers.token?.({name:'numberValue',value:number},numberPath);number=undefined;advance();return;}
    if(n==='startObject'||n==='startArray') {
      const p=valuePath();if(!stack.length){if(n!=='startObject')throw Error('A Pi JSONL record must be an object');records++;handlers.start?.(records);}
      stack.push({path:p,array:n==='startArray',index:0,key:undefined});if(stack.length>512)throw Error('JSON nesting exceeds 512 levels');handlers.token?.(token,p);
    } else if(n==='endObject'||n==='endArray') {
      const f=stack.pop();handlers.token?.(token,f.path);advance();if(!stack.length)handlers.end?.(records);
    } else if(n==='startString'){stringPath=valuePath();handlers.token?.(token,stringPath);}
    else if(n==='stringChunk')handlers.token?.(token,stringPath);
    else if(n==='endString'){handlers.token?.(token,stringPath);advance();stringPath=undefined;}
    else if(['nullValue','trueValue','falseValue'].includes(n)){handlers.token?.(token,valuePath());advance();}
  };
  try {
    if(source.end)await pipeline(fs.createReadStream(source.file,{fd:source.fd,autoClose:false,start:0,end:source.end-1,highWaterMark:32768}),
      new Transform({transform(chunk,_encoding,done){try{signal?.throwIfAborted();bytes+=chunk.length;digest.update(chunk);if(first){first=false;if(chunk.subarray(0,3).equals(Buffer.from([239,187,191])))chunk=chunk.subarray(3);}handlers.progress?.(bytes);done(null,chunk);}catch(e){done(e);}}}),
      new Parser({jsonStreaming:true,packKeys:false,streamKeys:true,packStrings:false,streamStrings:true,packNumbers:false,streamNumbers:true}),
      new Writable({objectMode:true,write(token,_encoding,done){try{consume(token);done();}catch(e){done(e);}}}));
    const after=fs.fstatSync(source.fd);if(after.size<source.end||after.ino!==source.ino||after.dev!==source.dev)throw Error('Session source was truncated or replaced during export');
    return {records,bytes,sha256:digest.digest('hex'),appendedBytes:Math.max(0,after.size-source.size)};
  } finally { /* The caller owns the captured descriptor through all passes. */ }
}
