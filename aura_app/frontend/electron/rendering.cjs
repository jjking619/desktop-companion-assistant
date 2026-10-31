function configureRendering(app, {
    platform = process.platform,
    arch = process.arch,
    override = process.env.AURA_SOFTWARE_RENDERING,
} = {}) {
    if (override !== undefined && override !== '' && override !== '0' && override !== '1') {
        throw new Error('AURA_SOFTWARE_RENDERING must be 0 (hardware), 1 (software), or unset (auto)');
    }
    const software = override === '1';
    if (software) {
        app.disableHardwareAcceleration();
        app.commandLine.appendSwitch('use-gl', 'angle');
        app.commandLine.appendSwitch('use-angle', 'swiftshader');
        app.commandLine.appendSwitch('enable-unsafe-swiftshader');
        return 'software';
    }
    const hardware = override === '0' || (!override && platform === 'linux' && arch === 'arm64');
    if (hardware) {
        app.commandLine.appendSwitch('use-gl', 'angle');
        app.commandLine.appendSwitch('use-angle', 'gles');
        if (platform === 'linux' && arch === 'arm64') {
            // Keep VRM WebGL on the GPU without the previously failing RasterCHROMIUM UI path.
            app.commandLine.appendSwitch('disable-gpu-rasterization');
        }
        return 'hardware';
    }
    return 'auto';
}

module.exports = { configureRendering };
