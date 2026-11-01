import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';

const OLD=Date.now()-60*24*60*60*1000;

async function harness(options={}) {
  const hooks=[],effects=[];let cursor=0,tree,Panel,registration;
  let rows=options.rows || [{source:'codex',id:'old',title:'existing',cwd:'C:\\project'}];
  let fail=false,reads=0;
  const workspaceState=options.workspaceState || {items:[],pinnedSessionIds:[],archivedSessionIds:[]};
  const requests=[];
  const React={createElement:(type,props,...children)=>({type,props:props||{},children}),Fragment:'fragment',Component:class{constructor(props){this.props=props||{};this.state={};}setState(next){this.state={...this.state,...(typeof next==='function'?next(this.state,this.props):next)};}},useRef(value){const i=cursor++;return hooks[i] ||= {current:value};},useState(value){const i=cursor++;if(!(i in hooks))hooks[i]=value;return [hooks[i],next=>{hooks[i]=typeof next==='function'?next(hooks[i]):next;}];},useEffect(fn,deps){const i=cursor++;if(!hooks[i]||deps.some((d,j)=>d!==hooks[i][j])){hooks[i]=deps;effects.push(fn);}}};
  const fetch=async(url,requestOptions)=>{
    requests.push({url,options:requestOptions});
    if(url.endsWith('/status')){if(fail)throw new Error('test connection failure');return {ok:true,json:async()=>({counts:{codex:rows.length,claude:0},discovered:rows,scannedAt:Date.now()})};}
    if(url.includes('/conversation?')){reads++;return {ok:true,json:async()=>({title:'context',source:'codex',messages:[{role:'user',text:'turn '+reads}],totalMessages:1})};}
    if(url.endsWith('/archive')){const payload=JSON.parse(requestOptions.body);return {ok:true,json:async()=>({requested:payload.sessionIds.length,archived:payload.sessionIds,skippedPinned:[],failed:[],deletedWorkspaces:[]})};}
    return {ok:true,json:async()=>({ok:true})};
  };
  const context={window:{__ModuleLoader__:{load:r=>registration=r},confirm:()=>options.confirm!==false},fetch,AbortController,Date,console,setTimeout:(fn,ms)=>ms===15000||ms===120000?setTimeout(fn,ms):0,clearTimeout};
  vm.runInNewContext(fs.readFileSync(new URL('../client.js',import.meta.url),'utf8'),context);
  const plugin=registration.factory(()=>React);
  let FooterArchive;
  plugin.apply({effect:fn=>fn(),sidebarRightTabs:{register:()=>()=>{}},slots:{inject:(name,fn)=>fn(),register:(props,component)=>{
    if(props.name==='sidebar.right.pane.tab')Panel=component;
    if(props.name==='sidebar.footer.action'&&props.id==='dsh-plugin-external-session-sync.footer.archive')FooterArchive=component;
    return()=>{};
  }}});
  // SnapshotSelectorHook semantics: it receives a selector and returns the selected value.
  const useWorkspaces=options.workspaceState?(selector)=>selector(options.workspaceState):undefined;
  const useSessions=options.sessions?(selector)=>selector(options.sessions):undefined;
  const renderPanel=()=>{cursor=0;tree=Panel(useWorkspaces?{useWorkspaces}:{});const pending=effects.splice(0);for(const effect of pending)effect();return tree;};
  const renderFooter=()=>{cursor=0;tree=FooterArchive({wide:true,useSessions,useWorkspaces});const pending=effects.splice(0);for(const effect of pending)effect();return tree;};
  const render=options.mode==='footer'?renderFooter:renderPanel;
  const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));render();await new Promise(resolve=>setImmediate(resolve));return render();};
  const find=(node,predicate)=>{if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of (node.children||[]).flat(Infinity)){const result=find(child,predicate);if(result)return result;}return null;};
  const text=node=>typeof node==='string'?node:!node||typeof node!=='object'?'':(node.children||[]).flat(Infinity).map(text).join(' ');
  render();await settle();
  const byTestId=id=>find(tree,n=>n.props?.['data-testid']===id);
  return {render,settle,find,text,byTestId,requests,workspaceState,get tree(){return tree;},setRows(value){rows=value;},setFailure(value){fail=value;},get reads(){return reads;}};
}

