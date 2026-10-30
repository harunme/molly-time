import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const base=new URL('./',import.meta.url);
const require=createRequire(new URL('../../../apps/site/package.json',base));
const sharp=require('sharp');
const colors={jasmine:'#F8DE7E',ink:'#3F3A32',black:'#000000',white:'#FFFFFF',ivory:'#FAFAF4'};
const jasmine='#F8DE7E';
const source=await fs.readFile(new URL('source/symbol.svg',base),'utf8');
const type=await fs.readFile(new URL('source/wordmark.svg',base),'utf8');
const symbol=source.match(/<g[^>]*>(.*)<\/g>/s)[1];
const [mPath,flowerPath]=symbol.match(/<path\b[^>]*\/>/g);
const word=type.match(/<g[^>]*>(.*)<\/g>/s)[1];
const wordBox=type.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
const wordWidth=wordBox[2];
const group=(art,fill,transform='')=>`<g fill="${fill}"${transform?` transform="${transform}"`:''}>${art}</g>`;
const svg=(w,h,art,title='MollyTime')=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title"><title id="title">${title}</title>${art}</svg>`;
const write=async(path,data)=>{const dest=new URL(path,base);await fs.mkdir(new URL('./',dest),{recursive:true});await fs.writeFile(dest,data)};
const png=async(path,art,size)=>{const dest=new URL(path,base);await fs.mkdir(new URL('./',dest),{recursive:true});let im=sharp(Buffer.from(art));if(size)im=im.resize(size);await im.png().toFile(fileURLToPath(dest))};
await write('palette.json',JSON.stringify({primary:jasmine,jasmine,ivory:colors.ivory,ink:colors.ink,white:colors.white},null,2));
await write('palette.css',`:root {\n  --molly-primary: ${jasmine};\n  --molly-primary-rgb: ${[1,3,5].map(i => parseInt(jasmine.slice(i,i+2),16)).join(" ")};\n  --molly-ivory: ${colors.ivory};\n  --molly-jasmine: ${jasmine};\n  --molly-ink: ${colors.ink};\n  --molly-primary-hover: #EACB69;\n  --molly-primary-soft: #FFF5D6;\n  --molly-primary-text: #755A1D;\n  --molly-focus: #A27B22;\n  --molly-muted: #797266;\n  --molly-border: #E7E2D6;\n  --molly-night: #211F1B;\n  --molly-night-surface: #33302A;\n  --molly-night-muted: #B8B1A3;\n  --molly-night-line: #5B5447;\n}\n`);
const horizontal=(c)=>group(symbol,c)+group(word,c,'translate(288 52) scale(1.5)');
const horizontalWidth=Math.ceil(288+wordWidth*1.5+12);
const stacked=(c)=>group(symbol,c,'translate(72 0)')+group(word,c,`translate(20 262) scale(${360/wordWidth})`);
for(const [name,color] of Object.entries(colors)){
 const files={symbol:svg(256,256,group(symbol,color)),horizontal:svg(horizontalWidth,256,horizontal(color)),stacked:svg(400,380,stacked(color)),wordmark:svg(wordWidth+4,120,group(word,color,'translate(2 0)'))};
 for(const [layout,art] of Object.entries(files)){
  await write(`digital/mollytime-${layout}-${name}.svg`,art);
  await png(`digital/mollytime-${layout}-${name}.png`,art,layout==='symbol'?1024:1600);
 }
}
const coloredReverse=group(mPath,colors.ivory)+group(flowerPath,jasmine);
const iconMark=group(symbol,jasmine);
const icon=svg(256,256,`<rect width="256" height="256" rx="60" fill="${colors.ivory}"/>`+`<g transform="translate(20 20) scale(.84)">${iconMark}</g>`);
const maskable=svg(256,256,`<rect width="256" height="256" fill="${colors.ivory}"/>`+`<g transform="translate(38.4 38.4) scale(.70)">${iconMark}</g>`);
await write('icons/app-icon.svg',icon);
await write('icons/app-icon-maskable.svg',maskable);
for(const size of [64,128,180,192,256,512,1024])await png(`icons/app-icon-${size}.png`,icon,size);
for(const size of [192,512])await png(`icons/app-icon-maskable-${size}.png`,maskable,size);
const favicon=svg(256,256,`<rect width="256" height="256" rx="52" fill="${colors.ivory}"/>`+`<g transform="translate(8 8) scale(.94)">${iconMark}</g>`);
await write('web/favicon.svg',favicon);
const sizes=[16,32,48,64];const frames=[];
for(const size of sizes){const frame=await sharp(Buffer.from(favicon)).resize(size,size).png().toBuffer();frames.push(frame);await write(`web/favicon-${size}.png`,frame)}
const ico=Buffer.alloc(6+16*frames.length);ico.writeUInt16LE(1,2);ico.writeUInt16LE(frames.length,4);let offset=ico.length;
frames.forEach((frame,i)=>{const n=6+16*i;ico[n]=sizes[i];ico[n+1]=sizes[i];ico.writeUInt16LE(1,n+4);ico.writeUInt16LE(32,n+6);ico.writeUInt32LE(frame.length,n+8);ico.writeUInt32LE(offset,n+12);offset+=frame.length});
await write('web/favicon.ico',Buffer.concat([ico,...frames]));
await png('web/apple-touch-icon.png',icon,180);
await png('web/icon-192.png',icon,192);await png('web/icon-512.png',icon,512);
await png('web/icon-maskable-512.png',maskable,512);
await write('web/site.webmanifest',JSON.stringify({name:'MollyTime',short_name:'MollyTime',start_url:'/',display:'standalone',background_color:colors.ivory,theme_color:colors.ivory,icons:[{src:'icon-192.png',sizes:'192x192',type:'image/png',purpose:'any'},{src:'icon-512.png',sizes:'512x512',type:'image/png',purpose:'any'},{src:'icon-maskable-512.png',sizes:'512x512',type:'image/png',purpose:'maskable'}]},null,2));
await write('web/head-snippet.html',`<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">\n<link rel="icon" href="/brand/favicon.ico" sizes="any">\n<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">\n<link rel="manifest" href="/brand/site.webmanifest">\n<meta name="theme-color" content="${colors.ivory}">\n`);
const font='font-family="Arial,PingFang SC,sans-serif"';
const text=(x,y,s,size=20,fill=colors.ink)=>`<text x="${x}" y="${y}" ${font} font-size="${size}" fill="${fill}">${s}</text>`;
const rect=(x,y,w,h,fill,rx=0)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"/>`;
const primarySymbol=group(symbol,jasmine);
const primaryHorizontal=primarySymbol+group(word,colors.ink,'translate(288 52) scale(1.5)');
const primaryStacked=`<g transform="translate(72 0)">${primarySymbol}</g>`+group(word,colors.ink,`translate(20 262) scale(${360/wordWidth})`);
for(const [name,w,h,art] of [['symbol',256,256,primarySymbol],['horizontal',horizontalWidth,256,primaryHorizontal],['stacked',400,380,primaryStacked]]){await write(`digital/mollytime-${name}-primary.svg`,svg(w,h,art));await png(`digital/mollytime-${name}-primary.png`,svg(w,h,art),name==='symbol'?1024:1600);}
const brand=(x,y,scale,color)=>`<g transform="translate(${x} ${y}) scale(${scale})">${color?horizontal(color):primaryHorizontal}</g>`;
const iconAt=(x,y,size)=>`<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 256 256">${icon.match(/<title[^>]*>.*?<\/title>(.*)<\/svg>/s)[1]}</svg>`;
let board=rect(0,0,1600,1900,colors.ivory)+text(72,72,'MOLLYTIME / IDENTITY',22)+brand(100,140,1.32)+text(75,580,'01  标识组合',25)+brand(75,620,.72)+`<g transform="translate(1075 580) scale(.8)">${primaryStacked}</g>`;
board+=rect(72,925,1456,1,'#E4DFD4')+text(75,985,'02  色彩',25);
Object.entries({Jasmine:jasmine,Ivory:colors.ivory,Ink:colors.ink,White:colors.white}).forEach(([name,c],i)=>{const x=75+i*367;board+=rect(x,1020,345,100,c,12)+text(x,1150,`${name}  ${c}`,18)});
board+=text(75,1220,'03  应用示意',25);
// Six relevant contexts: TV navigation, launcher, site header, parent header, splash and browser tab.
board+=rect(75,1260,700,170,'#29261F',18)+brand(104,1282,.35,colors.ivory)+text(109,1400,'首页       继续观看       我的收藏',20,colors.ivory)+text(75,1461,'TV 导航',16);
board+=rect(815,1260,310,170,'#FFF5D6',18)+iconAt(919,1280,104)+text(815,1461,'电视启动器',16);
board+=rect(1165,1260,360,170,'#FFFFFF',18)+brand(1185,1290,.34)+text(1185,1400,'家庭的视频时光',20,colors.ink)+text(1165,1461,'官网页眉',16);
board+=rect(75,1510,700,140,'#FFFFFF',18)+brand(98,1536,.4)+text(610,1595,'资源库',18,colors.ink)+text(75,1681,'家长后台',16);
board+=rect(815,1510,310,290,colors.ivory,18)+`<g transform="translate(886 1545) scale(.67)">${iconMark}</g>`+text(860,1759,'MollyTime',24,colors.ink)+text(815,1830,'启动画面',16);
board+=rect(1165,1510,360,140,'#F2EFE7',18)+rect(1182,1528,326,98,'#FFFFFF',10)+iconAt(1200,1558,40)+text(1255,1584,'MollyTime',21)+text(1165,1681,'浏览器标签',16);
board+=text(75,1845,'定稿：圆润小写 m 与五片大花瓣。单色、反白与小尺寸共用同一轮廓。',20,'#797266');
await write('presentation.svg',svg(1600,1900,board,'MollyTime identity kit'));
await png('presentation.png',svg(1600,1900,board));
// One-page usage sheet: screen-oriented palette, clear space and file selection.
let guide=rect(0,0,1400,1050,'#F5F4EF')+text(65,70,'MollyTime · Logo 使用规范',32)+brand(65,105,.8);
guide+=text(65,380,'留白',24)+text(65,423,'四周至少保留一根 m 竖笔的宽度（原始坐标约 44 单位）。',21);
guide+=text(65,490,'最小尺寸',24)+text(65,533,'图形建议 ≥ 32 px；16 px 使用 favicon。横版组合建议 ≥ 180 px 宽。',21);
guide+=text(65,600,'色彩与背景',24)+text(65,643,'茉莉黄 #F8DE7E · 花白 #FAFAF4 · 暖墨灰 #3F3A32',21);
guide+=text(65,684,'背景统一茉莉白；m 与小花为茉莉黄，字标和正文使用暖墨灰。',21);
guide+=text(65,751,'文件选择',24)+text(65,794,'digital：图形、横版、竖版、字标。icons：启动图标。web：favicon 与网页图标。',21);
guide+=text(65,861,'字标',24)+text(65,904,'使用已转路径的字标，不需安装字体；产品文字继续使用现有界面字体。',21);
guide+=text(65,985,'数字屏幕 RGB 资产 · 2026-10-30',17,'#797266');
await write('guidelines.svg',svg(1400,1050,guide,'MollyTime logo guidelines'));
await png('guidelines.png',svg(1400,1050,guide));
// Single primary hue: jasmine, with warm neutrals supporting legibility.
let direction=rect(0,0,1600,1120,colors.ivory)+text(92,79,'MOLLYTIME',18,colors.ink)+text(1508,79,'茉莉黄 · 花白 · 暖墨灰',18,'#797266').replace('x="1508"','text-anchor="end" x="1508"');
direction+=brand(98,220,1.30);
direction+=rect(92,655,1416,1,'#E4DFD4');
direction+=iconAt(100,735,224)+text(382,786,'让花成为主角。',30,colors.ink)+text(382,833,'茉莉白统一背景，茉莉黄成为图形主角。',22,'#797266')+text(382,873,'m 与小花同用茉莉黄，字标用暖墨灰。',22,'#797266');
direction+=rect(1040,755,160,14,jasmine,7)+`<rect x="1220" y="755" width="160" height="14" rx="7" fill="${colors.ivory}" stroke="#E4DFD4"/>`+rect(1400,755,48,14,colors.ink,7);
direction+=text(1040,810,'Jasmine / #F8DE7E',17,'#797266')+text(1220,850,'Ivory / #FAFAF4',17,'#797266')+text(1260,900,'Warm ink / #3F3A32',17,'#797266');
direction+=text(92,1053,'MollyTime · 已确认的 m、五片大花瓣与 M/T 大写字标。',18,'#797266');
await write('direction.svg',svg(1600,1120,direction,'MollyTime — jasmine identity'));
await png('direction.png',svg(1600,1120,direction));
console.log('Built MollyTime identity kit');
