import { createRequire } from 'node:module';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const repo = process.argv[2] ?? '/Users/dmitriy/code/goose/fansly-ext';
const require = createRequire(path.join(repo, 'package.json'));
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const results = [];
const record = value => { results.push(value); console.log(JSON.stringify(value)); };
const draftsDir = path.join(repo, 'prompts/drafts');
const plugin = { name: 'audit-drafts', setup(build) {
  build.onResolve({ filter: /^virtual:model-card-drafts$/ }, () => ({ path: 'virtual:model-card-drafts', namespace: 'audit' }));
  build.onLoad({ filter: /.*/, namespace: 'audit' }, async () => {
    let files = [];
    try { files = (await readdir(draftsDir)).filter(f => f.toLowerCase().endsWith('.md')).sort((a,b) => a.localeCompare(b,'en',{ sensitivity:'base', numeric:true })); } catch {}
    return { contents: files.map((f,i) => `import d${i} from ${JSON.stringify(path.join(draftsDir,f))};`).join('\n') + `export default {${files.map((f,i)=>JSON.stringify(f.replace(/\.md$/i,''))+':d'+i).join(',')}};`, resolveDir:repo, loader:'ts' };
  });
} };
for (const entry of ['src/content/bootstrap.ts', 'src/content/index.ts']) {
  const built = await esbuild.build({ absWorkingDir:repo, entryPoints:[entry], bundle:true, write:false, format:'esm', platform:'browser', target:'firefox128', minifySyntax:true, minifyWhitespace:true, metafile:true, loader:{'.css':'text','.md':'text'}, plugins:[plugin], define:{__CHATGOOSE_BUILD_TIME__:'"audit"'} });
  const output = Object.values(built.metafile.outputs)[0];
  record({ scenario:'current source build, sourcemap excluded, stable audit timestamp', entry, bytes:built.outputFiles[0].contents.length, voiceBytes:Object.entries(output.inputs).filter(([p])=>p.startsWith('src/content/voice/')).reduce((s,[p,v])=>s+v.bytesInOutput,0), largestInputs:Object.entries(output.inputs).sort((a,b)=>b[1].bytesInOutput-a[1].bytesInOutput).slice(0,10) });
}
const bundle = '/tmp/fansly-general-performance-audit.bundle.mjs';
await esbuild.build({ stdin:{contents:`export { OverlayController } from './src/content/overlay/overlay-controller.ts'; export { StorageCoordinator } from './src/background/storage-coordinator.ts'; export { createSeedState } from './src/shared/migrations.ts';`,resolveDir:repo}, outfile:bundle, bundle:true, format:'esm', platform:'node', define:{__CHATGOOSE_BUILD_TIME__:'"audit"'} });
const { OverlayController, StorageCoordinator, createSeedState } = await import(bundle);
const dom = new JSDOM('<!doctype html><html><body></body></html>', {url:'https://fansly.com/messages/test',pretendToBeVisual:true});
for (const key of ['window','document','HTMLElement','HTMLDivElement','HTMLTextAreaElement','HTMLInputElement','HTMLButtonElement','HTMLSelectElement','Node','MutationObserver']) Object.defineProperty(globalThis,key,{value:key==='window'?dom.window:dom.window[key],configurable:true});
globalThis.browser = {storage:{local:{get:async()=>({}),set:async()=>{},remove:async()=>{}},onChanged:{addListener(){}}}};
const controller = new OverlayController({onClose(){},onCancel(){},onCollapse(){},onRegenerate(){},onCopy(){},onInsert(){}});
const modelFor = (feedItems=[], extras={}) => ({kind:'coach',fanDisplayName:'fan',operationId:'op',sessionView:{feedItems,recapStatusLine:{state:'hidden'},composerText:'',composerEnabled:false,autoRecapOverride:'inherit',draftAttachEnabled:false,draftIntent:false,groupId:'test',sessionKey:'account|test',pendingQuestion:'question',pendingAnswerText:'a',...extras}});
const profile={elapsedMs:1000,activeLabel:'stream',stages:[],logEntries:Array.from({length:20},(_,i)=>({elapsedMs:i*10,message:'stage '+i}))};
for (const debug of [false,true]) {
  const model = modelFor([], debug?{pendingProfiling:profile}:{});
  controller.render(model);
  const log=document.querySelector('.chatgoose-coach-pending .chatgoose-coach-debug-log');
  const oldFirstRow=log?.firstChild;
  const observer=new MutationObserver(()=>{});observer.observe(document.querySelector('.chatgoose-coach-feed'),{childList:true,subtree:true});
  let createCount=0;const realCreate=document.createElement.bind(document);document.createElement=(...args)=>{createCount++;return realCreate(...args)};
  const start=performance.now();for(let i=0;i<100;i++){model.sessionView.pendingAnswerText+='x';controller.render(model);}
  const elapsed=performance.now()-start;document.createElement=realCreate;
  const records=observer.takeRecords();observer.disconnect();
  record({scenario:'coach 100 token frames, unchanged 20-row profile',debug,childListRecords:records.length,createdElements:createCount,firstProfileRowReused:log?oldFirstRow===log.firstChild:null,jsdomAggregateMs:elapsed});
  controller.render({kind:'hidden'});
}
for (const n of [0,20,50,200,1000]) {
  const model=modelFor(Array.from({length:n},(_,i)=>({kind:'exchange',operationId:'e'+i,question:'q',answerProse:'answer '.repeat(50),drafts:[]})),{settingsSnapshot:{coachHistoryLimit:10,coachAutoRecap:'off'}});
  controller.render(model);
  const nodes=document.querySelectorAll('*').length;
  let keys=0;const oldKey=controller.coachFeedKey.bind(controller);controller.coachFeedKey=(...args)=>{keys++;return oldKey(...args)};
  const times=[];for(let i=0;i<100;i++){model.sessionView.pendingAnswerText+='x';const start=performance.now();controller.render(model);times.push(performance.now()-start);}
  controller.coachFeedKey=oldKey;times.sort((a,b)=>a-b);
  record({scenario:'coach 100 streaming frames',feedItems:n,initialDomElements:nodes,feedKeyCalls:keys,p50Ms:times[50],p95Ms:times[95]});controller.render({kind:'hidden'});
}
const entry={summary:'test '.repeat(2000),personalityId:'persona',personaDefinitionId:'abcdefghijklmnop',personalityUpdatedAt:1,personaCatalogSource:null,generatedAt:1};
for (const n of [0,100,1000,10000]) {
  const coordinator=new StorageCoordinator();coordinator.state=createSeedState();for(let i=0;i<n;i++)coordinator.state['summary:'+i]={...entry};
  const old=coordinator.state['summary:0'];
  const times=[];for(let i=0;i<30;i++){const start=performance.now();coordinator.applyStorageChanges({settings:{oldValue:coordinator.state.settings,newValue:{...coordinator.state.settings,debugMode:i%2===0}}},'local');times.push(performance.now()-start);}
  times.sort((a,b)=>a-b);record({scenario:'settings patch normalizes recap cache, browser storage mocked',entries:n,p50Ms:times[15],p95Ms:times[28],unchangedEntryReused:n?old===coordinator.state['summary:0']:null});
}
dom.window.close();
await writeFile('/tmp/fansly-general-performance-results.json', JSON.stringify({scope:'Node/JSDOM synthetic operation counts, no Firefox layout/paint or real storage I/O',results},null,2));
