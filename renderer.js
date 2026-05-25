/**
 * Gengo — Renderer Process
 * Handles screen capture, OCR, and translation logic
 */

// ===== State =====
const state = {
  sourceId: null,         // Selected screen source ID
  mediaStream: null,      // Active media stream
  captureRegion: null,    // { x, y, width, height } relative to source
  isCapturing: false,     // Live capture running
  captureInterval: null,  // setInterval ID
  intervalMs: 3000,       // Capture interval in ms
  ocrReady: false,        // OCR worker initialized
  lastOcrText: '',        // Last OCR result (to avoid duplicate translations)
  isProcessing: false,    // Currently processing a capture
  history: [],             // Translation history (max 100)
  presets: [],             // Saved region presets
  historyVisible: true,    // History section expanded
};

// ===== DOM Elements =====
const $ = (id) => document.getElementById(id);

const els = {
  // Language
  sourceLang: $('sourceLang'),
  targetLang: $('targetLang'),
  // Boxes
  ocrContent: $('ocrContent'),
  translateContent: $('translateContent'),
  copyOcr: $('copyOcr'),
  copyTranslation: $('copyTranslation'),
  // Preview
  previewSection: $('previewSection'),
  previewCanvas: $('previewCanvas'),
  previewClose: $('previewClose'),
  // Controls
  selectRegionBtn: $('selectRegionBtn'),
  startBtn: $('startBtn'),
  stopBtn: $('stopBtn'),
  captureOnceBtn: $('captureOnceBtn'),
  toggleOverlayBtn: $('toggleOverlayBtn'),
  intervalSlider: $('intervalSlider'),
  intervalValue: $('intervalValue'),
  // Status
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  // Window controls
  pinBtn: $('pinBtn'),
  minimizeBtn: $('minimizeBtn'),
  maximizeBtn: $('maximizeBtn'),
  closeBtn: $('closeBtn'),
  // Region overlay
  regionOverlay: $('regionOverlay'),
  regionCanvas: $('regionCanvas'),
  regionCancel: $('regionCancel'),
  // Source modal
  sourceModal: $('sourceModal'),
  sourceList: $('sourceList'),
  modalClose: $('modalClose'),
  // History
  historyBody: $('historyBody'),
  historyCount: $('historyCount'),
  historyToggle: $('historyToggle'),
  historyClear: $('historyClear'),
  historyHeader: $('historyHeader'),
  // Presets
  presetSelect: $('presetSelect'),
  savePresetBtn: $('savePresetBtn'),
  deletePresetBtn: $('deletePresetBtn'),
};

// ===== Initialization =====
async function init() {
  setupWindowControls();
  setupEventListeners();
  loadHistoryFromStorage();
  loadPresetsFromStorage();
  renderHistory();
  populatePresetDropdown();
  updatePresetButtons();
  setStatus('ready', 'Initializing OCR engine...');
  await initOCR();
  setStatus('ready', 'Ready — Select a screen region to start');
}

// ===== OCR Setup =====
async function initOCR() {
  try {
    const sourceLangCode = els.sourceLang.value;

    setStatus('processing', `Loading OCR model for ${sourceLangCode}...`);

    // Set up progress callback
    window.electronAPI.onOCRProgress((pct) => {
      setStatus('processing', `OCR processing... ${pct}%`);
    });

    const initResult = await window.electronAPI.initOCR(sourceLangCode);
    if (!initResult.success) {
      throw new Error(initResult.error || 'Unknown OCR init error');
    }

    state.ocrReady = true;
    setStatus('ready', 'OCR ready — Select a screen region to start');
  } catch (err) {
    console.error('OCR init error:', err);
    setStatus('error', `OCR init failed: ${err.message}`);
  }
}

// Reinitialize OCR when source language changes
async function reinitOCR() {
  state.ocrReady = false;
  await initOCR();
}

// ===== Screen Capture =====
async function showSourcePicker() {
  setStatus('processing', 'Fetching screen sources...');
  try {
    const sources = await window.electronAPI.getSources();
    els.sourceList.innerHTML = '';

    sources.forEach((source) => {
      const card = document.createElement('div');
      card.className = 'source-card';
      card.innerHTML = `
        <img src="${source.thumbnail}" alt="${source.name}" />
        <span title="${source.name}">${source.name}</span>
      `;
      card.addEventListener('click', () => selectSource(source));
      els.sourceList.appendChild(card);
    });

    els.sourceModal.style.display = 'flex';
    setStatus('ready', 'Select a screen source');
  } catch (err) {
    console.error('Source fetch error:', err);
    setStatus('error', 'Failed to get screen sources');
  }
}

