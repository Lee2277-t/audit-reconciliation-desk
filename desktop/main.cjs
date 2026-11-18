const { app, BrowserWindow, Menu, dialog, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const entry = pathToFileURL(path.join(__dirname, 'app', 'index.html')).href;
let mainWindow;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    // 不使用持久化 partition，不保存浏览器会话和底稿。
    const localSession = session.fromPartition('audit-recon');
    localSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    localSession.setPermissionCheckHandler(() => false);
    localSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !/^(file|data|blob):/.test(details.url) });
    });
    const template = [
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '显示', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    function createWindow() {
      mainWindow = new BrowserWindow({
        width: 1280, height: 900, minWidth: 800, minHeight: 600,
        title: '审计双边对账工具', backgroundColor: '#f4f1e8', show: false,
        webPreferences: { session: localSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
      });
      mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url.split('#')[0] !== entry) event.preventDefault();
      });
      mainWindow.webContents.on('will-prevent-unload', event => {
        const answer = dialog.showMessageBoxSync(mainWindow, {
          type: 'question', buttons: ['留在这里', '关闭窗口'], defaultId: 0, cancelId: 0,
          title: '关闭对账工具', message: '当前表格和结果还在窗口里。', detail: '关闭后不会保留，请先导出要保存的底稿。'
        });
        if (answer === 1) event.preventDefault();
      });
      mainWindow.once('ready-to-show', () => mainWindow.show());
      mainWindow.loadURL(entry);
    }
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
