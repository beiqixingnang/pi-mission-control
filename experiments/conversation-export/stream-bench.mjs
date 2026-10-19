// Research benchmark only: this measures byte/token streaming, not a production
// public-export policy. Real logs are hashed/count-only; no bodies are retained.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Transform, Writable} from 'node:stream';
import Parser from 'stream-json/Parser.js';

const [operation, source, destination, mode = 'hash'] = process.argv.slice(2);
if (!['generate', 'scan'].includes(operation) || !source || !destination)
  throw Error('generate <fixture.jsonl> <expected.json> | scan <file> <report.json> [hash|sink]');
fs.mkdirSync(path.dirname(path.resolve(destination)), {recursive:true});

if (operation === 'generate') {
  fs.mkdirSync(path.dirname(path.resolve(source)), {recursive:true});
  const output = fs.openSync(source, 'wx');
  const hash = crypto.createHash('sha256');
  const fragment = ('源码中文🙂 / line\n </script><img src=x onerror=alert(1)> \\ " \u2028END\n').repeat(750);
  const repetitions = Math.ceil(128 * 1024 * 1024 / Buffer.byteLength(fragment));
  let textBytes = 0;
  fs.writeSync(output, '{"type":"message","id":"giant","message":{"role":"toolResult","toolName":"read","content":[{"type":"text","text":"');
  for(let i=0;i<repetitions;i++) {
    fs.writeSync(output, JSON.stringify(fragment).slice(1,-1));
    hash.update(fragment); textBytes += Buffer.byteLength(fragment);
  }
  const tail='SENTINEL_GIANT_TEXT_END_完整🙂';
  fs.writeSync(output, JSON.stringify(tail).slice(1,-1));
  hash.update(tail);textBytes+=Buffer.byteLength(tail);
  fs.writeSync(output, '"}]}}\n');
  // A second, equally large non-display extension value must not be assembled.
  fs.writeSync(output, '{"type":"custom","customType":"old-snapshot","data":{"payload":"');
  const padding='z'.repeat(64*1024);
  for(let i=0;i<2048;i++)fs.writeSync(output,padding);
  fs.writeSync(output,'"}}\n');
  // An actively written incomplete last record is intentionally excluded.
  fs.writeSync(output,'{"type":"message","message":{"role":"assistant","content":"UNFINISHED');
  fs.closeSync(output);
  const expected={textBytes,sha256:hash.digest('hex'),completeRecords:2,fileBytes:fs.statSync(source).size};
  fs.writeFileSync(destination,JSON.stringify(expected,null,2)+'\n');
  console.log(JSON.stringify(expected));
} else {
  const started=performance.now(),stat=fs.statSync(source);
  // Freeze the last complete LF record at the original EOF. New appends cannot
  // change this run's range; this is per-file, not an atomic multi-file barrier.
  const fd=fs.openSync(source,'r'),scratch=Buffer.alloc(64*1024);
  let end=stat.size;
  while(end>0) {
    const n=Math.min(scratch.length,end),start=end-n;
    fs.readSync(fd,scratch,0,n,start);
    const lf=scratch.lastIndexOf(10,n-1);
    if(lf>=0) {end=start+lf+1;break;}
    end=start;
  }
  fs.closeSync(fd);
  if(!end)throw Error('No complete LF record');
  const stats={source:path.basename(source),sourceBytes:stat.size,frozenBytes:end,incompleteTailBytes:stat.size-end,
    records:0,messageRecords:0,compactionRecords:0,otherRecords:0,selectedTextFields:0,textBytes:0,
    maxInputChunk:0,maxStringToken:0,peakRss:0,peakHeap:0,sourceSha256:'',textSha256:'',completed:false};
  const measure=()=> {const m=process.memoryUsage();stats.peakRss=Math.max(stats.peakRss,m.rss);stats.peakHeap=Math.max(stats.peakHeap,m.heapUsed);};
  const sampling=setInterval(measure,20);sampling.unref();
  const sourceHash=crypto.createHash('sha256'),textHash=crypto.createHash('sha256');
  const sink=mode==='sink'?fs.openSync(destination+'.body.bin','wx'):undefined;
  const stack=[];
  let stringPath,metaKey,metaValue='',selected=false,carry='',rootType='',count=0;
  const valuePath=()=> {const top=stack.at(-1);return top?[...top.path,top.type==='array'?top.index:top.key]:[];};
  const advance=()=>{const top=stack.at(-1);if(top?.type==='array')top.index++;};
  const append=(value,final=false)=> {
    let text=carry+value;carry='';
    if(!final&&/[\uD800-\uDBFF]$/.test(text)){carry=text.at(-1);text=text.slice(0,-1);}
    if(!text)return;const b=Buffer.from(text);textHash.update(b);stats.textBytes+=b.length;if(sink!==undefined)fs.writeSync(sink,b);
  };
  const consume=(token)=> {
    const n=token.name;
    if(n==='startObject'||n==='startArray') {
      stack.push({path:valuePath(),type:n==='startArray'?'array':'object',index:0,key:undefined});
    } else if(n==='endObject'||n==='endArray') {
      stack.pop();advance();
      if(!stack.length){stats.records++;if(rootType==='message')stats.messageRecords++;else if(rootType==='compaction')stats.compactionRecords++;else stats.otherRecords++;rootType='';}
    } else if(n==='keyValue')stack.at(-1).key=token.value;
    else if(n==='startString') {
      stringPath=valuePath();metaKey=stringPath.length===1?stringPath[0]:undefined;metaValue='';carry='';
      selected=(stringPath.length===1&&stringPath[0]==='summary')||
        (stringPath[0]==='message'&&stringPath[1]==='content'&&(stringPath.length===2||
         (stringPath.length===4&&typeof stringPath[2]==='number'&&stringPath[3]==='text')));
      if(selected)stats.selectedTextFields++;
    } else if(n==='stringChunk') {
      stats.maxStringToken=Math.max(stats.maxStringToken,token.value.length);
      if(metaKey==='type'&&metaValue.length<100)metaValue+=token.value.slice(0,100-metaValue.length);
      if(selected)append(token.value);
    } else if(n==='endString') {
      if(selected)append('',true);if(metaKey==='type')rootType=metaValue;
      selected=false;metaKey=undefined;advance();
    } else if(['numberValue','nullValue','trueValue','falseValue'].includes(n))advance();
    if(++count%10000===0)measure();
  };
  try {
    await pipeline(fs.createReadStream(source,{start:0,end:end-1,highWaterMark:32*1024}),
      new Transform({transform(chunk,_encoding,done){stats.maxInputChunk=Math.max(stats.maxInputChunk,chunk.length);sourceHash.update(chunk);done(null,chunk);}}),
      new Parser({jsonStreaming:true,packKeys:true,streamKeys:false,packStrings:false,streamStrings:true,packNumbers:true,streamNumbers:false}),
      new Writable({objectMode:true,write(token,_encoding,done){try{consume(token);done();}catch(e){done(e);}}}));
    stats.completed=true;
  } finally {clearInterval(sampling);measure();if(sink!==undefined)fs.closeSync(sink);}
  stats.sourceSha256=sourceHash.digest('hex');stats.textSha256=textHash.digest('hex');
  stats.elapsedMs=Math.round(performance.now()-started);stats.tokens=count;
  stats.maxRssFromProcess=process.resourceUsage().maxRSS*1024;
  fs.writeFileSync(destination,JSON.stringify(stats,null,2)+'\n');console.log(JSON.stringify(stats));
}