async function selectSource(source) {
  els.sourceModal.style.display = 'none';
  state.sourceId = source.id;

  try {
    // Stop previous stream
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach((t) => t.stop());
    }

    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: source.id,
          minWidth: 1280,
          minHeight: 720,
          maxWidth: 3840,
          maxHeight: 2160,
        },
      },
    });

    setStatus('ready', `Source: ${source.name} — Now draw a capture region`);
    showRegionSelector();
  } catch (err) {
    console.error('Media stream error:', err);
    setStatus('error', 'Failed to capture screen');
  }
}

// ===== Region Selection =====
function showRegionSelector() {
  const overlay = els.regionOverlay;
  const canvas = els.regionCanvas;
  const ctx = canvas.getContext('2d');

  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  overlay.style.display = 'block';

  let startX, startY, isDrawing = false;

  // Draw the current frame to help user see
  drawStreamFrame(ctx, canvas.width, canvas.height);

  function onMouseDown(e) {
    isDrawing = true;
    startX = e.clientX;
    startY = e.clientY;
  }

  function onMouseMove(e) {
    if (!isDrawing) return;

    // Redraw frame
    drawStreamFrame(ctx, canvas.width, canvas.height);

    // Draw selection rectangle
    const w = e.clientX - startX;
    const h = e.clientY - startY;

    ctx.strokeStyle = '#6c5ce7';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(startX, startY, w, h);
    ctx.setLineDash([]);

    // Dim area outside selection
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    // Top
    ctx.fillRect(0, 0, canvas.width, startY);
    // Bottom
    ctx.fillRect(0, startY + h, canvas.width, canvas.height - startY - h);
    // Left
    ctx.fillRect(0, startY, startX, h);
    // Right
    ctx.fillRect(startX + w, startY, canvas.width - startX - w, h);
  }

  function onMouseUp(e) {
    if (!isDrawing) return;
    isDrawing = false;

    const rect = {
      x: Math.min(startX, e.clientX),
      y: Math.min(startY, e.clientY),
      width: Math.abs(e.clientX - startX),
      height: Math.abs(e.clientY - startY),
    };

    if (rect.width < 20 || rect.height < 20) {
      setStatus('error', 'Region too small. Please draw a larger area.');
      return;
    }

    // Convert screen coordinates to video coordinates
    const video = document.createElement('video');
    video.srcObject = state.mediaStream;
    video.play();

    video.onloadedmetadata = () => {
      const scaleX = video.videoWidth / canvas.width;
      const scaleY = video.videoHeight / canvas.height;

      state.captureRegion = {
        x: Math.round(rect.x * scaleX),
        y: Math.round(rect.y * scaleY),
        width: Math.round(rect.width * scaleX),
        height: Math.round(rect.height * scaleY),
      };

      video.pause();
      video.srcObject = null;

      cleanup();
      enableCaptureButtons();
      setStatus('ready', `Region selected (${state.captureRegion.width}×${state.captureRegion.height}) — Ready to capture`);
    };

    // Fallback: if metadata already loaded
    if (video.readyState >= 1) {
      const scaleX = video.videoWidth / canvas.width;
      const scaleY = video.videoHeight / canvas.height;

      state.captureRegion = {
        x: Math.round(rect.x * scaleX),
        y: Math.round(rect.y * scaleY),
        width: Math.round(rect.width * scaleX),
        height: Math.round(rect.height * scaleY),
      };

      video.pause();
      video.srcObject = null;

      cleanup();
      enableCaptureButtons();
      setStatus('ready', `Region selected (${state.captureRegion.width}×${state.captureRegion.height}) — Ready to capture`);
    }
  }

  function cleanup() {
    overlay.style.display = 'none';
    canvas.removeEventListener('mousedown', onMouseDown);
    canvas.removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('mouseup', onMouseUp);
  }

  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);

  // ESC to cancel
  function onKeyDown(e) {
    if (e.key === 'Escape') {
      cleanup();
      document.removeEventListener('keydown', onKeyDown);
      setStatus('ready', 'Region selection cancelled');
    }
  }
  document.addEventListener('keydown', onKeyDown);

  els.regionCancel.onclick = () => {
    cleanup();
    document.removeEventListener('keydown', onKeyDown);
    setStatus('ready', 'Region selection cancelled');
  };
}

function drawStreamFrame(ctx, w, h) {
  if (!state.mediaStream) return;
  const video = document.createElement('video');
  video.srcObject = state.mediaStream;
  video.play();

  // Draw when ready
  video.onloadeddata = () => {
    ctx.drawImage(video, 0, 0, w, h);
    video.pause();
    video.srcObject = null;
  };
}

