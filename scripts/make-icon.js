const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    useContentSize: true,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: { offscreen: true },
  });
  win.loadFile(path.join(__dirname, '..', 'build-assets', 'icon-source.html'));
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      const image = await win.webContents.capturePage();
      const out = path.join(__dirname, '..', 'build-assets', 'icon-1024.png');
      fs.writeFileSync(out, image.toPNG());
      console.log('wrote', out, image.getSize());
      app.quit();
    }, 250);
  });
});
