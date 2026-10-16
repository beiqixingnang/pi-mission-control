// A real child process that emits visible progress and waits until cancelled.
process.stdout.write(JSON.stringify({type:'agent_start'})+'\n');
process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'PID:'+process.pid}})+'\n');
setInterval(()=>{},1000);
