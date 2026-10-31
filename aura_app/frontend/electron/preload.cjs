const { contextBridge, ipcRenderer } = require('electron');
const renderingMode = process.argv.find(arg => arg.startsWith('--aura-render-mode='))?.split('=')[1] || 'auto';
if (!['auto', 'hardware', 'software'].includes(renderingMode)) {
    throw new Error('Invalid AURA rendering mode');
}

contextBridge.exposeInMainWorld('electron', {
    renderingMode,
    setIgnoreMouseEvents: (ignore, options) => ipcRenderer.send('set-ignore-mouse-events', ignore, options),
});
