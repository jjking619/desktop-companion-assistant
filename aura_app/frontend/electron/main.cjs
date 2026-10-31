const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { configureRendering } = require('./rendering.cjs');

let mainWindow;
let gpuProcessCrashes = 0;

const renderingMode = configureRendering(app);
console.log(`[AURA graphics] startup=${new Date().toISOString()} electron=${app.getVersion()} platform=${process.platform} arch=${process.arch} system=${process.getSystemVersion()} backend=${renderingMode} override=${process.env.AURA_SOFTWARE_RENDERING || 'unset'}`);
console.log(`[AURA graphics] angle=${app.commandLine.getSwitchValue('use-angle') || 'auto'} gpuRasterization=${app.commandLine.hasSwitch('disable-gpu-rasterization') ? 'disabled' : 'auto'}`);
app.once('ready', async () => {
    console.log(`[AURA graphics] feature-status=${JSON.stringify(app.getGPUFeatureStatus())}`);
    try {
        console.log(`[AURA graphics] gpu-info=${JSON.stringify(await app.getGPUInfo('complete'))}`);
    } catch (error) {
        console.error(`[AURA graphics] GPU info unavailable: ${error instanceof Error ? error.stack : String(error)}`);
    }
});
app.on('child-process-gone', (_event, details) => {
    if (details.type === 'GPU') {
        gpuProcessCrashes += 1;
        const windowState = mainWindow && !mainWindow.isDestroyed() ? {
            id: mainWindow.id,
            webContentsId: mainWindow.webContents.id,
            url: mainWindow.webContents.getURL(),
            loading: mainWindow.webContents.isLoading(),
        } : null;
        console.error(`[AURA graphics] GPU process gone=${new Date().toISOString()} crashCount=${gpuProcessCrashes} details=${JSON.stringify(details)} backend=${renderingMode} features=${JSON.stringify(app.getGPUFeatureStatus())} window=${JSON.stringify(windowState)}. No software-rendering fallback is applied.`);
    }
});

function createWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const iconPath = path.join(__dirname, '../public/aura_icon.ico');

    mainWindow = new BrowserWindow({
        width: width,
        height: height,
        x: 0,
        y: 0,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        hasShadow: false,
        skipTaskbar: false,
        icon: fs.existsSync(iconPath) ? iconPath : undefined,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
            additionalArguments: [`--aura-render-mode=${renderingMode}`],
        },
    });
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        console.error(`[AURA graphics] Renderer process gone=${new Date().toISOString()} details=${JSON.stringify(details)} backend=${renderingMode} url=${mainWindow?.webContents.getURL() || 'unavailable'}. Restart Desktop Companion Assistant to reload the interface.`);
    });

    const distPath = path.join(__dirname, '../dist/index.html');

    if (process.env.ELECTRON_START_URL) {
        mainWindow.loadURL(process.env.ELECTRON_START_URL);
    } else if (fs.existsSync(distPath)) {
        // Fast instant local static file loading
        mainWindow.loadFile(distPath);
    } else {
        mainWindow.loadURL('http://localhost:5173');
    }

    mainWindow.setIgnoreMouseEvents(process.platform !== 'linux', { forward: true });

    let hitTestTimer;
    if (process.platform === 'linux') {
        // Visible regions include the entire viewport in global scene mode.
        mainWindow.setShape([{ x: 0, y: 0, width: 1, height: 1 }]);
        let checking = false;
        hitTestTimer = setInterval(async () => {
            if (checking || !mainWindow || mainWindow.webContents.isLoading()) return;
            checking = true;
            try {
                const regions = await mainWindow.webContents.executeJavaScript(`
                    [...document.querySelectorAll('[data-aura-interactive], [data-aura-visible]')].map(element => {
                        const rect = element.getBoundingClientRect();
                        return {
                            x: Math.max(0, Math.floor(rect.left) - 12),
                            y: Math.max(0, Math.floor(rect.top) - 12),
                            width: Math.ceil(rect.width) + 24,
                            height: Math.ceil(rect.height) + 24
                        };
                    }).filter(rect => rect.width > 24 && rect.height > 24)
                `);
                if (mainWindow && regions.length > 0) {
                    mainWindow.setShape(regions);
                }
            } catch (error) {
                console.error('[AURA] Updating native input regions failed:', error);
            } finally {
                checking = false;
            }
        }, 100);
    }

    if (process.platform === 'darwin') {
        // 'screen-saver' is the only level that stays above full-screen apps on macOS
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
        mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
        if (process.platform === 'linux') return;
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            win.setIgnoreMouseEvents(ignore, options);
        }
    });

    mainWindow.on('closed', function () {
        clearInterval(hitTestTimer);
        mainWindow = null;
    });
}

app.on('ready', createWindow);

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', function () {
    if (mainWindow === null) {
        createWindow();
    }
});
