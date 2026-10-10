import { spawn } from 'node:child_process';
import path from 'node:path';
import { readStreamRuntime } from './redis-query.mjs';
let holder;
process.once('exit',()=>{if(holder)holder.kill();});
function keepRuntime(root) {
  if(holder||process.platform!=='win32') return;
  const wslRoot='/mnt/'+root[0].toLowerCase()+root.slice(2).replaceAll('\\','/');
  holder=spawn('C:\\Windows\\System32\\wsl.exe',['-d','Ubuntu','--','bash',wslRoot+'/infra/runtime_hold.sh'],{cwd:root,windowsHide:true,detached:true,stdio:'ignore'});
  holder.once('error',()=>{holder=undefined;});holder.once('exit',()=>{holder=undefined;});holder.unref();
}
export async function publishStreamSnapshot(root,eventFile,progress) {
  const runtime=await readStreamRuntime();
  if(!runtime.configured) return {status:'unavailable',reason:'stream_runtime_not_configured'};
  keepRuntime(root);
  progress({stage:'analyzing',message:'正在将累计时长快照写入 Kafka，由 Flink 计算并更新 Redis…'});
  const python=process.env.STEAM_ATLAS_PYTHON||path.join(root,'.venv','Scripts','python.exe');
  return new Promise(resolve=>{
    const child=spawn(python,[path.join(root,'pipeline','stream_publish.py'),'--input',eventFile],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,STEAM_API_KEY:''}});
    let output='',finished=false;
    function finish(result){if(finished)return;finished=true;clearTimeout(timer);resolve(result);}
    const timer=setTimeout(()=>{
      if(process.platform==='win32')spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill();
      finish({status:'failed',reason:'stream_timeout'});
    },300000);
    child.stdout.on('data',chunk=>{output=(output+chunk.toString('utf8')).slice(-65536);});
    child.stderr.on('data',()=>{});
    child.once('error',()=>finish({status:'failed',reason:'stream_process_unavailable'}));
    child.once('close',code=>{
      try{
        const result=JSON.parse(output.trim().split(/\r?\n/).at(-1));
        if(code!==0||result.status!=='materialized')return finish({status:result.status||'failed',reason:result.reason||'stream_materialization_failed'});
        finish({...result,weightMode:'balanced'});
      }catch{finish({status:'failed',reason:'stream_invalid_result'});}
    });
  });
}


