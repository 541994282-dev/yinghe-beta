'use strict';
const byId = (id) => document.getElementById(id);
const fileInput = byId('video-file');
const video = byId('video-preview');
const stage = byId('preview-stage');
const dialog = byId('download-dialog');
let videoUrl = null;
let dialogOpener = null;
let currentFile = null;
let running = false;
let resultUrl = null;
let currentDuration = 0;

function formatDuration(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
}
function videoRestriction() {
  if (!currentFile) return '';
  if (currentFile.size > maxUploadBytes) return '视频超过 1 GB，请更换视频或使用 App';
  if (remainingSeconds <= 0) return '体验额度已用完，可下载 App 继续翻译';
  if (currentDuration > 0 && Math.ceil(currentDuration) > remainingSeconds) {
    return '视频 ' + formatDuration(currentDuration) + '，超过剩余体验 ' + formatDuration(remainingSeconds) + '。请更换视频或用 App 翻译完整视频。';
  }
  return '';
}
function showLocalFileInfo() {
  if (!currentFile) return;
  byId('file-name').textContent = currentFile.name;
  byId('file-name').title = currentFile.name;
  byId('file-meta').textContent = (currentDuration > 0 ? formatDuration(currentDuration) + ' · ' : '') +
    (currentFile.size / (1024 * 1024)).toFixed(1) + ' MB · 本地预览';
}

const setStatus = (text, warning = false) => {
  byId('status-text').textContent = text;
  byId('status-dot').classList.toggle('warning', warning);
};
function updateWatermark() {
  const text = byId('watermark-text').value.trim();
  const mark = byId('preview-watermark');
  mark.textContent = text;
  mark.className = 'preview-watermark ' + byId('watermark-position').value;
  mark.style.opacity = byId('watermark-opacity').value;
  mark.hidden = !text || !currentFile;
}
function releaseVideo() {
  video.pause();
  video.removeAttribute('src');
  video.load();
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = null;
}
function restoreOriginalPreview() {
  if (!currentFile) return;
  video.pause();
  if (!videoUrl) videoUrl = URL.createObjectURL(currentFile);
  video.src = videoUrl;
  showLocalFileInfo();
  updateWatermark();
}
function importVideo(file) {
  if (!file || running) return;
  if (activeJob && !uploadNeedsFile) return setStatus('当前任务尚未结束，点击“继续查看任务”恢复连接',true);
  if (!/\.(mp4|mov|m4v|webm)$/i.test(file.name) || !file.size) {
    setStatus('请选择 MP4、MOV、M4V 或 WEBM 视频文件', true);
    return;
  }
  releaseVideo();
  if (!activeJob) clearResult();
  currentFile = file;
  currentDuration = 0;
  videoUrl = URL.createObjectURL(file);
  video.src = videoUrl;
  byId('choose-video').hidden = true;
  byId('video-surface').hidden = false;
  byId('replace-video').hidden = false;
  showLocalFileInfo();
  const restriction = activeJob ? '' : videoRestriction();
  setStatus(restriction || '正在读取本地视频…', !!restriction);
  setRunning(false);
  updateWatermark();
}
byId('settings-toggle').addEventListener('click', () => {
  const toggle = byId('settings-toggle');
  const expanded = toggle.getAttribute('aria-expanded') !== 'true';
  toggle.setAttribute('aria-expanded', String(expanded));
  byId('settings-panel').hidden = !expanded;
});
for (const id of ['watermark-text', 'watermark-position', 'watermark-opacity']) {
  byId(id).addEventListener(id === 'watermark-text' ? 'input' : 'change', updateWatermark);
}
byId('clear-watermark').addEventListener('click', () => {
  byId('watermark-text').value = '';
  updateWatermark();
});
for (const id of ['choose-video', 'replace-video']) {
  byId(id).addEventListener('click', () => fileInput.click());
}
fileInput.addEventListener('change', () => {
  importVideo(fileInput.files[0]);
  fileInput.value = '';
});
stage.addEventListener('dragover', (event) => {
  event.preventDefault();
  stage.classList.add('drag-over');
});
stage.addEventListener('dragleave', () => stage.classList.remove('drag-over'));
stage.addEventListener('drop', (event) => {
  event.preventDefault();
  stage.classList.remove('drag-over');
  const files = event.dataTransfer.files;
  if (files.length !== 1) return setStatus('请一次选择一个视频', true);
  importVideo(files[0]);
});
// Prevent accidental navigation when a video is dropped outside the preview.
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());
video.addEventListener('loadedmetadata', () => {
  if (running || resultUrl) return;
  if (!currentFile) return;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  currentDuration = duration;
  showLocalFileInfo();
  const restriction = activeJob ? '' : videoRestriction();
  setStatus(restriction || (uploadNeedsFile ? '已选择视频 · 点击继续上传' : '视频已就绪 · 点击一键翻译'), !!restriction);
  setRunning(false);
});
video.addEventListener('error', () => {
  if (resultUrl) setStatus('成片已生成，浏览器无法播放；可下载后打开', true);
  else if (currentFile && videoUrl && !running) {
    setStatus((activeJob ? '' : videoRestriction()) || '浏览器无法预览此编码，可尝试翻译或使用 App', true);
    setRunning(false);
  }
});
document.querySelectorAll('[data-download]').forEach((button) => {
  button.addEventListener('click', () => {
    video.pause();
    dialogOpener = button;
    if (!dialog.open) dialog.showModal();
  });
});
byId('close-download').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});
dialog.addEventListener('close', () => dialogOpener?.focus());
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) releaseVideo();
});
