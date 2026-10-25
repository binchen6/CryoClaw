import {createHash} from 'node:crypto';
import {starterCards} from './starter.mjs';
// Exact shipped examples from 6e5b7ca and its pre-release starter revision. Never match edited HTML.
const localExamples=new Set(['welcome','gesture-resize','gesture-open','quick-notes','pomodoro','style-lab','pattern-lab','recipe-guide','live-section','local-section','connected-section']);
const known=new Map([
 [
  "43e2862cde444b10775cb8b83eef9b24fe15b2f3bbf210cc33f3b2a294bad355",
  "welcome"
 ],
 [
  "5316218a1bb24de53922e535b4c9c4b8d2d99343de6cd50a9e28539304d12618",
  "quick-notes"
 ],
 [
  "f7cedae49f464f1ebe9b846d8180cc649a61af3cd27e74dffb7a692a767d421c",
  "gesture-resize"
 ],
 [
  "213f697b3d2d569d5dafcb418d4dd8f0e39c65a175ccd2730f875621bd675686",
  "gesture-open"
 ],
 [
  "83b43e274979b8c36464e6c48f58743d3d5d85751a5289306326aac9869b50dd",
  "live-section"
 ],
 [
  "5c82a1e243864a691e8a85ec45e3a6b408b0c09a7c80abe27e682c582a5688ea",
  "fx-rates"
 ],
 [
  "405dc951dfea09cd78da1ff3deeb36e9cac5cc92c36a36f17d64b7af26ae2e72",
  "market-watch"
 ],
 [
  "f16df8017f8e056294118693dcff53dab4a242d598e24c825cf17e37eb123154",
  "release-gallery"
 ],
 [
  "9d38562440a84635e4f3ea5b2e85c0ee19c86f1a7f74c4095ccd962eaa7e1187",
  "local-section"
 ],
 [
  "13c0ae0b5e728f381d5b2ca3caa0cf52531270e42e6d2052d60c16fc8f9bc473",
  "todo-habits"
 ],
 [
  "5e1b214d14ae85b5a551cab4498ddc7f34616f471e02ebbd8b9919e5f06c5df3",
  "pomodoro"
 ],
 [
  "7c20c21106f8682a3f87a90e4f45e230202c2f5c6c7c3e8a9e3d7a9d000ca30b",
  "disk-space"
 ],
 [
  "9ce3e76654759f0c0ff1354162fb83a88485459a6827854a5beb41bcef0a6287",
  "connected-section"
 ],
 [
  "7a2d590f0064f7e1778566a781d264d9245e9d0832e47e3369ddc973c6521af1",
  "audio-lab"
 ],
 [
  "edf8083144431c5ba59d7eeb8c5ab95e34875052311b435a85daff3b022f3ce9",
  "media-demo"
 ],
 [
  "359e1e9a2eb28f0808a634017ba1c61c31dcdbd403369ef0ebeb375b3e3b0fa5",
  "release-timeline"
 ],
 [
  "6f041da8bd8c85e07c84e4e866e05b634af632e1c58aaf505c6f0f346db460ea",
  "pattern-lab"
 ],
 [
  "ed95f8c78c046b8a9cb3a9a68ceeaaad2d48391453c142c0e5c344e4a61f3ce2",
  "recipe-guide"
 ],
 [
  "216a6010e3afe2bc884e2c57419135f380e5025ca23c1d8d3c46f9915b6e6fc1",
  "style-lab"
 ],
 [
  "97dcaf9b439e62405b474f7dcbbc818f5c7d0d2fa32a826ed80609df621e0265",
  "living-guide"
 ],
 [
  "b8c55d809c513c40195813af69bd2b4a880ec1e845e8f09ec4b720cbff4c82dc",
  "quick-notes"
 ],
 [
  "63438281ef77bcdb76e9fb6d7ae07e9c032531dc302b78510f6a4a1e50bfc0f4",
  "live-section"
 ],
 [
  "89e040fb82de2b24055cf640d0ae4ff764ea0c83b13253a672372203c9afdb51",
  "fx-rates"
 ],
 [
  "ee52233f6542ac0839c060ff983d9a0ca5a25b71bccc1ca9530673cd25ee5274",
  "market-watch"
 ],
 [
  "6f84f3441dcf81fe4f23b1756c86e2adca9bac4016aebc0ac88a66fcaa2205e9",
  "release-gallery"
 ],
 [
  "70f7da554e348b0293fe476c4501702a4e0b9da4d966256fcee02e80557182b4",
  "local-section"
 ],
 [
  "be2d09f2b10740e25c0a903612d614fc9270d705493fab58cf93ef3ae646dd9b",
  "todo-habits"
 ],
 [
  "27996511cb5f94995e610187fa91af80c8c3269c209f5e6b44ef40bc1e3bff81",
  "pomodoro"
 ],
 [
  "eaf7a40fb10ccee9df5c01e3d889db2425fb1d6ae027b8f1d8df9542bef0bd25",
  "disk-space"
 ],
 [
  "14fc95728d4786752a9a3ac9849973555fb4454c1987819d72e65234475a7537",
  "connected-section"
 ],
 [
  "7611e9028e77d9dc32ee13e89515c33de0f8dbcb0492a3ba0dbf29a57cd82c3b",
  "media-demo"
 ],
 [
  "bce12b743a71f44980e1cb7f2dbe62c71316f095537268f5ed9ca9330554cffa",
  "release-timeline"
 ]
]);
// The responsive pre-release used the same capabilities with a different CSS envelope.
for(const [hash,id]of [
 ['d1ef92b0e3c5e8142d7448567a89abfc272aae106d272b44195602c05a597a55','welcome'],
 ['da3e3aa7d0ef135b9e5c10873777e75c82b4e8266993639f9485f61896379b35','quick-notes'],
 ['c122499041094415a7146bc788a01b8a6562ed84a80c58de00a19b629bfca6cd','gesture-resize'],
 ['8fcc7ea088ab8f75000260c18d6c418133cbbc9534af407252b02fdbe4eb1e4c','gesture-open'],
 ['c858a53212e64d14cbbd0b2b6f4ede6aadb271a34429503e6d05b4c636a27c20','live-section'],
 ['73d0b45f9ca8feb9747be683b9f902b5193c725cac889594344c5abf62d8f1dd','fx-rates'],
 ['74c1e72d25cc69598ed5105f07820d22a777658a241ab25fb8267fa2dd25ab2c','market-watch'],
 ['e4d46252dd448c7f0acb902d372d5eaf7ba033b90a6a2dccac25c8f266a79788','release-gallery'],
 ['f88c405a0bb844b790929cc117dafc6a983ea7936e9d7fdadb419f42077a4f0a','local-section'],
 ['899029d3cade31dbd752c12edcf1a093a938819600ae4628ad1f8f2318ac568e','todo-habits'],
 ['a28dbe3a33ef99380bbd01cc696d7d21c012027f64aad1a31373de06ffac832e','pomodoro'],
 ['338147233383035eb04c237760380e86a8d05dc3c8540033a437bf5110a88224','disk-space'],
 ['d15f2bcbf101420058847af9b143bc37abccae47324327a4d14a84d9976d1358','connected-section'],
 ['6bd99d41526f46e73b3d2c55868064e0912fc14c57d3abf74b3ae702b0fa3352','audio-lab'],
 ['3c70684fe4ebf534e38868de72aabd0a86312f0b4fd9f45441abd80030070503','media-demo'],
 ['40b5b8031373b47054e140c800cdf87cecbe7c11f723627d2ac89f539f463457','release-timeline'],
 ['fba11cb43e84f11beb2d88df89eaed95e23e7346b0a87b886a67218e68823c9d','pattern-lab'],
 ['1737ead156a117e8ece0b6ea276eb5e4a656d1c39e2633ab0f72b40848c48d15','recipe-guide'],
 ['89a927f5589d757c41cb785190da6bb8c561ebd404b60ca9394c3f1e63dc3a16','style-lab'],
 ['ae03bca8ccd5c2cc5dcba718836eb388833530c03b90ba02638696d8b281e767','living-guide'],
])known.set(hash,id);
const hashOf=html=>typeof html==='string'?createHash('sha256').update(html).digest('hex'):'';
const current=new Map(starterCards.map(card=>[card.cardId,card]));
export function upgradeLegacyExampleHtml(html){const id=known.get(hashOf(html));return id&&localExamples.has(id)?current.get(id)?.html??html:html;}