test('the panel renders its controls even when the workspace hook is unavailable',async()=>{
  const app=await harness();
  assert.ok(app.text(app.tree).includes('外部会话同步与接力'));
  assert.ok(app.text(app.tree).includes('归档旧会话'));
  assert.ok(app.text(app.tree).includes('1个月前'));
  assert.equal(app.byTestId('external-sync-render-error'),null);
});
test('the refresh button reveals a newly created session and re-reads selected context',async()=>{
  const app=await harness();assert.ok(app.text(app.tree).includes('existing'));const before=app.reads;
  app.setRows([{source:'codex',id:'new',title:'newly found chat',cwd:'D:\\fixtures\\new-proj'},{source:'codex',id:'old',title:'existing'}]);
  await app.byTestId('external-sync-refresh').props.onClick();await app.settle();
  assert.ok(app.text(app.tree).includes('newly found chat'));assert.ok(app.text(app.tree).includes('新增 1 个会话'));assert.ok(app.reads>before);
  assert.ok(app.requests.filter(r=>r.url.endsWith('/status')).every(r=>r.options.cache==='no-store'));
});
test('refresh failure preserves the previous list, shows a retryable error, and a later click recovers',async()=>{
  const app=await harness();app.setFailure(true);
  await app.byTestId('external-sync-refresh').props.onClick();await app.settle();
  assert.ok(app.text(app.tree).includes('existing'));assert.ok(app.text(app.tree).includes('test connection failure'));
  assert.equal(app.byTestId('external-sync-refresh').props.disabled,false);
  app.setFailure(false);await app.byTestId('external-sync-refresh').props.onClick();await app.settle();
  assert.ok(!app.text(app.tree).includes('test connection failure'));
});
test('the sidebar footer archives only old unpinned NATIVE DSH sessions',async()=>{
  const app=await harness({
    mode:'footer',
    sessions:{ids:['s-old','s-pinned','s-fresh','s-blank'],byId:{
      's-old':{id:'s-old',title:'old',cwd:'C:\\a',updatedAt:OLD,blank:false},
      's-pinned':{id:'s-pinned',title:'pinned',cwd:'C:\\b',updatedAt:OLD,blank:false},
      's-fresh':{id:'s-fresh',title:'fresh',cwd:'C:\\c',updatedAt:Date.now(),blank:false},
      's-blank':{id:'s-blank',title:'blank',cwd:'C:\\d',updatedAt:OLD,blank:true},
    }},
    workspaceState:{items:[],pinnedSessionIds:['s-pinned'],archivedSessionIds:[]},
  });
  assert.ok(app.text(app.tree).includes('旧会话归档'));
  await app.byTestId('dsh-archive-old').props.onClick();await app.settle();
  const call=app.requests.find(r=>r.url.endsWith('/archive'));
  assert.ok(call,'expected the footer button to reach the native archive route');
  const payload=JSON.parse(call.options.body);
  assert.deepEqual(payload.sessionIds,['s-old']);
  assert.equal(payload.deleteEmptyWorkspaces,true);
});
test('declining the confirmation archives nothing',async()=>{
  const app=await harness({
    mode:'footer',confirm:false,
    sessions:{ids:['s-old'],byId:{'s-old':{id:'s-old',updatedAt:OLD,blank:false}}},
    workspaceState:{items:[],pinnedSessionIds:[],archivedSessionIds:[]},
  });
  await app.byTestId('dsh-archive-old').props.onClick();await app.settle();
  assert.equal(app.requests.filter(r=>r.url.endsWith('/archive')).length,0);
});
test('one-click archive sends only old unpinned ids and reports the outcome',async()=>{
  const app=await harness({
    rows:[
      {source:'codex',id:'old-a',title:'oldA',cwd:'C:\\a',synced:true,dshSessionId:'session-a',updatedAt:OLD},
      {source:'codex',id:'pinned-b',title:'pinnedB',cwd:'C:\\b',synced:true,dshSessionId:'session-b',updatedAt:OLD},
      {source:'codex',id:'fresh-c',title:'freshC',cwd:'C:\\c',synced:true,dshSessionId:'session-c',updatedAt:Date.now()},
    ],
    workspaceState:{items:[],pinnedSessionIds:['session-b'],archivedSessionIds:[]},
  });
  assert.ok(app.text(app.tree).includes('置顶（归档时跳过）'));
  assert.ok(app.text(app.tree).includes('6个月前'));
  await app.byTestId('external-sync-archive-old').props.onClick();await app.settle();
  const call=app.requests.find(r=>r.url.endsWith('/archive'));
  assert.ok(call,'expected an archive request');
  const payload=JSON.parse(call.options.body);
  assert.deepEqual(payload.sessionIds,['session-a']);
  assert.deepEqual(payload.pinnedSessionIds,['session-b']);
  assert.equal(payload.deleteEmptyWorkspaces,true);
  assert.match(app.text(app.tree),/归档完成：1 个/);
});
