const { app, BrowserWindow, desktopCapturer, ipcMain, screen } = require('electron');
const path = require('path');
const Tesseract = require('tesseract.js');

let mainWindow;
let overlayWindow = null;
let ocrWorker = null;

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 800,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    x: Math.max(0, screenWidth - 820),
    y: 20,
    alwaysOnTop: true,
    frame: false,
    transparent: false,
    backgroundColor: '#071a0e',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.setAlwaysOnTop(true, 'screen-saver');

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function createOverlayWindow() {
  if (overlayWindow) {
    if (overlayWindow.isVisible()) {
      overlayWindow.hide();
    } else {
      overlayWindow.show();
    }
    return;
  }

  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  overlayWindow = new BrowserWindow({
    width: 600,
    height: 150,
    x: Math.max(0, screenWidth / 2 - 300),
    y: screenHeight - 200,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.loadFile('overlay.html');
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

// ===== Screen Capture =====
ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 1920, height: 1080 },
  });
  return sources.map(source => ({
    id: source.id,
    name: source.name,
    thumbnail: source.thumbnail.toDataURL(),
  }));
});

// ===== OCR (runs in main process — full Node.js support) =====
ipcMain.handle('ocr-init', async (event, langCode) => {
  try {
    if (ocrWorker) {
      await ocrWorker.terminate().catch(() => {});
      ocrWorker = null;
    }

    const traineddataPath = app.isPackaged
      ? path.join(process.resourcesPath, 'traineddata')
      : __dirname;

    ocrWorker = await Tesseract.createWorker(langCode, 1, {
      cachePath: traineddataPath,
      logger: (m) => {
        if (m.status === 'recognizing text') {
          const pct = Math.round(m.progress * 100);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ocr-progress', pct);
          }
        }
      },
    });

    return { success: true };
  } catch (err) {
    console.error('OCR init error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('ocr-recognize', async (event, imageDataURL) => {
  if (!ocrWorker) {
    return { success: false, error: 'OCR worker not initialized' };
  }
  try {
    const result = await ocrWorker.recognize(imageDataURL);
    return { success: true, text: result.data.text };
  } catch (err) {
    console.error('OCR recognize error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('ocr-terminate', async () => {
  if (ocrWorker) {
    await ocrWorker.terminate().catch(() => {});
    ocrWorker = null;
  }
  return { success: true };
});

ipcMain.handle('ocr-translate', async (event, { text, source, target }) => {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data && data[0]) {
      const translated = data[0].map(segment => segment[0]).join('');
      return { success: true, text: translated };
    }

    return { success: false, error: 'Unexpected Google Translate response' };
  } catch (err) {
    console.error('Translation error:', err);
    return { success: false, error: err.message };
  }
});

// ===== Window Controls =====
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', async () => {
  if (ocrWorker) await ocrWorker.terminate().catch(() => {});
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
  mainWindow?.close();
});
ipcMain.on('set-always-on-top', (event, value) => {
  mainWindow?.setAlwaysOnTop(value, 'screen-saver');
});

// ===== Overlay Controls =====
ipcMain.on('toggle-overlay', () => {
  createOverlayWindow();
});

ipcMain.on('update-overlay-text', (event, text) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('set-overlay-text', text);
  }
});

// ===== App Lifecycle =====
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (ocrWorker) ocrWorker.terminate().catch(() => {});
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
