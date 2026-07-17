// Sala dos Agentes — wrapper Electron (app instalável).
// Reaproveita o server.mjs (fonte única): sobe o servidor local embutido e
// abre uma janela apontando pra ele. Zero token de API — só lê os logs.
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || '4599';
process.env.PORT = PORT;

// server.mjs lê process.argv[2] como sessão fixa; no Electron o argv traz o
// caminho do app ("."), então limpamos pra não confundir a auto-detecção.
process.argv.length = 2;

function serverPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'server.mjs')
    : path.join(HERE, '..', 'server.mjs');
}

// Espera o servidor responder antes de carregar a janela.
function waitForServer(url, tries = 40) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = http.get(url, () => resolve());
      req.on('error', () => {
        if (n <= 0) reject(new Error('servidor não subiu'));
        else setTimeout(() => attempt(n - 1), 150);
      });
      req.setTimeout(1000, () => req.destroy());
    };
    attempt(tries);
  });
}

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 720,
    minHeight: 560,
    title: 'Sala dos Agentes',
    autoHideMenuBar: true,
    backgroundColor: '#0b0d12',
    webPreferences: { contextIsolation: true },
  });
  win.loadURL('http://localhost:' + PORT);
}

app.whenReady().then(async () => {
  try {
    await import(pathToFileURL(serverPath()).href); // sobe o servidor embutido
    await waitForServer('http://localhost:' + PORT + '/state');
  } catch (e) {
    console.error('Falha ao iniciar o servidor local:', e);
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
