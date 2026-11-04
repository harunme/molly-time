import fs from 'node:fs/promises';
const base=new URL('../',import.meta.url);
const source=await fs.readFile(new URL('source/symbol.svg',base),'utf8');
const [m,flower]=source.match(/<path\b[^>]*\/>/g);
// Keep five petals visible from the start; gently unfurl while turning into place.
const openPath=flower.match(/d="([^"]+)"/)[1];
const budPath=openPath.replaceAll('A14 14', 'A17 17');
const markPath=m.match(/d="([^"]+)"/)[1];
const clamp=t=>Math.max(0,Math.min(1,t));
const smooth=t=>{t=clamp(t);return t*t*(3-2*t)};
const out=t=>1-(1-clamp(t))**3;
// Hold each crest and its tangent handles at the same height; blend only at the valley.
const fold=(x,y,left,right)=>{
 if(y<=110){const w=smooth((x-110)/32);return 24*((1-left)*(1-w)+(1-right)*w)}
 return x>=183&&y<=175?12*(1-right):0;
};
const markShape=(left,right)=>{
 let currentX=0;
 return markPath.replace(/([MVCZ])([^MVCZ]*)/g,(_,command,args)=>{
  const values=(args.match(/-?\d*\.?\d+/g)||[]).map(Number);
  if(command==='V') values[0]+=fold(currentX,values[0],left,right);
  else if(command==='M'||command==='C'){
   for(let i=0;i<values.length;i+=2) values[i+1]+=fold(values[i],values[i+1],left,right);
   currentX=values[values.length-2];
  }
  return command+values.map(v=>+v.toFixed(4)).join(' ');
 });
};
// Three visible crests travel left -> right -> left, then decay to level.
const leftWave=[[890,0],[990,1.22],[1100,.92],[1220,1.14],[1340,.99],[1460,1]];
const rightWave=[[970,0],[1100,1.18],[1220,.96],[1340,1.025],[1460,1]];
const wave=(ms,frames)=>{
 if(ms<=frames[0][0]) return frames[0][1];
 for(let i=0;i<frames.length-1;i++){
  const [start,a]=frames[i],[end,b]=frames[i+1];
  if(ms<=end){const t=(ms-start)/(end-start);return a+(b-a)*(i===0?out(t):smooth(t))}
 }
 return frames.at(-1)[1];
};
// Sample both curves together so the arch and supporting flower remain attached.
const motionFrames=Array.from({length:58},(_,i)=>{
 const ms=890+i*10;
 return {percent:+(i*10/570*100).toFixed(6),left:wave(ms,leftWave),right:wave(ms,rightWave)};
});
const shapeFrames=motionFrames.map(f=>`${f.percent}% {d:path('${markShape(f.left,f.right)}')}`).join('\n');
const carryFrames=motionFrames.map(f=>`${f.percent}% {transform:translateY(${+(12*(1-f.right)).toFixed(5)}px)}`).join('\n');
const pose='translate(120 130) scale(1.02) translate(-128 -128)';
// Brisk turn and blossom; the M springs open on the /t/ attack. Keep the 1.8 s cue.
const style=`
.molly-mark { animation:molly-fade 300ms cubic-bezier(.333333,0,.666667,1) both; }
.molly-pose { transform-box:view-box; transform-origin:128px 128px; animation:molly-upright 360ms cubic-bezier(.333333,1,.666667,1) 240ms both; }
.molly-m path { animation:molly-shape 570ms linear 890ms both; }
.molly-carry { animation:molly-carry 570ms linear 890ms both; }
.molly-flower,.molly-flower path { animation-duration:820ms; animation-delay:300ms; animation-timing-function:cubic-bezier(.333333,1,.666667,1); animation-fill-mode:both; }
.molly-flower { transform-box:view-box; transform-origin:211px 188px; animation-name:molly-bloom; }
.molly-flower path { animation-name:molly-petals; }
@keyframes molly-upright { from {transform:rotate(-25deg)} to {transform:rotate(0deg)} }
@keyframes molly-shape { ${shapeFrames} }
@keyframes molly-carry { ${carryFrames} }
@keyframes molly-petals { from {d:path('${budPath}')} to {d:path('${openPath}')} }
@keyframes molly-fade { from {opacity:0} to {opacity:1} }
@keyframes molly-bloom { from {transform:rotate(-24deg) scale(.12)} to {transform:rotate(0deg) scale(1)} }
@media(prefers-reduced-motion:reduce) {.molly-mark,.molly-pose,.molly-m path,.molly-carry,.molly-flower,.molly-flower path {animation:none!important}}
`;
const svg=()=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-48 -48 352 352" role="img" aria-labelledby="motion-title"><title id="motion-title">MollyTime — 茉莉花轻轻绽放</title><style>${style}</style><g class="molly-mark" fill="#F8DE7E"><g transform="${pose}"><g class="molly-pose"><g class="molly-m">${m}</g><g class="molly-carry"><g class="molly-flower">${flower}</g></g></g></g></g></svg>`;
await fs.writeFile(new URL('motion/mollytime-animated.svg',base),svg());
// Keep the legacy filename compatible, but never repeat the entrance.
await fs.writeFile(new URL('motion/mollytime-animated-loop.svg',base),svg());
// Keep the review page self-contained without changing the source audio asset.
let previewAudio='';
try {
 const audio=await fs.readFile(new URL('../../../../apps/ios/MollyTime/Resources/startup/sound.mp3',import.meta.url));
 previewAudio=`data:audio/mpeg;base64,${audio.toString('base64')}`;
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await fs.writeFile(new URL('motion/preview.html',base),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MollyTime · 动态 Logo</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#211F1B;color:#FAFAF4;font:16px system-ui;display:grid;place-items:center}main{width:min(90vw,640px);text-align:center}.stage{height:min(66vh,520px);display:grid;place-items:center}.stage svg{width:min(100%,420px);overflow:visible}h1{font-size:24px;letter-spacing:-.5px;margin:0 0 12px}p{color:#B8B1A3;font-size:14px}button{font:inherit;cursor:pointer;padding:10px 20px;border:1px solid #5B5447;border-radius:99px;background:transparent;color:inherit;margin:8px}button:first-child{background:#F8DE7E;color:#3F3A32;border-color:transparent}input{width:min(90%,360px);accent-color:#F8DE7E;margin-top:16px}</style><main><audio id="cue" preload="auto" src="${previewAudio}"></audio><div class="stage">${svg()}</div><h1>MollyTime</h1><p>随声舒展 · 波浪回弹</p><div><button id="replay">${previewAudio?'重新播放（含音效）':'重新播放'}</button><button id="theme">切换背景</button><button id="pause">暂停</button></div><p id="audio-status" role="status"></p><input aria-label="动画进度" type="range" min="0" max="1800" value="0" step="1"></main><script>
const mark=document.querySelector('svg'),range=document.querySelector('input'),sound=document.querySelector('#cue'),pauseButton=document.querySelector('#pause');
let paused=false,light=false,generation=0,base=0,started=performance.now();
const animations=()=>mark.getAnimations({subtree:true});
const seek=time=>{animations().forEach(a=>{a.pause();a.currentTime=time});range.value=time};
async function playFrom(time){
 const current=++generation;
 paused=true;sound.pause();seek(time);
 document.querySelector('#audio-status').textContent='';
 if(sound.getAttribute('src')){
  sound.currentTime=time/1000;
  try {await sound.play()} catch {document.querySelector('#audio-status').textContent='音效暂时无法播放，正在播放无声预览'}
 }
 if(current!==generation){sound.pause();return}
 const cueTime=sound.paused?time:sound.currentTime*1000;
 animations().forEach(a=>{a.currentTime=cueTime;a.play()});
 base=cueTime;started=performance.now();paused=false;pauseButton.textContent='暂停';
}
document.querySelector('#replay').onclick=()=>playFrom(0);
pauseButton.onclick=()=>{
 if(paused){void playFrom(+range.value>=1800?0:+range.value);return}
 ++generation;paused=true;sound.pause();animations().forEach(a=>a.pause());pauseButton.textContent='继续';
};
document.querySelector('#theme').onclick=()=>{light=!light;document.body.style.background=light?'#FAFAF4':'#211F1B';document.body.style.color=light?'#3F3A32':'#FAFAF4'};
range.oninput=()=>{++generation;paused=true;sound.pause();seek(+range.value);pauseButton.textContent='继续'};
function update(){
 if(!paused){
  const time=Math.min(1800,sound.paused?base+performance.now()-started:sound.currentTime*1000);
  range.value=time;
  if(time>=1800){paused=true;pauseButton.textContent='继续'}
 }
 requestAnimationFrame(update);
}
requestAnimationFrame(update);
</script></html>`);
console.log('Built animated SVGs and interactive preview.');
