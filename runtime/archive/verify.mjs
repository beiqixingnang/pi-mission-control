import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export async function verifyArchive(directory) {
  const root=fs.realpathSync.native(directory),failures=[];let files=0,bytes=0;
  const lines=readline.createInterface({input:fs.createReadStream(path.join(root,'checksums.jsonl')),crlfDelay:Infinity});
  for await(const line of lines) {
    if(!line.trim())continue;const item=JSON.parse(line);
    try {
      if(typeof item.path!=='string'||path.isAbsolute(item.path)||item.path.split(/[\\/]/).includes('..'))throw Error('Unsafe checksum path');
      const file=fs.realpathSync.native(path.join(root,item.path));if(!file.startsWith(root+path.sep))throw Error('Checksum target is outside this archive');
      const stat=fs.statSync(file);if(stat.size!==item.bytes)throw Error('File length mismatch');
      const hash=createHash('sha256');for await(const data of fs.createReadStream(file))hash.update(data);
      if(hash.digest('hex')!==item.sha256)throw Error('SHA-256 mismatch');files++;bytes+=stat.size;
    }catch(error){failures.push({path:item.path,error:error.message});}
  }
  return {verified:failures.length===0,files,bytes,failures};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const result=await verifyArchive(process.argv[2]);console.log(JSON.stringify(result));if(!result.verified)process.exitCode=1;}
