import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const PORT=9353;
const CHROME=[path.join(os.homedir(),".cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe"),"C:/Program Files/Google/Chrome/Application/chrome.exe"].find(p=>p&&fs.existsSync(p));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),"phdr-"));
const chrome=spawn(CHROME,["--headless=new",`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,"--no-first-run","--disable-gpu","about:blank"],{stdio:"ignore"});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let wsUrl=null;
for(let i=0;i<60;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/version`);wsUrl=(await r.json()).webSocketDebuggerUrl;if(wsUrl)break;}catch{}await sleep(250);}
const ws=new WebSocket(wsUrl); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
let id=0; const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
const send=(method,params={},sessionId)=>new Promise(res=>{const myId=++id;pending.set(myId,res);ws.send(JSON.stringify({id:myId,method,params,...(sessionId?{sessionId}:{})}));});
const t=await send("Target.createTarget",{url:"about:blank"});
const a=await send("Target.attachToTarget",{targetId:t.result.targetId,flatten:true});
const sessionId=a.result.sessionId;
await send("Page.enable",{},sessionId); await send("Runtime.enable",{},sessionId);
const evalJs=async expr=>{const r=await send("Runtime.evaluate",{expression:expr,awaitPromise:true,returnByValue:true},sessionId);return r.result?.result?.value;};
await send("Page.navigate",{url:"http://127.0.0.1:8900"},sessionId);
await sleep(2600);
await send("Emulation.setDeviceMetricsOverride",{width:360,height:640,deviceScaleFactor:1,mobile:true},sessionId);
await sleep(1000);
const out=await evalJs(`(()=>{
  const h=document.querySelector("header");
  const R=el=>{const b=el.getBoundingClientRect();return {tag:el.tagName+(el.id?"#"+el.id:""),top:Math.round(b.top),bottom:Math.round(b.bottom),h:Math.round(b.height),w:Math.round(b.width)};};
  return {header:R(h),h:h.getBoundingClientRect().height,kids:[...h.children].map(R)};
})()`);
console.log(JSON.stringify(out,null,2));
ws.close();chrome.kill();try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
process.exit(0);
