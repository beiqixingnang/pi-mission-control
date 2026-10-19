import {exportMissionArchive} from './core.mjs';
const args=process.argv.slice(2),options={};
const names={'--state-dir':'stateDirectory','--session-file':'sessionFile','--session-id':'sessionId','--destination':'destination','--leaf-id':'leafId'};
for(let i=0;i<args.length;i++) {
  if(args[i]==='--active-members-only'){options.includeArchived=false;continue;}
  const key=names[args[i]];if(!key||!args[i+1])throw Error('Unknown or incomplete archive argument: '+args[i]);options[key]=args[++i];
}
for(const key of ['stateDirectory','sessionFile','destination'])if(!options[key])throw Error('Missing archive option: '+key);
const controller=new AbortController();process.on('SIGINT',()=>controller.abort(new Error('Archive cancelled')));process.on('SIGTERM',()=>controller.abort(new Error('Archive cancelled')));
let last=0;
options.signal=controller.signal;options.onProgress=value=>{if(Date.now()-last<250&&value.phase==='reading')return;last=Date.now();process.stdout.write(JSON.stringify({type:'progress',...value})+'\n');};
try{const result=await exportMissionArchive(options);process.stdout.write(JSON.stringify({type:'result',result})+'\n');}catch(error){process.stderr.write(String(error.stack??error)+'\n');process.exitCode=1;}
