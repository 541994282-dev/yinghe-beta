'use strict';
// User-approved route; publish only after a real public processing test succeeds.
const experienceAPI = 'https://yinghe-web-api.541994282.workers.dev';
const maxUploadBytes = 1024 * 1024 * 1024;
const singleUploadBytes = 8 * 1024 * 1024;
const jobStorageKey = 'yinghe-web-active-job';
const clientStorageKey = 'yinghe-experience-id';
const experienceId = (() => {
  let value;
  try { value = localStorage.getItem(clientStorageKey); } catch (_) {}
  if (!/^[0-9a-f]{32}$/.test(value || '')) {
    value = crypto.randomUUID().replace(/-/g,'');
    try { localStorage.setItem(clientStorageKey,value); } catch (_) {}
  }
  return value;
})();
let remainingSeconds = 1800;
let activeJob = null;
let ownedJobId = null;
let uploadNeedsFile = false;
let processingCaptions = [];
let runController = null;
let cancelling = false;
let uploadTransport = 'local';
const stoppedUpload = () => Object.assign(new Error('操作已停止'), {name:'AbortError'});

function rememberJob(job) {
  try { localStorage.setItem(jobStorageKey, JSON.stringify(job)); } catch (_) { /* Private browsing may disable storage. */ }
}
function forgetJob(id) {
  if (!id) return;
  try {
    const saved = JSON.parse(localStorage.getItem(jobStorageKey));
    if (saved?.id === id) localStorage.removeItem(jobStorageKey);
  } catch (_) {}
}
function savedJob() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(jobStorageKey)); } catch (_) { return null; }
  if (!saved || !/^[0-9a-f]{32}$/.test(saved.id) || !Number.isFinite(saved.created) || Date.now() - (saved.completedAt || saved.created) > 24 * 60 * 60 * 1000) return null;
  return saved;
}
function adoptJob(job) {
  activeJob = job;
  ownedJobId = job.id;
}
function finishJob(job) {
  uploadNeedsFile = false;
  if (activeJob?.id === job.id) activeJob = null;
  forgetJob(job.id);
  if (ownedJobId === job.id) ownedJobId = null;
}
async function reserveJob() {
  const signal = runController?.signal;
  const reserve = async () => {
    const saved = savedJob();
    if (saved && !saved.completed) {
      adoptJob(saved);
      return {job:saved, upload:false};
    }
    const id = crypto.randomUUID().replace(/-/g, '');
    const chunked = uploadTransport === 'oss' || currentFile.size > singleUploadBytes;
    const file = chunked ? {size:currentFile.size,fingerprint:await fileFingerprint(currentFile)} : null;
    if (signal?.aborted) throw stoppedUpload();
    const job = {id, requestId:id, name:currentFile.name, created:Date.now(),chunked,file,transport:uploadTransport};
    adoptJob(job);
    rememberJob(job);
    return {job, upload:true};
  };
  if (typeof navigator !== 'undefined' && navigator.locks?.request) return navigator.locks.request('yinghe-web-submit', reserve);
  return reserve();
}
function clearResult() {
  uploadNeedsFile = false;
  forgetJob(ownedJobId);
  ownedJobId = null;
  activeJob = null;
  resultUrl = null;
  processingCaptions = [];
  byId('result-actions').hidden = true;
  for (const id of ['download-video', 'download-subtitles']) byId(id).removeAttribute('href');
  byId('subtitle-list').replaceChildren();
  byId('subtitle-list').hidden = true;
  byId('subtitle-empty').hidden = false;
  byId('subtitle-count').textContent = '0';
  byId('status-count').textContent = '0 条字幕';
}
function setRunning(value) {
  if (value && !running) runController = new AbortController();
  running = value;
  const restriction = !activeJob && !resultUrl ? videoRestriction() : '';
  byId('video-limit-message').textContent = restriction;
  byId('video-limit-message').hidden = !restriction;
  const canCancel = value || !!activeJob?.cancelRequested;
  byId('start-translation').disabled = cancelling || (!canCancel && (uploadNeedsFile ? !currentFile || currentFile.size > maxUploadBytes : !activeJob && (!currentFile || !!videoRestriction())));
  byId('replace-video').disabled = value || (!!activeJob && !uploadNeedsFile);
  byId('choose-video').disabled = value || (!!activeJob && !uploadNeedsFile);
  byId('start-label').textContent = cancelling ? '正在取消…' : activeJob?.cancelRequested ? '重试取消' : value ? '取消翻译' : uploadNeedsFile ? '继续上传' : activeJob ? '继续查看任务' : restriction ? '请更换视频或使用 App' : '一键翻译';
  byId('start-icon').setAttribute('href', canCancel || cancelling ? '#i-stop' : '#i-play');
}
async function fileFingerprint(file) {
  const sample = new Blob([JSON.stringify([file.name,file.size,file.lastModified||0]),file.slice(0,256*1024),file.slice(Math.max(0,file.size-256*1024))]);
  const hash = await crypto.subtle.digest('SHA-256',await sample.arrayBuffer());
  return Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join('');
}
const uploadPause = attempt => new Promise(resolve=>setTimeout(resolve,Math.min(1000*2**attempt,8000)));
function transientUpload(error) {
  return !error.apiRejected || [409,429,502,503,504].includes(error.status);
}
async function uploadRequest(path,options) {
  const signal = runController?.signal;
  for (let attempt=0;attempt<5;attempt++) {
    try { return await apiJSON(path,options); }
    catch (error) {
      if (signal?.aborted) throw error;
      if (!transientUpload(error) || attempt===4) throw error;
      setStatus('网络中断，正在恢复上传…',true);
      await uploadPause(attempt);
      // Each retry gets a fresh timeout rather than an already-aborted signal.
      options={...options,signal:AbortSignal.timeout(180000)};
    }
  }
}
function validateUpload(info,job) {
  if (info?.id!==job.id || info.size!==job.file.size || info.fingerprint!==job.file.fingerprint ||
      !Number.isInteger(info.receivedBytes) || info.receivedBytes<0 || info.receivedBytes>info.size ||
      !Number.isInteger(info.chunkBytes) || info.chunkBytes<=0 || info.chunkBytes>singleUploadBytes ||
      (info.receivedBytes!==info.size && info.receivedBytes%info.chunkBytes!==0)) throw new Error('上传进度异常，请稍后继续');
  if (info.state!=='uploading' && info.state!=='failed' && info.receivedBytes!==info.size) throw new Error('上传尚未完整确认');
  if (info.state==='failed') { finishJob(job); throw new Error('上传任务已过期，请重新选择视频'); }
  if (!['uploading','queued','processing','done'].includes(info.state)) throw new Error('上传状态异常');
  if (info.receivedChunks !== undefined) {
    const count=Math.ceil(info.size/info.chunkBytes);
    if (!Array.isArray(info.receivedChunks) || info.receivedChunks.length>count ||
        new Set(info.receivedChunks).size!==info.receivedChunks.length ||
        info.receivedChunks.some(index=>!Number.isInteger(index)||index<0||index>=count)) throw new Error('上传分块记录异常');
  }
  return info;
}
function cloudURL(raw, path) {
  const url = new URL(raw);
  if (url.protocol!=='https:' || url.host!=='yinghe-web-media-hk-541994282.oss-cn-hongkong.aliyuncs.com' ||
      url.username || url.password || url.pathname!==path || !url.searchParams.has('x-oss-signature')) {
    throw new Error('云端连接地址异常，请稍后重试');
  }
  return raw;
}
async function cloudPut(ticket,job,index,sha256,body,onProgress) {
  const url=cloudURL(ticket?.url,'/jobs/'+job.id+'/input/'+index+'-'+sha256);
  if (!Number.isFinite(ticket.expiresAt) || ticket.expiresAt*1000<=Date.now()) throw new Error('上传授权已过期，请继续上传');
  const headers={};
  for (const [name,value] of Object.entries(ticket.headers||{})) {
    if (name.toLowerCase()==='content-length') {
      if (Number(value)!==body.size) throw new Error('分块长度异常');
      continue; // Browser supplies and signs the Blob's exact length.
    }
    if (!['content-type','x-oss-forbid-overwrite'].includes(name.toLowerCase())) throw new Error('上传授权异常');
    headers[name]=String(value);
  }
  const signal=runController ? AbortSignal.any([runController.signal,AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
  if(signal.aborted)throw stoppedUpload();
  let status;
  if(typeof XMLHttpRequest!=='undefined') {
    status=await new Promise((resolve,reject)=>{
      const request=new XMLHttpRequest();
      const abort=()=>request.abort();
      const clean=()=>signal.removeEventListener('abort',abort);
      request.open('PUT',url);
      for(const [name,value] of Object.entries(headers))request.setRequestHeader(name,value);
      request.timeout=180000;
      request.upload.onprogress=event=>onProgress(event.loaded);
      request.onload=()=>{clean();resolve(request.status);};
      request.onerror=()=>{clean();reject(new Error('云端上传连接中断，请继续上传'));};
      request.ontimeout=()=>{clean();reject(new Error('云端上传超时，请继续上传'));};
      request.onabort=()=>{clean();reject(stoppedUpload());};
      signal.addEventListener('abort',abort,{once:true});
      request.send(body);
    });
  } else status=(await fetch(url,{method:'PUT',headers,body,signal,credentials:'omit',referrerPolicy:'no-referrer'})).status;
  // A lost successful response may be retried. Immutable objects return 409;
  // the backend still verifies their size and later their complete SHA256.
  if(status!==200 && status!==409)throw new Error('云端上传未确认，请继续上传');
}
async function sendPart(job,info,index,file,onProgress) {
  const body=file.slice(index*info.chunkBytes,Math.min((index+1)*info.chunkBytes,file.size));
  if(info.transport!=='oss')return apiJSON('/uploads/'+job.id+'/chunks/'+index,{
    method:'POST',headers:{'Content-Type':'application/octet-stream','X-Request-Id':job.id},
    body,signal:AbortSignal.timeout(180000),onUploadProgress:onProgress});
  const hash=await crypto.subtle.digest('SHA-256',await body.arrayBuffer());
  const sha256=Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
  if(runController?.signal.aborted)throw stoppedUpload();
  const options={method:'POST',headers:{'Content-Type':'application/json','X-Request-Id':job.id},signal:AbortSignal.timeout(20000)};
  const path='/uploads/'+job.id+'/chunks/'+index;
  const granted=validateUpload(await apiJSON(path,{...options,body:JSON.stringify({action:'authorize',sha256})}),job);
  if(granted.receivedChunks?.includes(index))return granted;
  await cloudPut(granted.ticket,job,index,sha256,body,onProgress);
  if(runController?.signal.aborted)throw stoppedUpload();
  return apiJSON(path,{...options,signal:AbortSignal.timeout(20000),body:JSON.stringify({action:'commit',sha256})});
}
async function uploadChunks(job,file) {
  const signal=runController?.signal;
  const assertActive=()=>{if(signal?.aborted || activeJob?.id!==job.id)throw stoppedUpload();};
  if (file.size!==job.file.size || await fileFingerprint(file)!==job.file.fingerprint) throw new Error('请选择原来的视频继续上传，已上传部分仍保留');
  assertActive();
  const transfer=async()=>{
    const options={'Content-Type':'application/json','X-Request-Id':job.id};
    let info=validateUpload(await uploadRequest('/uploads',{method:'POST',headers:options,
      body:JSON.stringify({size:file.size,name:file.name,fingerprint:job.file.fingerprint,transport:job.transport}),signal:AbortSignal.timeout(180000)}),job);
    const began=Date.now(), initial=info.uploadedBytes??info.receivedBytes;
    const confirmed=new Set(info.receivedChunks||Array.from({length:Math.ceil(info.receivedBytes/info.chunkBytes)},(_,i)=>i));
    const inFlight=new Map(), count=Math.ceil(file.size/info.chunkBytes);
    const partSize=index=>Math.min(info.chunkBytes,file.size-index*info.chunkBytes);
    const report=()=>{
      assertActive();
      const bytes=[...confirmed].reduce((sum,index)=>sum+partSize(index),0)+[...inFlight].reduce((sum,[index,loaded])=>sum+(confirmed.has(index)?0:loaded),0);
      const elapsed=(Date.now()-began)/1000, rate=elapsed>0?(bytes-initial)/elapsed:0;
      const detail=elapsed>=2&&rate>0 ? ' · '+(rate>=1024*1024?(rate/1024**2).toFixed(1)+' MB/秒':Math.round(rate/1024)+' KB/秒')+
        ' · 预计剩余 '+(file.size-bytes>rate*60?Math.ceil((file.size-bytes)/rate/60)+' 分钟':Math.ceil((file.size-bytes)/rate)+' 秒') : '';
      setStatus('正在上传视频 '+Math.min(99,Math.floor(bytes*100/file.size))+'%'+detail);
    };
    const merge=next=>{info=next;for(const index of next.receivedChunks||[])confirmed.add(index);};
    // Older running backends remain compatible with the sequential path below.
    if (Array.isArray(info.receivedChunks) && info.parallelChunks>1 && info.state==='uploading') {
      const pending=new Set(); let failure;
      const worker=async()=>{
        while(!failure) {
          assertActive();
          const index=Array.from({length:count},(_,i)=>i).find(i=>!confirmed.has(i)&&!pending.has(i));
          if(index===undefined)return;
          pending.add(index);
          try {
            for(let attempt=0;;attempt++) {
              assertActive();
              inFlight.set(index,0);report();
              try {
                const next=validateUpload(await sendPart(job,info,index,file,
                  loaded=>{if(!signal?.aborted){inFlight.set(index,Math.min(partSize(index),loaded));report();}}),job);
                merge(next);
                if(!confirmed.has(index))throw new Error('分块尚未确认');
                break;
              } catch(error) {
                assertActive();
                if(!transientUpload(error)||attempt>=4)throw error;
                inFlight.delete(index);
                setStatus('正在恢复上传，已完成的部分不会重传…',true);
                await uploadPause(attempt);
                assertActive();
                merge(validateUpload(await uploadRequest('/uploads/'+job.id,{signal:AbortSignal.timeout(15000)}),job));
                if(confirmed.has(index))break;
              }
            }
          } catch(error) {failure=error;throw error;}
          finally {pending.delete(index);inFlight.delete(index);}
          report();
        }
      };
      await Promise.allSettled(Array.from({length:Math.min(3,info.parallelChunks)},worker));
      if(failure)throw failure;
      assertActive();
      info=validateUpload(await uploadRequest('/uploads/'+job.id,{signal:AbortSignal.timeout(15000)}),job);
    }
    let failures=0;
    while (info.state==='uploading' && info.receivedBytes<file.size) {
      assertActive();
      const offset=info.receivedBytes;
      setStatus('正在上传视频 '+Math.floor(offset*100/file.size)+'% · 中断可续传');
      try {
        const next=validateUpload(await sendPart(job,info,Math.floor(offset/info.chunkBytes),file,
          loaded=>{if(!signal?.aborted){inFlight.set(Math.floor(offset/info.chunkBytes),loaded);report();}}),job);
        if (next.receivedBytes<=offset) throw new Error('分块尚未确认，正在恢复上传');
        info=next;
        confirmed.add(Math.floor(offset/info.chunkBytes));inFlight.clear();
        failures=0;
      } catch (error) {
        assertActive();
        if (!transientUpload(error) || ++failures>5) throw error;
        setStatus('正在恢复上传，已完成的部分不会重传…',true);
        await uploadPause(failures-1);
        info=validateUpload(await uploadRequest('/uploads/'+job.id,{signal:AbortSignal.timeout(15000)}),job);
      }
    }
    if (info.state==='uploading') {
      assertActive();
      setStatus('上传完成，正在准备翻译…');
      await uploadRequest('/uploads/'+job.id+'/complete',{method:'POST',headers:options,body:'{}',signal:AbortSignal.timeout(180000)});
    }
  };
  if (typeof navigator!=='undefined' && navigator.locks?.request) {
    await navigator.locks.request('yinghe-upload-'+job.id,{ifAvailable:true},lock=>{
      if (!lock) throw new Error('另一页面正在上传这个视频，请回到原页面查看');
      return transfer();
    });
  } else await transfer();
}
async function continueJob(job) {
  if (job.chunked) {
    let state;
    try { state=await apiJSON('/jobs/'+job.id,{signal:AbortSignal.timeout(15000)}); }
    catch (error) { if (error.status!==404) throw error; state={state:'uploading'}; }
    if (state.state==='uploading') {
      uploadNeedsFile=true;
      if (!currentFile) {
        byId('replace-video').hidden=false;
        setStatus('上传未完成，请重新选择原视频继续；已上传部分保留 24 小时',true);
        return;
      }
      await uploadChunks(job,currentFile);
      uploadNeedsFile=false;
    }
  }
  await followJob(job);
}
async function apiJSON(path, options = {}) {
  const {ignoreRunCancellation=false,onUploadProgress,...requestOptions}=options;
  const headers = {'X-Experience-Id':experienceId,...requestOptions.headers};
  const signal=!ignoreRunCancellation&&runController ? AbortSignal.any([runController.signal,...(requestOptions.signal?[requestOptions.signal]:[])]) : requestOptions.signal;
  if(signal?.aborted)throw stoppedUpload();
  const response = onUploadProgress && typeof XMLHttpRequest!=='undefined' ? await new Promise((resolve,reject)=>{
    const request=new XMLHttpRequest();
    const abort=()=>request.abort();
    const cleanup=()=>signal?.removeEventListener('abort',abort);
    request.open(requestOptions.method||'GET',experienceAPI+path);
    for(const [key,value] of Object.entries(headers))request.setRequestHeader(key,value);
    request.timeout=180000;
    request.upload.onprogress=event=>onUploadProgress(event.loaded);
    request.onload=()=>{cleanup();resolve({ok:request.status>=200&&request.status<300,status:request.status,json:async()=>JSON.parse(request.responseText)});};
    request.onerror=()=>{cleanup();reject(new TypeError('Failed to fetch'));};
    request.ontimeout=()=>{cleanup();reject(new Error('上传超时，请继续上传'));};
    request.onabort=()=>{cleanup();reject(stoppedUpload());};
    signal?.addEventListener('abort',abort,{once:true});
    request.send(requestOptions.body);
  }) : await fetch(experienceAPI + path, {cache:'no-store',...requestOptions,headers,signal});
  let data;
  try { data = await response.json(); } catch (_) { throw new Error('处理服务返回异常，请稍后重试'); }
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : '';
    const error = new Error(message || '处理服务暂时不可用');
    error.state=data?.state;
    if (message) { error.status = response.status; error.apiRejected = true; }
    throw error;
  }
  return data;
}

async function cancelTranslation() {
  if(cancelling)return;
  const job=activeJob;
  cancelling=true;
  runController?.abort();
  if(job){job.cancelRequested=true;rememberJob(job);}
  setRunning(running);
  setStatus('正在取消操作…');
  try {
    if(job) {
      try {
        const reply=await apiJSON('/uploads/'+job.id+'/complete',{method:'POST',headers:{'Content-Type':'application/json','X-Request-Id':job.id},body:JSON.stringify({action:'cancel'}),signal:AbortSignal.timeout(20000),ignoreRunCancellation:true});
        if(reply.id!==job.id || reply.reason!=='cancelled')throw new Error('取消尚未确认');
      } catch(error) {
        if(error.status===409 && error.state==='done') {
          runController=null;activeJob=null;
          rememberJob({...job,completed:true,completedAt:Date.now(),cancelRequested:false});
          await showResult(job);
          return;
        }
        if(error.status!==404)throw error;
      }
      finishJob(job);
    }
    clearResult();restoreOriginalPreview();
    setStatus('已取消 · 未扣体验额度');
    try{await apiJSON('/allowance',{ignoreRunCancellation:true,signal:AbortSignal.timeout(15000)}).then(info=>{
      if(Number.isFinite(info.remainingSeconds)&&info.remainingSeconds>=0&&info.remainingSeconds<=1800){remainingSeconds=info.remainingSeconds;byId('remaining-time').textContent=formatDuration(remainingSeconds);}
    });}catch(_){}
  } catch(error) {setStatus('取消尚未确认，点击“重试取消”继续；请勿重复提交',true);}
  finally {cancelling=false;runController=null;setRunning(false);}
}
async function checkService() {
  try {
    const info = await apiJSON('/health', {signal: AbortSignal.timeout(15000)});
    uploadTransport=info.uploadTransport==='oss' ? 'oss' : 'local';
    byId('upload-route').textContent=uploadTransport==='oss' ?
      '视频暂存于阿里云香港，由处理电脑翻译；文件有效期 24 小时。' :
      '点击翻译后，视频经 Cloudflare 转发至处理电脑；素材与结果保留 24 小时。';
    byId('service-status').textContent = info.ready ? '处理服务已连接 · 保留原声' : '处理电脑暂未连接 · 可下载 App 使用';
    if (info.ready) await refreshAllowance();
    return info.ready === true;
  } catch (_) {
    byId('service-status').textContent = '处理服务暂时无法连接 · 可下载 App 使用';
    return false;
  }
}
async function refreshAllowance() {
  const info = await apiJSON('/allowance',{signal:AbortSignal.timeout(15000)});
  if (!Number.isFinite(info.remainingSeconds) || info.remainingSeconds < 0 || info.remainingSeconds > 1800) throw new Error('体验额度读取异常');
  remainingSeconds = info.remainingSeconds;
  byId('remaining-time').textContent = Math.floor(remainingSeconds/60)+':'+String(Math.floor(remainingSeconds%60)).padStart(2,'0');
  if (!running) setRunning(false);
}
function parseSubtitles(srt) {
  const stamp = '(\\d{2,}):(\\d{2}):(\\d{2})[,\\.](\\d{3})';
  const timing = new RegExp('^' + stamp + '\\s+-->\\s+' + stamp + '$');
  const seconds = (m, offset) => Number(m[offset]) * 3600 + Number(m[offset + 1]) * 60 + Number(m[offset + 2]) + Number(m[offset + 3]) / 1000;
  return srt.replace(/^\uFEFF/, '').replace(/\r/g, '').trim().split(/\n\s*\n/).flatMap(block => {
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0])) lines.shift();
    const match = lines.shift()?.trim().match(timing);
    if (!match || !lines.length) return [];
    const start = seconds(match, 1), end = seconds(match, 5);
    return end > start ? [{start, end, text: lines.join('\n')}] : [];
  });
}
function showSubtitles(captions) {
  processingCaptions = captions;
  const list = byId('subtitle-list');
  list.replaceChildren();
  for (const caption of captions) {
    const row = document.createElement('button');
    row.type = 'button'; row.className = 'subtitle-row';
    const time = document.createElement('small');
    time.textContent = Math.floor(caption.start / 60) + ':' + String(Math.floor(caption.start % 60)).padStart(2, '0');
    const text = document.createElement('span');
    text.textContent = caption.text;
    row.append(time, text);
    row.addEventListener('click', () => { video.currentTime = caption.start; video.play().catch(() => {}); });
    list.append(row);
  }
  list.hidden = !captions.length;
  byId('subtitle-empty').hidden = captions.length > 0;
  byId('subtitle-count').textContent = String(captions.length);
  byId('status-count').textContent = captions.length + ' 条字幕';
}
video.addEventListener('timeupdate', () => {
  byId('subtitle-list').querySelectorAll('.subtitle-row').forEach((row, index) => {
    const caption = processingCaptions[index];
    row.classList.toggle('current', video.currentTime >= caption.start && video.currentTime < caption.end);
  });
});
async function showResult(job,state) {
  if(!state && job.transport==='oss')state=await apiJSON('/jobs/'+job.id,{signal:AbortSignal.timeout(15000)});
  const links=state?.transport==='oss' ? state.resultLinks : null;
  if(job.transport==='oss' && !links)throw new Error('成片下载链接暂未就绪，请继续查看任务');
  const resultPath='/jobs/'+job.id+'/output/';
  const subtitleUrl=links ? cloudURL(links['result.srt'],resultPath+'result.srt') : experienceAPI+'/jobs/'+job.id+'/result.srt';
  resultUrl = links ? cloudURL(links['result.mp4'],resultPath+'result.mp4') : experienceAPI + '/jobs/' + job.id + '/result.mp4';
  video.pause();
  video.src = resultUrl;
  byId('choose-video').hidden = true;
  byId('video-surface').hidden = false;
  byId('replace-video').hidden = false;
  byId('preview-watermark').hidden = true;
  byId('file-name').textContent = job.name || '双语成片';
  byId('file-meta').textContent = '双语成片';
  byId('download-video').href = links ? cloudURL(links['result.mp4:download'],resultPath+'result.mp4') : resultUrl + '?download=1';
  byId('download-subtitles').href = links ? cloudURL(links['result.srt:download'],resultPath+'result.srt') : subtitleUrl + '?download=1';
  byId('result-actions').hidden = false;
  setStatus('翻译完成 · 可播放或下载成片');
  try {
    const response = await fetch(subtitleUrl, {cache: 'no-store', signal: AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error('字幕读取失败');
    showSubtitles(parseSubtitles(await response.text()));
  } catch (_) { setStatus('成片已生成 · 字幕列表加载失败，可下载字幕查看', true); }
}
async function followJob(job) {
  const signal=runController?.signal;
  const deadline = Date.now() + 121 * 60 * 1000;
  let failures = 0;
  let missing = 0;
  while (Date.now() < deadline) {
    if(signal?.aborted || activeJob?.id!==job.id)throw stoppedUpload();
    let state;
    try { state = await apiJSON('/jobs/' + job.id, {signal: AbortSignal.timeout(15000)}); failures = 0; missing = 0; }
    catch (error) {
      if(signal?.aborted)throw error;
      if (error.status === 404 && error.apiRejected) {
        if (++missing >= 3) {
          finishJob(job);
          throw new Error('任务不存在或已过期，请重新选择视频');
        }
      } else { missing = 0; }
      if (++failures >= 4) throw new Error('连接中断，刷新页面可继续查看当前任务');
      setStatus('正在重新连接，任务会继续处理…', true);
      await new Promise(resolve => setTimeout(resolve, 3000)); continue;
    }
    if(signal?.aborted)throw stoppedUpload();
    if (state.state === 'failed') { finishJob(job); throw new Error(state.message || '处理未完成，请重试'); }
    if (state.state === 'done') {
      activeJob=null;
      if (savedJob()?.id === job.id) rememberJob({...job, completed:true, completedAt:Date.now()});
      await showResult(job,state);
      try { await refreshAllowance(); } catch (_) { setStatus('成片已生成，可下载；额度暂时无法刷新',true); }
      return;
    }
    if (!['uploading', 'queued', 'processing'].includes(state.state)) throw new Error('任务状态异常，请稍后刷新');
    setStatus(state.message || '正在处理…');
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  throw new Error('处理时间较长，刷新页面可查看任务状态');
}
byId('start-translation').addEventListener('click', async () => {
  if (cancelling) return;
  if (running || activeJob?.cancelRequested) { await cancelTranslation(); return; }
  const shared = savedJob();
  if (!activeJob && shared && !shared.completed) {
    clearResult();
    restoreOriginalPreview();
    adoptJob(shared);
  }
  if (activeJob) {
    setRunning(true);
    const controller=runController;
    try { await continueJob(activeJob); } catch (error) { if(!controller.signal.aborted)setStatus(error.message,true); }
    finally { if(runController===controller&&!cancelling)setRunning(false); }
    return;
  }
  if (!currentFile || currentFile.size > maxUploadBytes) return;
  setRunning(true);
  const controller=runController;
  clearResult();
  restoreOriginalPreview();
  try {
    setStatus('正在连接处理电脑…');
    if (!await checkService()) throw new Error('处理电脑暂未连接，请稍后重试或下载 App');
    if(controller.signal.aborted)throw stoppedUpload();
    if (!remainingSeconds) throw new Error('30 分钟体验额度已用完，可下载 App 继续使用');
    if (videoRestriction()) throw new Error(videoRestriction());
    const {job, upload} = await reserveJob();
    if (!upload) { await continueJob(job); return; }
    setStatus('正在上传视频，上传后自动翻译完整视频…');
    if (job.chunked) {
      uploadNeedsFile=true;
      try { await uploadChunks(job,currentFile); }
      catch(error) {
        if (error.apiRejected && [400,403,413].includes(error.status)) finishJob(job);
        throw error;
      }
      uploadNeedsFile=false;
    } else {
    try {
      const reply = await apiJSON('/jobs', {method: 'POST', headers: {'Content-Type': 'application/octet-stream', 'X-Request-Id':job.id}, body: currentFile, signal: AbortSignal.timeout(180000)});
      if (reply?.id !== job.id) throw new Error('任务确认信息异常');
    } catch (error) {
      if (error.apiRejected) { finishJob(job); throw error; }
      setStatus('正在恢复上传任务，视频不会重复提交…', true);
    }
    }
    await followJob(job);
  } catch (error) {
    if(!controller.signal.aborted)setStatus(error.message === 'Failed to fetch' ? '无法连接处理服务，请稍后重试' : error.message, true);
  } finally { if(runController===controller&&!cancelling)setRunning(false); }
});
async function restoreJob() {
  const saved = savedJob();
  if (!saved) return;
  adoptJob(saved);
  if(saved.cancelRequested){await cancelTranslation();return;}
  setRunning(true); setStatus('正在恢复上次任务…');
  const controller=runController;
  try { await continueJob(saved); } catch (error) { if(!controller.signal.aborted)setStatus(error.message, true); }
  finally { if(runController===controller&&!cancelling)setRunning(false); }
}
window.addEventListener('storage', event => {
  if (event.key !== jobStorageKey || running || activeJob) return;
  const saved = savedJob();
  if (!saved || saved.completed) return;
  clearResult();
  restoreOriginalPreview();
  adoptJob(saved);
  setRunning(false);
  setStatus('另一页面已有任务，点击“继续查看任务”查看进度');
});
checkService();
restoreJob();