// ===== Capture & Process =====
async function captureAndProcess() {
  if (state.isProcessing || !state.mediaStream || !state.captureRegion || !state.ocrReady) return;

  state.isProcessing = true;
  setStatus('processing', 'Capturing screen...');

  try {
    // Capture frame from stream
    const video = document.createElement('video');
    video.srcObject = state.mediaStream;
    await video.play();

    // Wait for video to have data
    await new Promise((resolve) => {
      if (video.readyState >= 2) return resolve();
      video.onloadeddata = resolve;
    });

    // Draw full frame
    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = video.videoWidth;
    fullCanvas.height = video.videoHeight;
    const fullCtx = fullCanvas.getContext('2d');
    fullCtx.drawImage(video, 0, 0);

    video.pause();
    video.srcObject = null;

    // Crop to region
    const region = state.captureRegion;
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = region.width;
    cropCanvas.height = region.height;
    const cropCtx = cropCanvas.getContext('2d');
    cropCtx.drawImage(
      fullCanvas,
      region.x, region.y, region.width, region.height,
      0, 0, region.width, region.height
    );

    // Show preview
    showPreview(cropCanvas);

    // Run OCR
    setStatus('processing', 'Running OCR...');
    const imageData = cropCanvas.toDataURL('image/png');
    const result = await window.electronAPI.recognizeImage(imageData);
    if (!result.success) throw new Error(result.error || 'Unknown OCR recognize error');
    const text = result.text.trim();

    if (text) {
      setOcrText(text);

      // Only translate if text changed
      if (text !== state.lastOcrText) {
        state.lastOcrText = text;
        setStatus('processing', 'Processing translation...');
        await translateText(text);
      } else {
        setStatus(state.isCapturing ? 'running' : 'ready',
          state.isCapturing ? `Analyzing Screen Region — Status: Text Detected. Processing translation... (${state.intervalMs/1000}s Interval)` : 'Text unchanged — skipping translation');
      }
    } else {
      setOcrText('(No text detected)');
      setStatus(state.isCapturing ? 'running' : 'ready', 'No text detected in capture region');
    }
  } catch (err) {
    console.error('Capture error:', err);
    setStatus('error', `Capture failed: ${err.message}`);
  } finally {
    state.isProcessing = false;
  }
}

function showPreview(canvas) {
  const previewCtx = els.previewCanvas.getContext('2d');
  els.previewCanvas.width = canvas.width;
  els.previewCanvas.height = canvas.height;
  previewCtx.drawImage(canvas, 0, 0);
  els.previewSection.style.display = 'block';
}

// ===== Translation =====
async function translateText(text) {
  const sourceLangOption = els.sourceLang.selectedOptions[0];
  const sourceLangCode = els.sourceLang.value;
  const translateCode = sourceLangOption.getAttribute('data-translate');
  const targetCode = els.targetLang.value;

  try {
    setStatus('processing', 'Translating text...');
    const result = await window.electronAPI.translateText(text, translateCode, targetCode);

    if (result.success) {
      const translated = result.text;
      setTranslatedText(translated);
      window.electronAPI.updateOverlayText(translated);
      addToHistory(text, translated, sourceLangCode, targetCode);
      setStatus(state.isCapturing ? 'running' : 'ready',
        state.isCapturing ? `Analyzing Screen Region — Status: Text Detected. Processing translation... (${state.intervalMs/1000}s Interval)` : 'Translation complete');
    } else {
      setTranslatedText(`(Translation error: ${result.error})`);
      window.electronAPI.updateOverlayText(`Error: ${result.error}`);
      setStatus('error', `Translation API error: ${result.error}`);
    }
  } catch (err) {
    console.error('Translation error:', err);
    setTranslatedText(`(Translation failed: ${err.message})`);
    window.electronAPI.updateOverlayText(`Failed: ${err.message}`);
    setStatus('error', 'Translation request failed');
  }
}

// ===== Translation History =====
function addToHistory(original, translated, source, target) {
  const entry = {
    timestamp: Date.now(),
    source,
    target,
    original,
    translated,
  };
  state.history.unshift(entry);
  if (state.history.length > 100) state.history = state.history.slice(0, 100);
  saveHistoryToStorage();
  renderHistory();
}

function saveHistoryToStorage() {
  try {
    localStorage.setItem('gengo_history', JSON.stringify(state.history));
  } catch (e) { /* storage full */ }
}

function loadHistoryFromStorage() {
  try {
    const saved = localStorage.getItem('gengo_history');
    if (saved) state.history = JSON.parse(saved);
  } catch (e) { state.history = []; }
}

