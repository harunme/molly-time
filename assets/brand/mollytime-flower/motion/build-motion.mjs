import fs from 'node:fs/promises';
const base=new URL('../',import.meta.url);
const source=await fs.readFile(new URL('source/symbol.svg',base),'utf8');
const [m,flower]=source.match(/<path\b[^>]*\/>/g);
// Keep five petals visible from the start; gently unfurl while turning into place.
const openPath=flower.match(/d="([^"]+)"/)[1];
const budPath=openPath.replaceAll('A14 14', 'A17 17');
const pose='translate(120 130) scale(1.02) translate(-128 -128)';
// A 300 ms fade introduces a small bud; growth and petal unfolding finish at 1.8 s.
// The cubic's linear x coordinates make its easing match native smoothstep.
const style=`
.molly-mark { animation:molly-fade 300ms cubic-bezier(.333333,0,.666667,1) both; }
.molly-pose,.molly-m,.molly-flower,.molly-flower path {
 animation-duration:1500ms; animation-delay:300ms;
 animation-timing-function:cubic-bezier(.333333,0,.666667,1); animation-fill-mode:both;
}
.molly-pose { transform-box:view-box; transform-origin:128px 128px; animation-name:molly-upright; }
.molly-m { transform-box:view-box; transform-origin:126px 213px; animation-name:molly-unfold; }
.molly-flower { transform-box:view-box; transform-origin:211px 188px; animation-name:molly-bloom; }
.molly-flower path { animation-name:molly-petals; }
@keyframes molly-upright { from {transform:rotate(-25deg)} to {transform:rotate(0deg)} }
@keyframes molly-unfold { from {transform:scale(.88)} to {transform:scale(1)} }
@keyframes molly-petals { from {d:path('${budPath}')} to {d:path('${openPath}')} }
@keyframes molly-fade { from {opacity:0} to {opacity:1} }
@keyframes molly-bloom { from {transform:rotate(-24deg) scale(.12)} to {transform:rotate(0deg) scale(1)} }
@media(prefers-reduced-motion:reduce) {.molly-mark,.molly-pose,.molly-m,.molly-flower,.molly-flower path {animation:none!important}}
`;
const svg=()=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-48 -48 352 352" role="img" aria-labelledby="motion-title"><title id="motion-title">MollyTime — 茉莉花轻轻绽放</title><style>${style}</style><g class="molly-mark" fill="#F8DE7E"><g transform="${pose}"><g class="molly-pose"><g class="molly-m">${m}</g><g class="molly-flower">${flower}</g></g></g></g></svg>`;
await fs.writeFile(new URL('motion/mollytime-animated.svg',base),svg());
// Keep the legacy filename compatible, but never repeat the entrance.
await fs.writeFile(new URL('motion/mollytime-animated-loop.svg',base),svg());
await fs.writeFile(new URL('motion/preview.html',base),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MollyTime · 动态 Logo</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#211F1B;color:#FAFAF4;font:16px system-ui;display:grid;place-items:center}main{width:min(90vw,640px);text-align:center}.stage{height:min(66vh,520px);display:grid;place-items:center}.stage svg{width:min(100%,420px);overflow:visible}h1{font-size:24px;letter-spacing:-.5px;margin:0 0 12px}p{color:#B8B1A3;font-size:14px}button{font:inherit;cursor:pointer;padding:10px 20px;border:1px solid #5B5447;border-radius:99px;background:transparent;color:inherit;margin:8px}button:first-child{background:#F8DE7E;color:#3F3A32;border-color:transparent}input{width:min(90%,360px);accent-color:#F8DE7E;margin-top:16px}</style><main><div class="stage">${svg()}</div><h1>MollyTime</h1><p>轻轻绽放 · 安静陪伴</p><div><button id="replay">重新播放</button><button id="theme">切换背景</button><button id="pause">暂停</button></div><input aria-label="动画进度" type="range" min="0" max="1800" value="0" step="1"></main><script>const mark=document.querySelector('svg'),range=document.querySelector('input');let paused=false,light=false;const animations=()=>mark.getAnimations({subtree:true});document.querySelector('#replay').onclick=()=>{animations().forEach(a=>{a.currentTime=0;a.play()});paused=false;document.querySelector('#pause').textContent='暂停'};document.querySelector('#pause').onclick=()=>{paused=!paused;animations().forEach(a=>paused?a.pause():a.play());document.querySelector('#pause').textContent=paused?'继续':'暂停'};document.querySelector('#theme').onclick=()=>{light=!light;document.body.style.background=light?'#FAFAF4':'#211F1B';document.body.style.color=light?'#3F3A32':'#FAFAF4'};range.oninput=()=>{animations().forEach(a=>{a.pause();a.currentTime=+range.value});paused=true;document.querySelector('#pause').textContent='继续'};</script></html>`);
console.log('Built animated SVGs and interactive preview.');
