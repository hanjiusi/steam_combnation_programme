import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const filename=root=>path.join(root,'data','private','steam-key.dpapi');
const base="$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$value=[Console]::In.ReadToEnd().Trim();$entropy=[Text.Encoding]::UTF8.GetBytes('SteamTasteAtlas-SteamWebAPI-v1');";
const scripts={
  protect:"$bytes=[Text.Encoding]::UTF8.GetBytes($value);$encrypted=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($encrypted))",
  unprotect:"$bytes=[Convert]::FromBase64String($value);$decrypted=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($decrypted))"
};
function crypt(operation,value){
  return new Promise((resolve,reject)=>{
    const child=spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-Command',base+scripts[operation]],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,STEAM_API_KEY:''}});
    let output='',settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);};
    const timer=setTimeout(()=>{child.kill();finish(new Error('Local key protection timed out'));},15000);
    child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');if(output.length>16384){child.kill();finish(new Error('Invalid protected-key response'));}});
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.once('error',()=>finish(new Error('Local key protection is unavailable')));
    child.once('close',code=>code===0?finish(null,output.trim()):finish(new Error('Local key protection failed')));
    child.stdin.end(value);
  });
}
export async function saveSteamKey(root,key){
  if(!/^[a-fA-F0-9]{32}$/.test(key))throw new Error('Invalid Steam key format');
  if(process.platform!=='win32')return {persistence:'memory'};
  const protectedValue=await crypt('protect',key);
  await mkdir(path.dirname(filename(root)),{recursive:true});
  await writeFile(filename(root),protectedValue,{encoding:'utf8',mode:0o600});
  return {persistence:'windows-current-user-encrypted'};
}
export async function readSteamKey(root){
  if(process.platform!=='win32')return '';
  try{
    const protectedValue=await readFile(filename(root),'utf8');
    if(protectedValue.length>16384)return '';
    const key=await crypt('unprotect',protectedValue);
    return /^[a-fA-F0-9]{32}$/.test(key)?key:'';
  }catch{return '';}
}

