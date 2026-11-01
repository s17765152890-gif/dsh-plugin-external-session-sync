import fs from 'node:fs';
import {listCodexSessions,listCodexThreadsFromDb} from './readers.js';

function head(file) {
  let fd;
  try {
    fd=fs.openSync(file,'r');
    const buffer=Buffer.alloc(64*1024);
    const size=fs.readSync(fd,buffer,0,buffer.length,0);
    for(const line of buffer.toString('utf8',0,size).split('\n').slice(0,12)) {
      try {const event=JSON.parse(line);if(event.type==='session_meta')return event.payload || {};}catch{}
    }
  }catch{}finally{if(fd!==undefined)fs.closeSync(fd);}
  return {};
}

// Scan directories ONCE per request; do not rescan the entire tree per thread.
// Include fresh rollouts even while Codex is still committing its SQLite row.
export function discoverCodexThreads() {
  let rows=[];
  try {rows=listCodexThreadsFromDb();}catch{}
  const groups=new Map(rows.map(row=>[row.id,{...row,files:[]}]));
  const metadata=new Map(rows.map(row=>[row.id,{...row,rolloutPath:row.file}]));
  for(const rollout of listCodexSessions({threads:metadata})) {
    let group=groups.get(rollout.id);
    if(!group) {
      const meta=head(rollout.file);
      group={...rollout,cwd:meta.cwd || rollout.cwd,createdAt:Date.parse(meta.timestamp)||rollout.startedAt,title:rollout.title || null,isSubagent:!!(meta.agent_path || meta.parent_thread_id),files:[]};
      groups.set(rollout.id,group);
    }
    group.files.push(rollout.file);
  }
  return [...groups.values()].map(row=>{
    // Honor an index pointer outside the usual directories as well.
    if(row.file && !row.files.some(file=>file.replace(/^\\\\\?\\/,'')===row.file.replace(/^\\\\\?\\/,'')) && fs.existsSync(row.file))row.files.push(row.file);
    let totalBytes=0,newestMtime=row.updatedAt || 0,latest=row.file || null;
    for(const file of row.files) {
      try {const stat=fs.statSync(file);totalBytes+=stat.size;if(stat.mtimeMs>=newestMtime){newestMtime=stat.mtimeMs;latest=file;}}catch{}
    }
    const {files,...item}=row;
    return {...item,file:latest,source:'codex',bytes:totalBytes || undefined,updatedAt:newestMtime || null,rolloutCount:files.length,revision:`${row.id}:${row.updatedAt || 0}:${newestMtime}:${totalBytes}:${row.userMessages || 0}:${row.assistantMessages || 0}`};
  });
}
