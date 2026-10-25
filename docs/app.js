'use strict';
const byId = (id) => document.getElementById(id);
const fileInput = byId('video-file');
const video = byId('video-preview');
const stage = byId('preview-stage');
const dialog = byId('download-dialog');
let videoUrl = null;
let dialogOpener = null;
let currentFile = null;

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
function importVideo(file) {
  if (!file) return;
  if (!/\.(mp4|mov|m4v|webm)$/i.test(file.name) || !file.size) {
    setStatus('请选择 MP4、MOV、M4V 或 WEBM 视频文件', true);
    return;
  }
  releaseVideo();
  currentFile = file;
  videoUrl = URL.createObjectURL(file);
  video.src = videoUrl;
  byId('choose-video').hidden = true;
  byId('video-surface').hidden = false;
  byId('replace-video').hidden = false;
  byId('file-name').textContent = file.name;
  byId('file-name').title = file.name;
  byId('file-meta').textContent = (file.size / (1024 * 1024)).toFixed(1) + ' MB · 本地预览';
  setStatus('正在读取本地视频…');
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
  if (!currentFile) return;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const minutes = Math.floor(duration / 60);
  const seconds = String(Math.floor(duration % 60)).padStart(2, '0');
  const resolution = video.videoWidth + ' × ' + video.videoHeight;
  byId('file-meta').textContent = minutes + ':' + seconds + ' · ' + resolution;
  setStatus('视频已就绪 · 可播放预览');
});
video.addEventListener('error', () => {
  if (currentFile && videoUrl) setStatus('浏览器无法播放此编码，请更换视频或使用 App', true);
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
