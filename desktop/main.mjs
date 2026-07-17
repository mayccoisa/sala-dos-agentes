// Sala dos Agentes — wrapper Electron (app instalável).
// Reaproveita o server.mjs (fonte única): sobe o servidor local embutido e
// abre uma janela apontando pra ele. Zero token de API — só lê os logs.
import { app, BrowserWindow, dialog, Notification } from 'electron';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
// electron-updater é CommonJS: importa o módulo e desestrutura o autoUpdater.
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;

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

// ---- Auto-update (GitHub Releases via electron-updater) -------------------
// Fluxo: ao abrir, checa o repo público mayccoisa/sala-dos-agentes. Se houver
// versão nova, avisa o usuário, baixa em segundo plano e, ao terminar, oferece
// reiniciar para instalar. Zero interação obrigatória — quem não quiser, adia.
function setupAutoUpdate() {
  // Só faz sentido no app empacotado (no `electron .` de dev não há release).
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;          // baixa assim que encontra
  autoUpdater.autoInstallOnAppQuit = true;  // se adiar, instala ao fechar

  const notify = (title, body) => {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  };

  autoUpdater.on('update-available', (info) => {
    notify('Sala dos Agentes', 'Nova versão ' + info.version + ' disponível — baixando…');
  });

  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Reiniciar agora', 'Depois'],
      defaultId: 0,
      cancelId: 1,
      title: 'Atualização pronta',
      message: 'A versão ' + info.version + ' foi baixada.',
      detail: 'Reinicie para aplicar a atualização. Se preferir, ela será instalada ao fechar o app.',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  // Falha de update nunca deve incomodar o usuário (app é não-assinado, offline etc.).
  autoUpdater.on('error', (err) => {
    console.error('Auto-update falhou (ignorado):', err == null ? 'desconhecido' : err.message);
  });

  autoUpdater.checkForUpdates().catch((e) => {
    console.error('Não foi possível checar atualizações:', e && e.message);
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
  setupAutoUpdate();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
