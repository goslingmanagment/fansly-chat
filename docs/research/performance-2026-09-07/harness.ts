import { SpendersBoardController } from './src/content/spenders/spenders-board-controller';
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const delay = () => new Promise<void>(resolve => setTimeout(resolve, 30));
const records: any[] = [];
let builtRows = 0;
const originalBuild = (SpendersBoardController.prototype as any).buildRow;
(SpendersBoardController.prototype as any).buildRow = function(...args: any[]) {builtRows++; return originalBuild.apply(this,args);};
const board = new SpendersBoardController({getContextKey:()=> 'synthetic', fetchList: async()=>({ok:true,result:finalResult} as any),openChat:()=>{},resolveChat:async()=>({ok:true,groupId:null})}) as any;
let finalResult: any;
const observe = new MutationObserver(()=>{});
async function measure(n:number, iteration:number, operation:string, fn:()=>void) {
  await frame();
  const beforeRows = builtRows;
  observe.observe(document.getElementById('chatgoose-board-root')!,{subtree:true,childList:true,attributes:true});
  const start = performance.now(); fn(); const jsMs = performance.now()-start;
  const layoutStart = performance.now();
  const panel = document.querySelector('.chatgoose-board-list');
  if(panel) void (panel as HTMLElement).offsetHeight;
  const layoutMs = performance.now()-layoutStart;
  const mutations = observe.takeRecords(); observe.disconnect();
  const first = document.querySelector('.chatgoose-board-row');
  records.push({n,iteration,operation,jsMs,layoutMs,builtRows:builtRows-beforeRows,rows:document.querySelectorAll('.chatgoose-board-row').length,elements:document.querySelectorAll('#chatgoose-board-root *').length,childListRecords:mutations.filter(x=>x.type==='childList').length,attributeRecords:mutations.filter(x=>x.type==='attributes').length,firstRowText:first?.textContent?.slice(0,65)});
  await delay();
}
function makeResult(n:number,enriched:boolean) {
  const now=Date.now();
  return {entries:Array.from({length:n},(_,i)=>({fanAccountId:'synthetic-'+i,groupId:enriched?'g-'+i:null,displayName:'Fan '+i,username:'fan'+i,customName:enriched?'Friend '+i:null,lifetimeMills:(1000-i*.95)*1000,lifetimeUsd:1000-i*.95,monthMills:enriched?10000:null,monthUsd:enriched?10:null,deletedAt:null})),builtAt:now,source:{streamState:'ramped',lastSyncedAt:now,consecutiveFailures:0},fanCount:n,monthWindow:enriched?'2026-09':null,fetchedAt:now,pageLabel:'synthetic'};
}
document.getElementById('run')!.addEventListener('click',async()=>{
  (document.getElementById('run') as HTMLButtonElement).disabled=true;
  try {
    records.length=0;
    for(const n of [100,500,1000]) for(let iteration=0;iteration<6;iteration++) {
      finalResult=makeResult(n,true);
      board.close(); board.open=true; board.activeTier='all';board.searchQuery='';board.loading=true;board.result=makeResult(n,false);
      await measure(n,iteration,'preliminary',()=>board.renderBoard());
      board.loading=false;board.result=finalResult;
      await measure(n,iteration,'enrichment',()=>board.renderEnrichedBoardInPlace());
      board.searchQuery='fan';
      await measure(n,iteration,'broad-search-commit',()=>board.renderList());
      board.searchQuery='fan99';
      await measure(n,iteration,'narrow-search-commit',()=>board.renderList());
      board.searchQuery='';
      await measure(n,iteration,'clear-search-commit',()=>board.renderList());
      await measure(n,iteration,'cursor',()=>board.moveCursor(1));
      await measure(n,iteration,'close',()=>board.close());
    }
    document.getElementById('results')!.textContent=JSON.stringify({userAgent:navigator.userAgent,viewport:{width:innerWidth,height:innerHeight},date:new Date().toISOString(),warmupIteration:0,units:'ms',note:'Synchronous operations with mutation observation; explicit post-operation layout flush timed separately. Search excludes intentional 150ms debounce. No real Fansly/Hub/extension lifecycle.',records},null,2);
  }catch(error){board.close();document.getElementById('results')!.textContent=String(error);}
  (document.getElementById('run') as HTMLButtonElement).disabled=false;
});