function renderHistory() {
  els.historyCount.textContent = state.history.length;
  if (state.history.length === 0) {
    els.historyBody.innerHTML = '<p class="history-empty">No translation history yet...</p>';
    els.historyClear.style.display = 'none';
    return;
  }
  els.historyClear.style.display = '';
  els.historyBody.innerHTML = state.history.map((entry, i) => {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const sourceFlag = getLangFlag(entry.source);
    const targetFlag = getLangFlag(entry.target);
    return `
      <div class="history-entry">
        <div class="history-entry-time">${time}</div>
        <div class="history-entry-langs">${sourceFlag} ${entry.source} → ${targetFlag} ${entry.target}</div>
        <div class="history-entry-original">${escapeHtml(entry.original)}</div>
        <div class="history-entry-translated">${escapeHtml(entry.translated)}</div>
      </div>
    `;
  }).join('');
}

function getLangFlag(code) {
  const flags = {
    jpn: '🇯🇵', eng: '🇬🇧', chi_sim: '🇨🇳', chi_tra: '🇹🇼', kor: '🇰🇷',
    id: '🇮🇩', en: '🇬🇧', ja: '🇯🇵', ko: '🇰🇷', 'zh-CN': '🇨🇳', 'zh-TW': '🇹🇼',
  };
  return flags[code] || '🌐';
}

function clearHistory() {
  state.history = [];
  localStorage.removeItem('gengo_history');
  renderHistory();
}

function toggleHistory() {
  state.historyVisible = !state.historyVisible;
  els.historyBody.classList.toggle('hidden', !state.historyVisible);
  els.historyToggle.textContent = state.historyVisible ? '▼' : '▶';
}

// ===== Region Presets =====
function loadPresetsFromStorage() {
  try {
    const saved = localStorage.getItem('gengo_presets');
    if (saved) state.presets = JSON.parse(saved);
  } catch (e) { state.presets = []; }
}

function savePresetsToStorage() {
  localStorage.setItem('gengo_presets', JSON.stringify(state.presets));
}

function populatePresetDropdown() {
  els.presetSelect.innerHTML = '<option value="">-- No preset --</option>';
  state.presets.forEach((preset, i) => {
    const option = document.createElement('option');
    option.value = i;
    option.textContent = preset.name;
    els.presetSelect.appendChild(option);
  });
  updatePresetButtons();
}

function savePreset() {
  if (!state.captureRegion) return;
  const name = prompt('Enter a name for this region preset:', `Region ${state.presets.length + 1}`);
  if (!name || !name.trim()) return false;
  state.presets.push({
    name: name.trim(),
    x: state.captureRegion.x,
    y: state.captureRegion.y,
    width: state.captureRegion.width,
    height: state.captureRegion.height,
  });
  savePresetsToStorage();
  populatePresetDropdown();
  els.presetSelect.value = state.presets.length - 1;
  updatePresetButtons();
  setStatus('ready', `Region preset "${name}" saved`);
  return true;
}

function loadPreset(index) {
  const preset = state.presets[index];
  if (!preset) return;
  state.captureRegion = {
    x: preset.x,
    y: preset.y,
    width: preset.width,
    height: preset.height,
  };
  enableCaptureButtons();
  setStatus('ready', `Preset "${preset.name}" loaded — Ready to capture`);
}

function deletePreset() {
  const index = parseInt(els.presetSelect.value);
  if (isNaN(index) || !state.presets[index]) return;
  const name = state.presets[index].name;
  state.presets.splice(index, 1);
  savePresetsToStorage();
  populatePresetDropdown();
  els.presetSelect.value = '';
  setStatus('ready', `Preset "${name}" deleted`);
}

function updatePresetButtons() {
  els.savePresetBtn.disabled = !state.captureRegion;
  els.deletePresetBtn.disabled = els.presetSelect.value === '';
}

// ===== Live Capture =====
function startLiveCapture() {
  if (!state.captureRegion || !state.ocrReady) return;

  state.isCapturing = true;
  els.startBtn.disabled = true;
  els.startBtn.classList.add('running');
  els.stopBtn.disabled = false;
  els.selectRegionBtn.disabled = true;

  setStatus('running', 'Live capture started');

  // Capture immediately, then on interval
  captureAndProcess();
  state.captureInterval = setInterval(() => {
    if (!state.isProcessing) captureAndProcess();
  }, state.intervalMs);
}

