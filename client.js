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
  function Panel({useTabInfo,useWorkspaces,useSessions,main=false}) {
    const info=typeof useTabInfo==='function'?useTabInfo():null;
    // Never read a service off the Context unless it is injected: Cordis throws for a
    // service the plugin did not declare, and that throw unmounts the whole panel.
    const useWs=typeof useWorkspaces==='function'?useWorkspaces:useNoWorkspaceState;
    const workspaceState=useWs(state=>state) || EMPTY_WORKSPACE_STATE;
    const useSess=typeof useSessions==='function'?useSessions:useNoSessions;
    const sessionState=useSess(state=>state) || EMPTY_SESSIONS;
    const pinnedSessionIds=new Set(workspaceState.pinnedSessionIds || []);
    const archivedSessionIds=new Set(workspaceState.archivedSessionIds || []);
    const root=React.useRef(null),request=React.useRef(0),catalogRequest=React.useRef(0),mounted=React.useRef(true);
    const [catalog,setCatalog]=React.useState(null),[selected,setSelected]=React.useState(null),[conversation,setConversation]=React.useState(null);
    const [source,setSource]=React.useState('codex'),[query,setQuery]=React.useState(''),[busy,setBusy]=React.useState(false),[loading,setLoading]=React.useState(false),[refreshing,setRefreshing]=React.useState(true),[notice,setNotice]=React.useState('正在读取会话列表…'),[error,setError]=React.useState(''),[archiveMonths,setArchiveMonths]=React.useState('1');
    const [tab,setTab]=React.useState('in');
    const [reverseRows,setReverseRows]=React.useState(null),[reverseBusy,setReverseBusy]=React.useState(false),[reverseNotice,setReverseNotice]=React.useState('');
    const [reverseGroups,setReverseGroups]=React.useState([]),[reverseTarget,setReverseTarget]=React.useState(null),[reversePreview,setReversePreview]=React.useState([]);
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
    // Reverse sync lives behind an explicit scan + per-row confirm: it appends to another
    // tool's history, so nothing may happen on mount or for sessions the user did not pick.
    function visibleSessionIds(){
      return (sessionState.ids || []).filter(id=>{
        const summary=sessionState.byId?.[id];
        return !!summary && !summary.blank && !summary.removed;
      });
    }
    async function scanReverse(){
      const ids=visibleSessionIds();
      if(!ids.length){setReverseNotice('拿不到 DSH 会话列表，无法检查');return;}
      setReverseBusy(true);setReverseNotice('正在检查可反同步的会话…');
      try {
        const result=await api('/reverse',{dryRun:true,sessionIds:ids});
        const rows=(result.results || []).filter(row=>!row.error && row.turns>0);
        setReverseRows(rows);
        setReverseNotice(rows.length?`找到 ${rows.length} 个仅在 DSH 有新增轮次的会话`:'没有仅存在于 DSH 的新轮次');
        report('reverse-scanned',{sessions:ids.length,candidates:rows.length,errors:(result.results||[]).filter(row=>row.error).length});
      }catch(e){setReverseNotice('检查失败：'+e.message);report('reverse-scan-error',{error:e.message});}
      finally{setReverseBusy(false);}
    }
    async function doReverse(row){
      const title=sessionState.byId?.[row.sessionId]?.title || '未命名会话';
      const ask=typeof window!=='undefined' && typeof window.confirm==='function'
        ? window.confirm(`把「${title}」中仅存在于 DSH 的 ${row.turns} 轮对话，追加写入 Codex 会话 ${row.threadId}？\n\n只追加、不覆盖；写入前会备份 rollout 文件。`)
        : false;
      if(!ask){report('reverse-cancelled',{sessionId:row.sessionId});return;}
      setReverseBusy(true);
      try {
        const result=await api('/reverse',{dryRun:false,sessionIds:[row.sessionId]});
        const done=(result.results || []).find(r=>r.verified);
        setReverseNotice(done?`已写入 ${done.appended} 条记录（备份 ${done.backup.split('\\').pop()}）`:'没有写入任何记录');
        if(done)setReverseRows(rows=>(rows||[]).filter(r=>r.sessionId!==row.sessionId));
        report('reverse-complete',{sessionId:row.sessionId,appended:done?.appended || 0,verified:!!done});
      }catch(e){setReverseNotice('反同步失败：'+e.message);report('reverse-error',{error:e.message});}
      finally{setReverseBusy(false);}
    }
    React.useEffect(()=>{
      if(!catalog)return;
      const timer=setTimeout(()=>{const rows=root.current?.querySelectorAll('[data-external-session]') || [];const archiveButton=root.current?.querySelector('[data-testid=external-sync-archive-old]');const monthSelect=root.current?.querySelector('[data-testid=external-sync-archive-months]');report('catalog-rendered',{items:catalog.discovered.length,rows:rows.length,source,visible:!!root.current?.getClientRects().length,archiveControl:!!archiveButton,archiveEnabled:!!archiveButton&&!archiveButton.disabled,monthSelector:!!monthSelect,monthOptions:monthSelect?monthSelect.options.length:0,pinnedCount:pinnedSessionIds.size,archivedCount:archivedSessionIds.size,first:catalog.discovered.filter(i=>i.source===source).slice(0,3).map(i=>({id:i.id,title:i.title}))});},60);
      return()=>clearTimeout(timer);
    },[catalog,source,query]);
    const items=(catalog?.discovered||[]).filter(i=>i.source===source&&(!query || `${i.title} ${i.cwd}`.toLowerCase().includes(query.toLowerCase())));
    async function loadReverseGroups(){
      setReverseBusy(true);setReverseNotice('正在读取未归档会话…');
      try{
        const data=await api('/reverse-groups');
        const groups=(data.groups || []).filter(group=>group.sessionIds.length);
        setReverseGroups(groups);
        const total=groups.reduce((sum,group)=>sum+group.sessionIds.length,0);
        setReverseNotice('共 '+groups.length+' 个项目 / '+total+' 个未归档会话');
        report('reverse-groups',{groups:groups.length,sessions:total,archived:data.archived || 0});
      }catch(e){setReverseNotice('读取失败：'+e.message);report('reverse-groups-error',{error:e.message});}
      finally{setReverseBusy(false);}
    }
    async function probeReverse(sessionId){
      setReverseTarget(null);setReverseBusy(true);
      try{
        const data=await api('/reverse-targets',{sessionIds:[sessionId]});
        const row=(data.rows || [])[0];
        if(!row){setReverseNotice('没有拿到分类结果');return;}
        setReverseTarget(row);
        try{const preview=await api('/session-preview?id='+encodeURIComponent(sessionId)+'&maxMessages=60');setReversePreview(preview.messages || []);}
        catch{setReversePreview([]);}
        setReverseNotice(row.mode==='append'?(row.turns?'该会话有 '+row.turns+' 轮仅在 DSH 的新对话':'没有仅存在于 DSH 的新轮次'):row.mode==='export'?('将以 '+row.turns+' 轮新建一个 Codex 会话'):(row.error || '无法处理'));
        report('reverse-probed',{sessionId,mode:row.mode,turns:row.turns || 0,forked:!!row.forked});
      }catch(e){setReverseNotice('分类失败：'+e.message);}
      finally{setReverseBusy(false);}
    }
    async function writeReverse(){
      const target=reverseTarget;
      if(!target || !(target.turns>0))return;
      const title=sessionState.byId?.[target.sessionId]?.title || '未命名会话';
      const what=target.mode==='append'
        ? '把「'+title+'」中仅存在于 DSH 的 '+target.turns+' 轮对话，追加写入 Codex 会话 '+target.threadId+'？'
        : '把「'+title+'」整段（'+target.turns+' 轮）导出为一个新的 Codex 会话？';
      const ask=typeof window!=='undefined' && typeof window.confirm==='function'
        ? window.confirm(what+'\n\n追加只增不改；导出会新建 rollout 文件。')
        : false;
      if(!ask){report('reverse-cancelled',{sessionId:target.sessionId});return;}
      setReverseBusy(true);
      try{
        const result=await api('/reverse',{dryRun:false,sessionIds:[target.sessionId]});
        const done=(result.results || [])[0] || {};
        setReverseNotice(done.error?('失败：'+done.error):done.mode==='export'?('已导出为新的 Codex 会话（'+done.records+' 条记录）'):('已写入 '+done.appended+' 条记录（已备份）'));
        if(done.verified)setReverseTarget(null);
        report('reverse-complete',{sessionId:target.sessionId,mode:done.mode,appended:done.appended || 0,verified:!!done.verified});
      }catch(e){setReverseNotice('反同步失败：'+e.message);report('reverse-error',{error:e.message});}
      finally{setReverseBusy(false);}
    }
    const btn=(text,fn,disabled,testid)=>h('button',{type:'button',style:button,onClick:fn,disabled,'data-testid':testid},text);
    return h('section',{ref:root,'data-testid':'external-sync-panel',style:{height:'100%',minHeight:0,display:'flex',flexDirection:'column',color:color.text,background:color.bg,fontSize:13}},
      h('div',{style:{padding:'12px',borderBottom:'1px solid '+color.border,flexShrink:0}},
        h('div',{style:{fontSize:15,fontWeight:650,marginBottom:8}},'外部会话同步与接力'),
        h('div',{role:'tablist',style:{display:'flex',gap:6,marginBottom:8}},
          h('button',{type:'button','data-testid':'external-sync-tab-in',onClick:()=>setTab('in'),style:{...button,background:tab==='in'?color.layer:'transparent',fontWeight:tab==='in'?650:400,color:tab==='in'?color.text:color.muted}},'同步到 DSH'),
          h('button',{type:'button','data-testid':'external-sync-tab-out',onClick:()=>setTab('out'),style:{...button,background:tab==='out'?color.layer:'transparent',fontWeight:tab==='out'?650:400,color:tab==='out'?color.text:color.muted}},'反同步到外界')),
        h('div',{style:{display:tab==='in'?'flex':'none',gap:6,flexWrap:'wrap',alignItems:'center'}},
          h('select',{value:source,onChange:e=>{setSource(e.target.value);const first=catalog?.discovered.find(i=>i.source===e.target.value);if(first)select(first);},style:{...button,padding:5}},h('option',{value:'codex'},`Codex (${catalog?.counts.codex ?? '…'})`),h('option',{value:'claude'},`Claude (${catalog?.counts.claude ?? '…'})`)),
          btn(refreshing?'刷新中…':'刷新',()=>refresh(),busy||refreshing,'external-sync-refresh'),btn('同步全部',()=>runSync(true),busy||refreshing||!catalog,'external-sync-all'),btn(busy?'处理中…':'同步所选',()=>runSync(false),busy||refreshing||!selected,'external-sync-selected'),
          btn('在 DSH 继续',handoff,busy||!selected?.dshSessionId,'external-sync-handoff'),
           h('select',{'data-testid':'external-sync-archive-months',value:archiveMonths,onChange:e=>setArchiveMonths(e.target.value),disabled:busy,style:{...button,padding:5},title:'置顶会话永不归档'},h('option',{value:'1'},'1个月前'),h('option',{value:'3'},'3个月前'),h('option',{value:'6'},'6个月前'),h('option',{value:'12'},'1年前')),
           btn('归档旧会话',archiveOld,busy||refreshing||!catalog,'external-sync-archive-old'),
          main?btn('在右侧查看',()=>openPanel(selected?{source:selected.source,id:selected.id}:undefined),false):null),
        tab==='in'&&notice?h('div',{'role':'status','data-testid':'external-sync-result',style:{marginTop:8,color:'var(--dsw-alias-state-success-primary)',whiteSpace:'pre-wrap'}},notice):null,
        tab==='in'&&error?h('div',{'role':'alert',style:{marginTop:8,color:'var(--dsw-alias-state-error-primary)',whiteSpace:'pre-wrap'}},error):null,
        tab==='out'?h('div',{'data-testid':'external-sync-reverse',style:{marginTop:8,fontSize:12,lineHeight:1.6}},
          h('div',{style:{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}},
            btn(reverseBusy?'处理中…':'读取未归档会话',loadReverseGroups,reverseBusy,'external-sync-reverse-scan'),
            reverseNotice?h('span',{style:{color:color.muted}},reverseNotice):null),
          h('div',{style:{marginTop:6,color:color.muted,fontSize:11}},'按项目列出全部未归档会话（含 DSH 原生会话与接力 fork）。导入会话追加到其 Codex 主线；原生会话导出为新的 Codex 会话。'),
          reverseTarget?h('div',{'data-testid':'external-sync-reverse-target',style:{marginTop:8,padding:8,border:'1px solid '+color.border,borderRadius:6}},
            h('div',{style:{fontWeight:600}},reverseTarget.mode==='append'?'追加到 Codex 主线':'导出为新的 Codex 会话'),
            h('div',{style:{color:color.muted,marginTop:2}},reverseTarget.mode==='append'?('线程 '+String(reverseTarget.threadId||'').slice(0,8)+' · 待写入 '+(reverseTarget.turns||0)+' 轮'+(reverseTarget.forked?'（fork）':'')):('将新建线程 · '+(reverseTarget.turns||0)+' 轮')),
            h('div',{style:{marginTop:6}},btn(reverseBusy?'写入中…':'确认反同步',writeReverse,reverseBusy||!(reverseTarget.turns>0),'external-sync-reverse-write'))):null):null),
      tab==='out'?h('div',{style:{display:'flex',flex:1,minHeight:0}},
        h('div',{style:{width:main?250:190,maxWidth:'40%',flexShrink:0,overflow:'auto',borderRight:'1px solid '+color.border,padding:6}},
          !reverseGroups.length?h('div',{style:{padding:8,color:color.muted,fontSize:12}},reverseNotice||'点击上方「读取未归档会话」'):null,
          reverseGroups.map(group=>h('div',{key:group.id,style:{marginBottom:8}},
            h('div',{style:{fontSize:10,fontWeight:650,color:color.muted,padding:'2px 4px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},group.title||group.path),
            group.sessionIds.map(sid=>{
              const summary=sessionState.byId?.[sid]||{};
              const active=reverseTarget && reverseTarget.sessionId===sid;
              return h('button',{key:sid,type:'button','data-external-reverse':sid,onClick:()=>probeReverse(sid),title:summary.title||'',style:{display:'block',width:'100%',textAlign:'left',background:active?color.layer:'transparent',border:0,color:color.text,borderRadius:6,padding:'5px 8px',cursor:'pointer',fontSize:12,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},summary.title||'未命名会话');
            })))),
        h('div',{style:{flex:1,minWidth:0,overflow:'auto',padding:12}},
          reversePreview.length?h(React.Fragment,null,
            h('div',{style:{fontSize:11,color:color.muted,marginBottom:8}},'最近 '+reversePreview.length+' 条消息预览'),
            reversePreview.map((message,index)=>h('div',{key:index,style:{marginBottom:10}},
              h('div',{style:{fontSize:10,color:color.muted}},message.role==='user'?'用户':'助手'),
              h('div',{style:{fontSize:12,whiteSpace:'pre-wrap',lineHeight:1.55,overflowWrap:'anywhere'}},message.text))))
            :h('div',{style:{color:color.muted,fontSize:12}},reverseTarget?'正在读取消息预览…':'左侧选择一个会话，这里会显示它的消息内容'))):null,
      h('div',{style:{display:tab==='in'?'block':'none',padding:'8px 12px',borderBottom:'1px solid '+color.border}},h('input',{placeholder:'搜索标题或项目目录',value:query,onChange:e=>setQuery(e.target.value),style:{...button,width:'100%',boxSizing:'border-box'}})),
      h('div',{style:{display:tab==='in'?'flex':'none',flex:1,minHeight:0}},
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
      report('client-mounted',{version:'1.0.0'});
      const initial=setTimeout(()=>{try{ctx.sidebarRight.openTab(KIND);}catch{}},500);
      return()=>clearTimeout(initial);
    },'external-sync.initial-panel');
    } catch(error) {report('client-apply-error',{error:error.message});throw error;}
  }
  return {apply,inject};
}});
