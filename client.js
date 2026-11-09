// Codex thread-index merge release: panel refreshes against official state_5.sqlite records.
window.__ModuleLoader__.load({id:'dsh-plugin-external-session-sync',factory:(require)=>{
  const React=require('react');
  const h=React.createElement;
  const ID='dsh-plugin-external-session-sync',PANEL_ID='dsh-plugin-codex-sync',KIND='external-session-sync',API='/external-session-sync';
  fetch(API+'/client-state',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-DSH-Sync':'1'},body:JSON.stringify({kind:'client-imported'})}).catch(()=>{});
  let runtime,verifyId;
  const color={bg:'var(--dsw-alias-bg-base)',layer:'var(--dsw-alias-bg-layer-1)',border:'var(--dsw-alias-border-l1)',text:'var(--dsw-alias-label-primary)',muted:'var(--dsw-alias-label-secondary)'};
  const button={font:'inherit',color:color.text,background:color.layer,border:'1px solid '+color.border,borderRadius:7,padding:'6px 10px',cursor:'pointer'};
  async function api(path,body) {
    const controller=new AbortController();
    const timeoutMs=path.startsWith('/status')?20000:180000;
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      let response;
      try {
        response=await fetch(API+path,{credentials:'same-origin',cache:'no-store',signal:controller.signal,...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-DSH-Sync':'1'},body:JSON.stringify(body)})});
      } catch(error) {
        if(error.name==='AbortError')throw new Error(`请求超时（${Math.round(timeoutMs/1000)} 秒），大历史导入可能较慢，请稍后重试或分批同步`);
        throw new Error('无法连接同步服务：'+error.message);
      }
      let text;
      try { text=await response.text(); }
      catch(error) {
        if(error.name==='AbortError')throw new Error('读取响应超时，请稍后重试');
        throw new Error('读取响应失败：'+error.message);
      }
      let value;
      try { value=JSON.parse(text); }
      catch { throw new Error(`同步服务返回了非 JSON 响应（HTTP ${response.status}）${text?('：'+text.slice(0,160)):''}`); }
      if(!response.ok)throw new Error(value.error || '请求失败 '+response.status);
      return value;
    } finally { clearTimeout(timer); }
  }
  function report(kind,details={}) {api('/client-state',{kind,...details,...(verifyId?{verificationId:verifyId}:{})}).catch(()=>{});}
  function Glyph({size=16}) {return h('span',{'aria-hidden':true,style:{fontSize:size,lineHeight:1}},'↻');}
  function OpenButton({wide=true}) {return h('button',{type:'button',style:button,'data-testid':'external-sync-open',title:'打开外部会话同步',onClick:()=>openPanel()},h(Glyph),wide?' 会话同步':null);}
  function openPanel(params) {
    runtime.layout.selectPanel(null);
    try {runtime.sidebarRight.openTab(KIND,params?{params}:undefined);report('opened-right');}
    catch(e) {runtime.layout.selectPanel(PANEL_ID);report('opened-main',{reason:e.message});}
  }
  function NativeMarker({sessionId}) {
    const ref=React.useRef(null);
    React.useEffect(()=>{const timer=setTimeout(()=>{if(ref.current?.getClientRects().length)report('native-session-visible',{sessionId});},250);return()=>clearTimeout(timer);},[sessionId]);
    return h('button',{ref,type:'button',style:button,onClick:()=>openPanel(),title:'查看 Codex / Claude 上下文'},'会话同步');
  }
  const EMPTY_WORKSPACE_STATE={items:[],pinnedSessionIds:[],archivedSessionIds:[]};
  function useNoWorkspaceState(){return EMPTY_WORKSPACE_STATE;}
  const EMPTY_SESSIONS={ids:[],byId:{}};
  function useNoSessions(){return EMPTY_SESSIONS;}
  const DSH_ARCHIVE_MONTHS=1;
  /** Footer action: archive old NATIVE DSH sessions only (never the external sources). */
  function ArchiveFooterButton({wide,useSessions,useWorkspaces}) {
    const useSessionsHook=typeof useSessions==='function'?useSessions:useNoSessions;
    const useWorkspacesHook=typeof useWorkspaces==='function'?useWorkspaces:useNoWorkspaceState;
    const sessions=useSessionsHook(state=>state) || EMPTY_SESSIONS;
    const workspaceState=useWorkspacesHook(state=>state) || EMPTY_WORKSPACE_STATE;
    const [busy,setBusy]=React.useState(false);
    React.useEffect(()=>{report('dsh-archive-button-mounted',{wide:!!wide});},[]);
    async function run() {
      if(busy)return;
      const cutoff=Date.now()-DSH_ARCHIVE_MONTHS*30*24*60*60*1000;
      const pinned=new Set(workspaceState.pinnedSessionIds || []);
      const archived=new Set(workspaceState.archivedSessionIds || []);
      const targets=(sessions.ids || []).filter(id=>{
        const summary=sessions.byId?.[id];
        if(!summary || summary.blank || summary.removed)return false;
        if(pinned.has(id) || archived.has(id))return false;
        const at=Number(summary.updatedAt || 0);
        return at>0 && at<cutoff;
      });
      if(!targets.length){report('dsh-archive-empty',{skippedPinned:pinned.size});return;}
      const ask=typeof window!=='undefined' && typeof window.confirm==='function'
        ? window.confirm(`将归档 ${targets.length} 个超过 ${DSH_ARCHIVE_MONTHS} 个月未活动的 DSH 会话。\n置顶会话会跳过，归档后可在归档列表恢复。继续？`)
        : false;
      if(!ask){report('dsh-archive-cancelled',{count:targets.length});return;}
      setBusy(true);
      try {
        const result=await api('/archive',{sessionIds:targets,deleteEmptyWorkspaces:true});
        report('dsh-archive-complete',{requested:targets.length,archived:result.archived.length,skippedPinned:result.skippedPinned.length,failed:result.failed.length,deletedWorkspaces:result.deletedWorkspaces.length});
      }catch(error){report('dsh-archive-error',{error:error.message});}
      finally{setBusy(false);}
    }
    return h('button',{type:'button',style:button,'data-testid':'dsh-archive-old',disabled:busy,title:`归档 ${DSH_ARCHIVE_MONTHS} 个月前的 DSH 会话（置顶跳过）`,onClick:run},busy?'归档中…':'旧会话归档',wide?null:null);
  }
  const DELETE_CONFIRM = '删除后无法恢复，也没有备份。确定继续？';
  /** Footer action: permanently delete the payload of archived DSH sessions. */
  function DeleteArchivedFooterButton({wide}) {
    const [busy,setBusy]=React.useState(false);
    React.useEffect(()=>{report('dsh-delete-button-mounted',{wide:!!wide});},[]);
    function say(message) {
      try { if (typeof window!=='undefined' && typeof window.alert==='function') window.alert(message); } catch {}
    }
    async function run() {
      if(busy)return;
      setBusy(true);
      try {
        const plan=await api('/delete-archived',{dryRun:true});
        if(!plan.candidates){say('没有可删除的已归档会话。');report('dsh-delete-empty',{});return;}
        const mb=(plan.bytes/1048576).toFixed(1);
        const ask=typeof window!=='undefined' && typeof window.confirm==='function'
          ? window.confirm(`将永久删除 ${plan.candidates} 个已归档会话（约 ${mb} MB）。\n置顶、正在打开、已删除的会话会跳过。删除后无法恢复，也没有备份。继续？`)
          : false;
        if(!ask){report('dsh-delete-cancelled',{count:plan.candidates});return;}
        const again=typeof window!=='undefined' && typeof window.confirm==='function'
          ? window.confirm(`再次确认：永久删除 ${plan.candidates} 个已归档会话，不可恢复。`)
          : false;
        if(!again){report('dsh-delete-cancelled',{count:plan.candidates,stage:'second'});return;}
        const result=await api('/delete-archived',{dryRun:false});
        const freed=(result.freedBytes/1048576).toFixed(2);
        say(`已删除 ${result.deleted} 个会话，释放 ${freed} MB。${result.remaining>0?`\n仍有 ${result.remaining} 个可继续清理。`:''}${result.failed.length?`\n失败 ${result.failed.length} 个。`:''}`);
        report('dsh-delete-complete',{deleted:result.deleted,freedBytes:result.freedBytes,remaining:result.remaining,failed:result.failed.length});
      }catch(error){
        say('删除失败：'+error.message);
        report('dsh-delete-error',{error:error.message});
      }
      finally{setBusy(false);}
    }
    return h('button',{type:'button',style:button,'data-testid':'dsh-delete-archived',disabled:busy,title:'永久删除已归档会话的正文与存档（不可恢复）',onClick:run},busy?'删除中…':'删除已归档');
  }
  function Panel({useTabInfo,useWorkspaces,main=false}) {
    const info=typeof useTabInfo==='function'?useTabInfo():null;
    // Never read a service off the Context unless it is injected: Cordis throws for a
    // service the plugin did not declare, and that throw unmounts the whole panel.
    const useWs=typeof useWorkspaces==='function'?useWorkspaces:useNoWorkspaceState;
    const workspaceState=useWs(state=>state) || EMPTY_WORKSPACE_STATE;
    const pinnedSessionIds=new Set(workspaceState.pinnedSessionIds || []);
    const archivedSessionIds=new Set(workspaceState.archivedSessionIds || []);
    const root=React.useRef(null),request=React.useRef(0),catalogRequest=React.useRef(0),mounted=React.useRef(true);
    const [catalog,setCatalog]=React.useState(null),[selected,setSelected]=React.useState(null),[conversation,setConversation]=React.useState(null);
    const [source,setSource]=React.useState('codex'),[query,setQuery]=React.useState(''),[busy,setBusy]=React.useState(false),[loading,setLoading]=React.useState(false),[refreshing,setRefreshing]=React.useState(true),[notice,setNotice]=React.useState('正在读取会话列表…'),[error,setError]=React.useState(''),[archiveMonths,setArchiveMonths]=React.useState('1');
    async function load() {
      const token=++catalogRequest.current;setRefreshing(true);setError('');
      try {
        const data=await api('/status');
        if(!Array.isArray(data.discovered) || !data.counts)throw new Error('会话列表响应不完整，请重试');
        if(mounted.current && token===catalogRequest.current)setCatalog(data);
        return data;
      }finally{if(mounted.current && token===catalogRequest.current)setRefreshing(false);}
    }
    async function refresh(initial=false) {
      const started=Date.now();const previous=catalog?.discovered || [];
      setNotice(initial?'正在读取会话列表…':'正在刷新会话列表…');
      try {
        const data=await load();if(!mounted.current)return;
        const oldKeys=new Set(previous.map(i=>i.source+':'+i.id));
        const added=data.discovered.filter(i=>!oldKeys.has(i.source+':'+i.id));
        setNotice(`已刷新：Codex ${data.counts.codex}，Claude ${data.counts.claude}`+(!initial?`；新增 ${added.length} 个会话`:'')+' · '+new Date(data.scannedAt || Date.now()).toLocaleTimeString());
        const target=info?.tab?.navigation?.params;
        const next=data.discovered.find(i=>selected?i.id===selected.id&&i.source===selected.source:target?i.id===target.id&&i.source===target.source:false) || data.discovered.find(i=>i.source===source) || data.discovered[0];
        if(next)select(next);else{setSelected(null);setConversation(null);request.current++;setLoading(false);}
        report('catalog-refreshed',{items:data.discovered.length,codex:data.counts.codex,claude:data.counts.claude,elapsedMs:Date.now()-started,added:added.length,initial,mode:main?'main':'right',newest:data.discovered.slice(0,3).map(i=>({id:i.id,title:i.title}))});
      }catch(e){if(mounted.current){setError(e.message);setNotice('刷新失败，可重试；上次加载的列表已保留');report('catalog-refresh-error',{error:e.message});}}
    }
    React.useEffect(()=>{mounted.current=true;refresh(true);return()=>{mounted.current=false;catalogRequest.current++;request.current++;};},[]);
    async function select(item) {
      const token=++request.current;setSelected(item);setSource(item.source);setLoading(true);setError('');setConversation(null);
      try {const data=await api('/conversation?source='+item.source+'&id='+encodeURIComponent(item.id)+'&maxMessages=100');if(token!==request.current)return;setConversation(data);}
      catch(e){if(token===request.current)setError(e.message);}finally{if(token===request.current)setLoading(false);}
    }
    React.useEffect(()=>{
      if(!conversation)return;
      const timer=setTimeout(()=>{
        const visible=!!root.current?.getClientRects().length;
        const nodes=root.current?.querySelectorAll('[data-external-message]') || [];
        report('context-rendered',{source:conversation.source,id:conversation.id,messages:conversation.messages.length,total:conversation.totalMessages,domMessages:nodes.length,visible,chars:Array.from(nodes).reduce((sum,n)=>sum+n.textContent.length,0)});
      },60);return()=>clearTimeout(timer);
    },[conversation]);
    async function runSync(all=false) {
      if(!all && !selected)return;
      setBusy(true);setError('');setNotice('正在读取并导入 '+(all?'所有会话':'所选会话')+'…');
      try {
        const result=await api('/sync',all?{source}:{source:selected.source,ids:[selected.id]});
        const repaired=result.repaired?.length || 0;
        const ready=[...result.imported,...result.skipped].find(item=>item.id && item.workspaceAttached);
        setNotice(`同步完成：新增 ${result.imported.length}，已同步 ${result.skipped.length}，修复项目关联 ${repaired}，失败 ${result.failed.length}`+(!all&&ready?`\n${ready.title}（${ready.messages} 条消息）已加入项目「${ready.workspaceTitle}」。可点击“在 DSH 继续”。`:'')+(result.imported.find(i=>i.warning)?.warning?'\n'+result.imported.find(i=>i.warning).warning:''));
        const data=await load();
        if(selected)setSelected(data.discovered.find(i=>i.source===selected.source&&i.id===selected.id) || selected);
        if(result.failed.length)setError(result.failed.slice(0,3).map(i=>i.title+': '+i.error).join('\n'));
        report('sync-complete',{imported:result.imported.length,skipped:result.skipped.length,failed:result.failed.length,ids:result.imported.map(i=>i.id),mode:all?'all':'selected'});
      }catch(e){setError(e.message);setNotice('同步失败，请查看原因');report('sync-error',{error:e.message});}finally{setBusy(false);}
    }
    async function handoff() {
      if(!selected?.dshSessionId)return;
      setBusy(true);setError('');
      try {const result=await api('/validate?id='+encodeURIComponent(selected.dshSessionId));runtime.layout.selectPanel(null);runtime.uiWorkspace.openSession(selected.dshSessionId);report('handoff-opened',{sessionId:selected.dshSessionId,messageCount:result.messageCount,derivedMessages:result.derivedMessages,agentAvailable:result.agentAvailable});}
      catch(e){setError(e.message);report('handoff-error',{error:e.message});}finally{setBusy(false);}
    }
    async function archiveOld() {
      if(!catalog)return;
      const months=Math.max(1,Number(archiveMonths)||1),cutoff=Date.now()-months*30*24*60*60*1000;
      const candidates=catalog.discovered.filter(item=>item.source===source && item.synced && item.dshSessionId && !archivedSessionIds.has(item.dshSessionId) && Number(item.updatedAt||0)<cutoff);
      const pinned=candidates.filter(item=>pinnedSessionIds.has(item.dshSessionId));
      const targets=candidates.filter(item=>!pinnedSessionIds.has(item.dshSessionId));
      if(!targets.length){setNotice(`没有符合条件的会话；候选 ${candidates.length}，置顶跳过 ${pinned.length}`);return;}
      setBusy(true);setError('');setNotice(`正在归档 ${targets.length} 个超过 ${months} 个月的会话…`);
      try {
        const result=await api('/archive',{sessionIds:targets.map(item=>item.dshSessionId),pinnedSessionIds:[...pinnedSessionIds],deleteEmptyWorkspaces:true});
        const failed=result.failed?.length || 0;
        setNotice(`归档完成：${result.archived.length} 个；置顶跳过 ${result.skippedPinned.length} 个；空项目删除 ${result.deletedWorkspaces.length} 个；失败 ${failed} 个`);
        if(failed)setError(result.failed.slice(0,3).map(item=>item.id+': '+item.error).join('\n'));
        await load();
        report('archive-complete',{source,months,candidates:candidates.length,archived:result.archived.length,skippedPinned:result.skippedPinned.length,failed,deletedWorkspaces:result.deletedWorkspaces.length,ids:result.archived});
      }catch(e){setError(e.message);setNotice('归档失败，请重试');report('archive-error',{error:e.message});}finally{setBusy(false);}
    }
    React.useEffect(()=>{
      if(!catalog)return;
      const timer=setTimeout(()=>{const rows=root.current?.querySelectorAll('[data-external-session]') || [];const archiveButton=root.current?.querySelector('[data-testid=external-sync-archive-old]');const monthSelect=root.current?.querySelector('[data-testid=external-sync-archive-months]');report('catalog-rendered',{items:catalog.discovered.length,rows:rows.length,source,visible:!!root.current?.getClientRects().length,archiveControl:!!archiveButton,archiveEnabled:!!archiveButton&&!archiveButton.disabled,monthSelector:!!monthSelect,monthOptions:monthSelect?monthSelect.options.length:0,pinnedCount:pinnedSessionIds.size,archivedCount:archivedSessionIds.size,first:catalog.discovered.filter(i=>i.source===source).slice(0,3).map(i=>({id:i.id,title:i.title}))});},60);
      return()=>clearTimeout(timer);
    },[catalog,source,query]);
    const items=(catalog?.discovered||[]).filter(i=>i.source===source&&(!query || `${i.title} ${i.cwd}`.toLowerCase().includes(query.toLowerCase())));
    const btn=(text,fn,disabled,testid)=>h('button',{type:'button',style:button,onClick:fn,disabled,'data-testid':testid},text);
    return h('section',{ref:root,'data-testid':'external-sync-panel',style:{height:'100%',minHeight:0,display:'flex',flexDirection:'column',color:color.text,background:color.bg,fontSize:13}},
      h('div',{style:{padding:'12px',borderBottom:'1px solid '+color.border,flexShrink:0}},
        h('div',{style:{fontSize:15,fontWeight:650,marginBottom:8}},'外部会话同步与接力'),
        h('div',{style:{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}},
          h('select',{value:source,onChange:e=>{setSource(e.target.value);const first=catalog?.discovered.find(i=>i.source===e.target.value);if(first)select(first);},style:{...button,padding:5}},h('option',{value:'codex'},`Codex (${catalog?.counts.codex ?? '…'})`),h('option',{value:'claude'},`Claude (${catalog?.counts.claude ?? '…'})`)),
          btn(refreshing?'刷新中…':'刷新',()=>refresh(),busy||refreshing,'external-sync-refresh'),btn('同步全部',()=>runSync(true),busy||refreshing||!catalog,'external-sync-all'),btn(busy?'处理中…':'同步所选',()=>runSync(false),busy||refreshing||!selected,'external-sync-selected'),
          btn('在 DSH 继续',handoff,busy||!selected?.dshSessionId,'external-sync-handoff'),
           h('select',{'data-testid':'external-sync-archive-months',value:archiveMonths,onChange:e=>setArchiveMonths(e.target.value),disabled:busy,style:{...button,padding:5},title:'置顶会话永不归档'},h('option',{value:'1'},'1个月前'),h('option',{value:'3'},'3个月前'),h('option',{value:'6'},'6个月前'),h('option',{value:'12'},'1年前')),
           btn('归档旧会话',archiveOld,busy||refreshing||!catalog,'external-sync-archive-old'),
          main?btn('在右侧查看',()=>openPanel(selected?{source:selected.source,id:selected.id}:undefined),false):null),
        notice?h('div',{'role':'status','data-testid':'external-sync-result',style:{marginTop:8,color:'var(--dsw-alias-state-success-primary)',whiteSpace:'pre-wrap'}},notice):null,
        error?h('div',{'role':'alert',style:{marginTop:8,color:'var(--dsw-alias-state-error-primary)',whiteSpace:'pre-wrap'}},error):null),
      h('div',{style:{padding:'8px 12px',borderBottom:'1px solid '+color.border}},h('input',{placeholder:'搜索标题或项目目录',value:query,onChange:e=>setQuery(e.target.value),style:{...button,width:'100%',boxSizing:'border-box'}})),
      h('div',{style:{display:'flex',flex:1,minHeight:0}},
        h('div',{style:{width:main?230:180,maxWidth:'35%',flexShrink:0,overflow:'auto',borderRight:'1px solid '+color.border,padding:6}},
          items.map(i=>h('button',{key:i.source+':'+i.id,'data-external-session':i.id,type:'button',onClick:()=>select(i),title:i.title+'\n'+(i.cwd||''),style:{width:'100%',textAlign:'left',display:'block',background:selected?.id===i.id?color.layer:'transparent',border:0,color:color.text,borderRadius:6,padding:8,cursor:'pointer'}},
            h('div',{style:{fontWeight:550,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},i.title),h('div',{style:{fontSize:10,color:color.muted,overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis',marginTop:3}},i.cwd||'未记录目录'),h('div',{style:{fontSize:10,color:color.muted,marginTop:3}},i.dshSessionId&&pinnedSessionIds.has(i.dshSessionId)?'置顶（归档时跳过）':i.dshSessionId&&archivedSessionIds.has(i.dshSessionId)?'已归档':i.synced&&i.workspaceAttached===false?'正文已保存，需同步修复项目关联':i.upToDate?'已同步':i.synced?'源会话有更新':'未同步'))),
          !items.length?h('div',{style:{padding:8,color:color.muted}},refreshing?'正在读取会话列表…':!catalog&&error?'列表加载失败，请点击刷新重试':query?'没有匹配的会话':'尚未发现会话，请刷新'):null),
        h('div',{style:{flex:1,minWidth:0,overflow:'auto',padding:14}},
          loading?h('div',{style:{color:color.muted}},'读取聊天上下文…'):conversation?h(React.Fragment,null,
            h('h3',{style:{margin:'0 0 4px',fontSize:15}},conversation.title),h('div',{style:{fontSize:11,color:color.muted,marginBottom:12,overflowWrap:'anywhere'}},conversation.cwd||'无工作目录'),
            conversation.totalMessages>conversation.messages.length?h('p',{style:{color:color.muted,fontSize:11}},`显示最近 ${conversation.messages.length} 条；导入会保存完整文本历史。`):null,
            conversation.messages.map((m,index)=>h('article',{key:index,'data-external-message':m.role,style:{padding:'10px 0',borderBottom:'1px solid '+color.border}},h('div',{style:{fontSize:11,color:color.muted,marginBottom:5}},m.role==='user'?'你':source==='codex'?'Codex':'Claude'),h('div',{style:{whiteSpace:'pre-wrap',lineHeight:1.65,overflowWrap:'anywhere'}},m.text)))):h('p',{style:{color:color.muted}},'选择一个会话，在右侧查看上下文。'))));
  }
  // A render failure inside the panel must stay a readable message in the pane
  // instead of silently collapsing to an empty surface.
  class PanelBoundary extends React.Component {
    constructor(props){super(props);this.state={error:null};}
    static getDerivedStateFromError(error){return {error:error||new Error('未知错误')};}
    componentDidCatch(error){report('panel-render-error',{error:String((error&&error.message)||error)});}
    render(){
      if(!this.state.error)return this.props.children;
      return h('div',{role:'alert','data-testid':'external-sync-render-error',style:{padding:14,fontSize:12,lineHeight:1.6,color:'var(--dsw-alias-state-error-primary)',whiteSpace:'pre-wrap'}},'同步面板渲染出错：'+(this.state.error.message||String(this.state.error)));
    }
  }
  const withBoundary=component=>props=>h(PanelBoundary,null,component(props));
  const inject=['slots','sidebarRight','sidebarRightTabs','uiWorkspace','layout'];
  function apply(ctx) {
    report('client-apply-enter');
    try {
    runtime=ctx;
    ctx.effect(()=>ctx.sidebarRightTabs.register({id:ID,kind:KIND,title:()=> 'Codex / Claude 上下文',priority:'extension',guide:[{id:'open',order:10,title:()=> '外部会话同步',description:()=> '查看历史并在 DSH 接手'}]}),'external-sync.tab');
    ctx.effect(()=>ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:PANEL_ID,order:35,priority:-10,label:'Codex 同步'},Glyph)),'external-sync.nav');
    ctx.effect(()=>ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:PANEL_ID},withBoundary(props=>h(Panel,{...props,main:true})))),'external-sync.main');
    ctx.effect(()=>ctx.slots.inject('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id:ID+'.footer',order:35,label:'外部会话同步'},OpenButton)),'external-sync.footer');
    ctx.effect(()=>ctx.slots.inject('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id:ID+'.footer.archive',order:36,label:'旧会话归档'},ArchiveFooterButton)),'external-sync.footer-archive');
  ctx.effect(()=>ctx.slots.inject('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id:ID+'.footer.delete',order:37,label:'删除已归档'},DeleteArchivedFooterButton)),'external-sync.footer-delete');
    ctx.effect(()=>ctx.slots.inject('conversation.session.header.utilities',()=>ctx.slots.register({name:'conversation.session.header.utilities',id:ID+'.header',order:35,label:'会话同步'},NativeMarker)),'external-sync.header');
    ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:ID},withBoundary(Panel))),'external-sync.body');
    ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab.title',()=>ctx.slots.register({name:'sidebar.right.pane.tab.title',key:ID},()=>h('span',null,'Codex / Claude 上下文'))),'external-sync.title');
    ctx.effect(()=>{
      report('client-mounted',{version:'1.2.0'});
      const initial=setTimeout(()=>{try{ctx.sidebarRight.openTab(KIND);}catch{}},500);
      return()=>clearTimeout(initial);
    },'external-sync.initial-panel');
    } catch(error) {report('client-apply-error',{error:error.message});throw error;}
  }
  return {apply,inject};
}});

// build-marker: delete-visible-1.7.3