const flowerUrl='https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
export function upgradeLegacyExampleMedia(card){
 if(known.get(hashOf(card.html))!=='media-demo'||card.kind!=='html'||!Array.isArray(card.assets)||card.assets.length!==1||(card.dataSources?.length??0)!==0)return card;
 const asset=card.assets[0];if(!asset||Object.keys(asset).length!==2||asset.id!=='flower'||asset.url!==flowerUrl)return card;
 const replacement=current.get('media-demo');return {...card,html:replacement.html,assets:structuredClone(replacement.assets)};
}

const original=[['welcome',12,350],['quick-notes',4,350],['gesture-resize',4,350],['gesture-open',4,350],['system-check',12,320],['live-section',12,320],['fx-rates',6,465],['market-watch',6,465],['release-gallery',12,570],['local-section',12,320],['todo-habits',4,660],['pomodoro',4,660],['disk-space',4,660],['connected-section',12,320],['audio-lab',12,590],['media-demo',7,470],['release-timeline',5,470],['pattern-lab',12,470],['recipe-guide',12,380],['style-lab',7,430],['living-guide',5,430]];
const responsive=[['welcome',12,300],['quick-notes',4,360],['gesture-resize',4,360],['gesture-open',4,360],['system-check',12,300],['live-section',12,160],['fx-rates',6,440],['market-watch',6,440],['release-gallery',12,460],['local-section',12,160],['todo-habits',4,520],['pomodoro',4,520],['disk-space',4,520],['connected-section',12,160],['audio-lab',12,500],['media-demo',7,420],['release-timeline',5,420],['pattern-lab',12,420],['recipe-guide',12,360],['style-lab',7,400],['living-guide',5,400]];
const previousLayouts=[original,responsive].map(rows=>new Map(rows.map(([id,w,h],order)=>[id,{w,h,order}])));
const sourceKey=source=>JSON.stringify({id:source.id,url:source.url.replace(/^(https:\/\/api\.frankfurter\.dev\/v2\/rates\?base=CNY&quotes=EUR,USD,JPY,KRW)&from=\d{4}-\d{2}-\d{2}$/,'$1&from=DATE'),format:source.format??'json',refreshSeconds:source.refreshSeconds??300});
function officialCard(card){
 const template=current.get(card.id);if(!template||card.kind!==template.kind||card.layout?.free!==undefined)return false;
 if(card.kind==='html'&&card.html!==template.html&&known.get(hashOf(card.html))!==card.id)return false;
 if(card.kind==='system'&&card.html)return false;
 const effective=upgradeLegacyExampleMedia(card),assets=effective.assets??[],expected=template.assets??[];
 if(JSON.stringify(assets)!==JSON.stringify(expected))return false;
 const sources=card.dataSources??[],declared=template.dataSources??[];
 return sources.length===declared.length&&sources.every((source,index)=>sourceKey(source)===sourceKey(declared[index]));
}
// Project only a complete untouched example board; saved bytes and user arrangements remain authoritative.
export function upgradeLegacyExampleLayouts(board){
 if(board.templateVersion!==2||board.archived||board.cards.length!==current.size||new Set(board.cards.map(card=>card.id)).size!==current.size||!board.cards.every(officialCard))return null;
 if(!previousLayouts.some(layouts=>board.cards.every(card=>{const layout=layouts.get(card.id);return layout&&card.layout.w===layout.w&&card.layout.h===layout.h&&card.layout.order===layout.order;})))return null;
 return new Map(board.cards.map(card=>[card.id,current.get(card.id).layout]));
}
