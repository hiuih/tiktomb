const { app, BrowserWindow, session, shell, Menu, screen, nativeImage } = require('electron');
const path = require('path');

const APP_NAME = 'TikTomb';
const ICON_PNG = path.join(__dirname, 'build-assets', 'icon-512.png');
const ICON_ICNS = path.join(__dirname, 'build-assets', 'icon.icns');

app.setName(APP_NAME);

const TIKTOK_URL = 'https://www.tiktok.com/foryou';
// Electron is genuinely Chromium; strip the "Electron/x.x.x" token so
// TikTok's UA sniffing recognizes it as a real Chrome build (otherwise it
// can redirect to an unsupported-browser page).
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// session/webContents-level UA overrides aren't reliably applied to a
// brand-new popup window's very first navigation — verified live against a
// real Google sign-in popup: its first request went out with Electron's
// actual default UA baked in ("Electron/x.x.x" and all), which is likely
// why fingerprint-sensitive sign-in flows (Apple ID especially) could behave
// inconsistently. app.userAgentFallback changes Electron's own baseline
// default before any renderer process spawns, fixing this at the root.
app.userAgentFallback = CHROME_UA;

const ALLOWED_HOSTS = [
  'tiktok.com',
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'ibytedtos.com',
  'accounts.google.com',
  'appleid.apple.com',
];

// Proactively resolves Notification.permission instead of waiting on
// TikTok's own banner click, then reloads once on the first real grant so
// TikTok's init code (which likely only subscribes to push inside its own
// "Enable" button's click handler) re-runs seeing "granted" from page load
// and actually completes the push subscription.
// TikTok's desktop web already lays out video + right-side action column +
// bottom-left caption almost identically to the real mobile app — the one
// thing breaking that illusion is the persistent 240px left sidebar (For
// You/Explore/Following/etc.) and top header, neither of which exist on
// mobile at all. Hiding just those two lets the video expand to fill the
// window edge-to-edge, matching the mobile experience closely. Verified live
// against the real DOM before shipping this, not guessed.
const MOBILE_STYLE_CSS = `
[class*="SideNav" i] { display: none !important; }
[class*="DivHeaderContainer" i] { display: none !important; }
`;

const NOTIF_PROBE_JS = `
(() => {
  if (!window.Notification) return;
  if (Notification.permission === 'granted') return;
  Notification.requestPermission().then((result) => {
    if (result === 'granted' && !window.__tiktokNotifReloaded) {
      window.__tiktokNotifReloaded = true;
      setTimeout(() => location.reload(), 50);
    }
  }).catch(() => {});
})();
`;

function isAllowedHost(hostname) {
  return ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h));
}

function buildWindowBounds() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const w = Math.min(1200, width - 100);
  const h = Math.min(800, height - 100);
  return {
    width: w,
    height: h,
    x: Math.round((width - w) / 2),
    y: Math.round((height - h) / 2),
  };
}

function attachNavigationGuards(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const hostname = new URL(url).hostname;
      if (isAllowedHost(hostname)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 480,
            height: 680,
            webPreferences: { session: win.webContents.session },
          },
        };
      }
    } catch (_) {}
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    try {
      const hostname = new URL(url).hostname;
      if (!isAllowedHost(hostname)) {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch (_) {}
  });
}

function createApp() {
  const bounds = buildWindowBounds();
  const tiktokSession = session.fromPartition('persist:tiktok-desktop');

  tiktokSession.setUserAgent(CHROME_UA);

  const allowedPermissions = ['media', 'mediaKeySystem', 'notifications', 'clipboard-read', 'fullscreen'];
  const isAllowedPermissionOrigin = (originOrUrl) => {
    try {
      return isAllowedHost(new URL(originOrUrl).hostname);
    } catch (_) {
      return false;
    }
  };
  tiktokSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = (details && details.requestingUrl) || webContents.getURL();
    callback(allowedPermissions.includes(permission) && isAllowedPermissionOrigin(origin));
  });
  // Request handler alone only covers active Notification.requestPermission()
  // calls; the check handler covers passive `Notification.permission` reads,
  // which is what TikTok's own "enable notifications" banner logic uses —
  // without this, the banner never goes away no matter what we grant above.
  tiktokSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return allowedPermissions.includes(permission) && isAllowedPermissionOrigin(requestingOrigin);
  });

  const splash = new BrowserWindow({
    ...bounds,
    show: true,
    resizable: false,
    backgroundColor: '#000000',
    webPreferences: { session: tiktokSession },
  });
  splash.loadFile('splash.html');

  // A real (non-overlay) title bar, deliberately not hiddenInset: TikTok's
  // own page controls its top-left/top-right UI and we can't guarantee it
  // never sits under custom-positioned traffic lights. A genuine title bar
  // reserves OS chrome space that page content physically cannot render into.
  const main = new BrowserWindow({
    ...bounds,
    show: false,
    minWidth: 480,
    minHeight: 480,
    title: APP_NAME,
    icon: ICON_PNG,
    backgroundColor: '#000000',
    webPreferences: {
      session: tiktokSession,
      contextIsolation: true,
      sandbox: true,
    },
  });

  attachNavigationGuards(main);

  // Chromium syncs the window title to the page's own <title> after every
  // load, overwriting our initial title. Leave it be except for branding.
  main.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    main.setTitle(title.replace(/TikTok/gi, APP_NAME));
  });

  const swapIn = () => {
    if (main.isVisible()) return;
    main.show();
    setTimeout(() => {
      if (!splash.isDestroyed()) splash.close();
    }, 120);
  };

  main.webContents.once('did-finish-load', () => {
    setTimeout(swapIn, 350); // let the splash breathe briefly so it doesn't just flash
  });
  main.webContents.once('did-fail-load', swapIn);

  main.webContents.on('dom-ready', () => {
    main.webContents.insertCSS(MOBILE_STYLE_CSS).catch(() => {});
  });
  main.webContents.on('did-finish-load', () => {
    main.webContents.executeJavaScript(NOTIF_PROBE_JS).catch(() => {});
  });

  // Keep push/service-worker timers responsive while backgrounded (menu bar
  // only) so incoming notifications aren't delayed.
  main.webContents.setBackgroundThrottling(false);

  main.webContents.setUserAgent(CHROME_UA);
  main.loadURL(TIKTOK_URL);

  return main;
}

function buildMenu(getMainWindow) {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => getMainWindow()?.webContents.reload(),
        },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(ICON_PNG));
  }

  let mainWindow = createApp();
  buildMenu(() => mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createApp();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
