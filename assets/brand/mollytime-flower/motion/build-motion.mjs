import fs from 'node:fs/promises';
const base=new URL('../',import.meta.url);
const source=await fs.readFile(new URL('source/symbol.svg',base),'utf8');
const [m,flower]=source.match(/<path\b[^>]*\/>/g);
const rest=m.match(/d="([^"]+)"/)[1];
// Keep the same commands so the flower cradle can interpolate continuously.
const cradle='V151C212 143 194 149 183 163';
if (!rest.includes(cradle)) throw new Error('Expected flower cradle in the symbol path');
// A small lift preserves the concave silhouette; never grow a rounded leg.
const lifted=rest.replace(cradle,'V148C212 139 194 145 183 160');
const pressed=rest.replace(cradle,'V153C212 145 194 151 183 165');
const pose='translate(120 130) rotate(-25) scale(1.02) translate(-128 -128)';
const style=`
.molly-m path { animation:molly-cradle 2800ms ease-in-out both; }
.molly-m { transform-origin:126px 213px; animation:molly-spring 2800ms both; }
.molly-flight { offset-path:path('M 0 0 C 55.2 -25.3 55.2 -110.4 9.2 -142.6 C 55.2 -110.4 55.2 -25.3 0 0'); offset-rotate:0deg; offset-anchor:0px 0px; offset-position:0px 0px; animation:molly-flight 2800ms both; }
.molly-carry { animation:molly-carry 2800ms both; }
.molly-spin { transform-origin:218px 190px; animation:molly-spin 2800ms both; }
@keyframes molly-cradle {
 0%,17% {d:path('${rest}')}
 32% {d:path('${lifted}')}
 52%,72% {d:path('${rest}')}
 76% {d:path('${pressed}')}
 88%,100% {d:path('${rest}')}
}
@keyframes molly-spring {
 0%,8% {transform:scale(1,1)}
 17% {transform:scale(1.03,.95);animation-timing-function:cubic-bezier(.2,.7,.25,1)}
 29% {transform:scale(.97,1.05);animation-timing-function:cubic-bezier(.3,0,.2,1)}
 43% {transform:scale(1.012,.985)}
 55% {transform:scale(.995,1.008)}
 63%,72% {transform:scale(1,1)}
 76% {transform:scale(1.018,.975)}
 88% {transform:scale(.992,1.012)}
 94%,100% {transform:scale(1,1)}
}
/* Local translations follow the flower centre under the M spring, without
   squashing the petals. The landing adds the cradle's two-unit give. */
@keyframes molly-carry {
 0%,8% {transform:translate(0px,0px)}
 17% {transform:translate(2.76px,1.15px);animation-timing-function:cubic-bezier(.2,.7,.25,1)}
 29%,72% {transform:translate(0px,0px)}
 76% {transform:translate(1.656px,2.575px)}
 88% {transform:translate(-.736px,-.276px)}
 94%,100% {transform:translate(0px,0px)}
}
@keyframes molly-flight {
 0%,17% {offset-distance:0%;animation-timing-function:cubic-bezier(.2,.65,.3,1)}
 45%,49% {offset-distance:50%;animation-timing-function:cubic-bezier(.5,0,.7,1)}
 72%,100% {offset-distance:100%}
}
@keyframes molly-spin {
 0%,17% {transform:rotate(0deg);animation-timing-function:cubic-bezier(.2,.65,.3,1)}
 45%,49% {transform:rotate(-360deg);animation-timing-function:cubic-bezier(.5,0,.7,1)}
 72%,100% {transform:rotate(-720deg)}
}
@media(prefers-reduced-motion:reduce) {.molly-m path,.molly-m,.molly-flight,.molly-carry,.molly-spin {animation:none!important;offset-path:none}}
`;
const svg=loop=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-48 -48 352 352" role="img" aria-labelledby="motion-title"><title id="motion-title">MollyTime — 茉莉花飞旋与弹性 M</title><style>${style}${loop?'.molly-m path,.molly-m,.molly-flight,.molly-carry,.molly-spin{animation-iteration-count:infinite}':''}</style><g fill="#F8DE7E"><g transform="${pose}"><g class="molly-m">${m}</g></g><g class="molly-flight"><g transform="${pose}"><g class="molly-carry"><g class="molly-spin">${flower}</g></g></g></g></g></svg>`;
await fs.writeFile(new URL('motion/mollytime-animated.svg',base),svg(false));
await fs.writeFile(new URL('motion/mollytime-animated-loop.svg',base),svg(true));
await fs.writeFile(new URL('motion/preview.html',base),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MollyTime · 动态 Logo</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#211F1B;color:#FAFAF4;font:16px system-ui;display:grid;place-items:center}main{width:min(90vw,640px);text-align:center}.stage{height:min(66vh,520px);display:grid;place-items:center}.stage svg{width:min(100%,420px);overflow:visible}h1{font-size:24px;letter-spacing:-.5px;margin:0 0 12px}p{color:#B8B1A3;font-size:14px}button{font:inherit;cursor:pointer;padding:10px 20px;border:1px solid #5B5447;border-radius:99px;background:transparent;color:inherit;margin:8px}button:first-child{background:#F8DE7E;color:#3F3A32;border-color:transparent}input{width:min(90%,360px);accent-color:#F8DE7E;margin-top:16px}</style><main><div class="stage">${svg(true)}</div><h1>MollyTime</h1><p>小花飞旋上扬 · 弧口轻轻回应</p><div><button id="replay">重新播放</button><button id="theme">切换背景</button><button id="pause">暂停</button></div><input aria-label="动画进度" type="range" min="0" max="2800" value="0" step="1"></main><script>const mark=document.querySelector('svg'),range=document.querySelector('input');let paused=false,light=false;const animations=()=>mark.getAnimations({subtree:true});document.querySelector('#replay').onclick=()=>{animations().forEach(a=>{a.currentTime=0;a.play()});paused=false;document.querySelector('#pause').textContent='暂停'};document.querySelector('#pause').onclick=()=>{paused=!paused;animations().forEach(a=>paused?a.pause():a.play());document.querySelector('#pause').textContent=paused?'继续':'暂停'};document.querySelector('#theme').onclick=()=>{light=!light;document.body.style.background=light?'#FAFAF4':'#211F1B';document.body.style.color=light?'#3F3A32':'#FAFAF4'};range.oninput=()=>{animations().forEach(a=>{a.pause();a.currentTime=+range.value});paused=true;document.querySelector('#pause').textContent='继续'};</script></html>`);
console.log('Built animated SVGs and interactive preview.');
