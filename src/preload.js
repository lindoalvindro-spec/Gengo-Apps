const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Screen capture
  getSources: () => ipcRenderer.invoke('get-sources'),

  // Window controls
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  setAlwaysOnTop: (value) => ipcRenderer.send('set-always-on-top', value),

  // OCR (runs in main process)
  initOCR: (langCode) => ipcRenderer.invoke('ocr-init', langCode),
  recognizeImage: (imageDataURL) => ipcRenderer.invoke('ocr-recognize', imageDataURL),
  terminateOCR: () => ipcRenderer.invoke('ocr-terminate'),
  translateText: (text, source, target) => ipcRenderer.invoke('ocr-translate', { text, source, target }),

  // OCR progress events from main process
  onOCRProgress: (callback) => {
    ipcRenderer.on('ocr-progress', (event, pct) => callback(pct));
  },

  // Overlay controls
  toggleOverlay: () => ipcRenderer.send('toggle-overlay'),
  updateOverlayText: (text) => ipcRenderer.send('update-overlay-text', text),
  onUpdateOverlayText: (callback) => {
    ipcRenderer.on('set-overlay-text', (event, text) => callback(text));
  },
});
