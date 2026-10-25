#!/usr/bin/env node
/* Keep the HyperFrames project self-contained without changing application deps. */
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const project=path.join(root,'website/promo/latest');
const copy=(from,to)=>{fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);};
for(const name of ['CryoInter.woff2','CryoMiSans.woff2','CryoMono.woff2','Inter-OFL.txt','JetBrainsMono-OFL.txt','MiSans-LICENSE.pdf','NOTICE.md'])copy(path.join(root,'website/assets/fonts',name),path.join(project,'assets/fonts',name));
copy(path.join(root,'website/assets/icon.png'),path.join(project,'assets/icon.png'));
copy(path.join(root,'website/design-tokens.css'),path.join(project,'design-tokens.css'));
const vendor=path.join(root,'.cache/hyperframes-tools/node_modules/gsap/dist/gsap.min.js');
if(fs.existsSync(vendor))copy(vendor,path.join(project,'vendor/gsap.min.js'));
else if(!fs.existsSync(path.join(project,'vendor/gsap.min.js')))throw new Error('Install gsap in .cache/hyperframes-tools before preparing this project');
console.log('Prepared self-contained palette, licensed fonts, icon and GSAP. All UI footage must come from current Electron recordings.');