function stopLiveCapture() {
  state.isCapturing = false;

  if (state.captureInterval) {
    clearInterval(state.captureInterval);
    state.captureInterval = null;
  }

  els.startBtn.disabled = false;
  els.startBtn.classList.remove('running');
  els.stopBtn.disabled = true;
  els.selectRegionBtn.disabled = false;

  setStatus('ready', 'Live capture stopped');
}

// ===== UI Helpers =====
function setOcrText(text) {
  els.ocrContent.innerHTML = `<p class="extracted-text">${escapeHtml(text)}</p>`;
}

function setTranslatedText(text) {
  els.translateContent.innerHTML = `<p class="extracted-text">${escapeHtml(text)}</p>`;
}

function setStatus(type, message) {
  els.statusDot.className = `status-dot ${type}`;
  els.statusText.textContent = message;
}

function enableCaptureButtons() {
  els.startBtn.disabled = false;
  els.captureOnceBtn.disabled = false;
  updatePresetButtons();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  } catch (err) {
    console.error('Copy failed:', err);
  }
}

// ===== Event Listeners =====
function setupEventListeners() {
  // Select Region (opens source picker first)
  els.selectRegionBtn.addEventListener('click', showSourcePicker);

  // Start / Stop
  els.startBtn.addEventListener('click', startLiveCapture);
  els.stopBtn.addEventListener('click', stopLiveCapture);

  // Capture Once
  els.captureOnceBtn.addEventListener('click', () => {
    if (!state.isProcessing) captureAndProcess();
  });

  // Toggle Overlay
  els.toggleOverlayBtn.addEventListener('click', () => {
    window.electronAPI.toggleOverlay();
  });

  // Interval slider
  els.intervalSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    state.intervalMs = val * 1000;
    els.intervalValue.textContent = `${val}s`;

    // Update interval if running
    if (state.isCapturing) {
      clearInterval(state.captureInterval);
      state.captureInterval = setInterval(() => {
        if (!state.isProcessing) captureAndProcess();
      }, state.intervalMs);
    }
  });

  // Language change → reinit OCR
  els.sourceLang.addEventListener('change', async () => {
    const wasCapturing = state.isCapturing;
    if (wasCapturing) stopLiveCapture();
    await reinitOCR();
    if (wasCapturing) startLiveCapture();
  });

  // Copy buttons
  els.copyOcr.addEventListener('click', () => {
    const text = els.ocrContent.querySelector('.extracted-text');
    if (text) copyToClipboard(text.textContent, els.copyOcr);
  });

  els.copyTranslation.addEventListener('click', () => {
    const text = els.translateContent.querySelector('.extracted-text');
    if (text) copyToClipboard(text.textContent, els.copyTranslation);
  });

  // Preview close
  els.previewClose.addEventListener('click', () => {
    els.previewSection.style.display = 'none';
  });

  // History toggle
  els.historyHeader.addEventListener('click', (e) => {
    if (e.target === els.historyClear) return;
    toggleHistory();
  });

  // History clear
  els.historyClear.addEventListener('click', (e) => {
    e.stopPropagation();
    clearHistory();
  });

  // Preset select
  els.presetSelect.addEventListener('change', () => {
    const index = parseInt(els.presetSelect.value);
    if (!isNaN(index) && state.presets[index]) {
      loadPreset(index);
    }
    updatePresetButtons();
  });

  // Save preset
  els.savePresetBtn.addEventListener('click', () => {
    savePreset();
  });

  // Delete preset
  els.deletePresetBtn.addEventListener('click', () => {
    deletePreset();
  });

  // Modal close
  els.modalClose.addEventListener('click', () => {
    els.sourceModal.style.display = 'none';
    setStatus('ready', 'Source selection cancelled');
  });

  // Close modal on backdrop click
  els.sourceModal.addEventListener('click', (e) => {
    if (e.target === els.sourceModal) {
      els.sourceModal.style.display = 'none';
      setStatus('ready', 'Source selection cancelled');
    }
  });

}

// ===== Window Controls =====
function setupWindowControls() {
  let isPinned = true;

  els.pinBtn.addEventListener('click', () => {
    isPinned = !isPinned;
    els.pinBtn.classList.toggle('active', isPinned);
    window.electronAPI.setAlwaysOnTop(isPinned);
  });

  els.minimizeBtn.addEventListener('click', () => window.electronAPI.minimizeWindow());
  els.maximizeBtn.addEventListener('click', () => window.electronAPI.maximizeWindow());
  els.closeBtn.addEventListener('click', async () => {
    // Cleanup before close
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach((t) => t.stop());
    }
    await window.electronAPI.terminateOCR();
    window.electronAPI.closeWindow();
  });
}

// ===== Start =====
document.addEventListener('DOMContentLoaded', init);
