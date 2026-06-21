const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const COLUMN_COUNT = 8;
const MAX_CHILDREN_PER_DIR = 2000;
const UPDATE_INTERVAL_MS = 160;
let activeScanId = 0;

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#f7f7f3',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('scan:start', async (event) => {
  const scanId = ++activeScanId;
  const drives = await listDrives();
  const totalCapacity = drives.reduce((sum, drive) => sum + drive.capacity, 0);
  const minSize = Math.max(1, totalCapacity / 1000);

  const tree = {
    columns: COLUMN_COUNT,
    minSize,
    totalCapacity,
    roots: drives.map((drive) => ({
      id: drive.path,
      name: drive.name,
      path: drive.path,
      type: 'drive',
      size: drive.used,
      capacity: drive.capacity,
      children: []
    })),
    scan: {
      status: 'running',
      visited: 0,
      visible: drives.length,
      message: 'Drives loaded'
    }
  };

  const progress = {
    visited: 0,
    visible: drives.length,
    lastSent: 0
  };
  const sendUpdate = (message, force = false) => {
    if (scanId !== activeScanId) return;
    const now = Date.now();
    if (!force && now - progress.lastSent < UPDATE_INTERVAL_MS) return;

    progress.lastSent = now;
    tree.scan = {
      status: 'running',
      visited: progress.visited,
      visible: progress.visible,
      message
    };
    event.sender.send('scan:update', tree);
  };

  sendUpdate('Drives loaded', true);

  for (const root of tree.roots) {
    if (scanId !== activeScanId) break;
    await scanChildren(root, 1, minSize, scanId, progress, sendUpdate);
    sendUpdate(`Finished ${root.name}`, true);
  }

  tree.scan = {
    status: scanId === activeScanId ? 'done' : 'cancelled',
    visited: progress.visited,
    visible: progress.visible,
    message: scanId === activeScanId ? 'Done' : 'Cancelled'
  };
  event.sender.send('scan:update', tree);
  return tree;
});

async function listDrives() {
  if (process.platform === 'win32') {
    return listWindowsDrives();
  }

  const root = path.parse(os.homedir()).root || '/';
  const stats = await fs.promises.statfs(root);
  return [{
    name: root,
    path: root,
    capacity: stats.blocks * stats.bsize,
    used: (stats.blocks - stats.bfree) * stats.bsize
  }];
}

function listWindowsDrives() {
  return new Promise((resolve) => {
    execFile('wmic', ['logicaldisk', 'get', 'Caption,FreeSpace,Size,DriveType', '/format:csv'], { windowsHide: true }, (error, stdout) => {
      if (!error && stdout.trim()) {
        const drives = parseWmicDrives(stdout);
        if (drives.length > 0) return resolve(drives);
      }

      execFile('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,FreeSpace,Size | ConvertTo-Json'
      ], { windowsHide: true }, (_psError, psStdout) => {
        resolve(parsePowerShellDrives(psStdout));
      });
    });
  });
}

function parseWmicDrives(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(1)
    .map((line) => line.split(','))
    .filter((parts) => parts.length >= 5)
    .map((parts) => {
      const caption = parts[1];
      const driveType = Number(parts[2]);
      const free = Number(parts[3]) || 0;
      const size = Number(parts[4]) || 0;
      return driveFromParts(caption, driveType, free, size);
    })
    .filter(Boolean);
}

function parsePowerShellDrives(stdout) {
  try {
    const parsed = JSON.parse(stdout || '[]');
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((row) => driveFromParts(row.DeviceID, Number(row.DriveType), Number(row.FreeSpace) || 0, Number(row.Size) || 0))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function driveFromParts(caption, driveType, free, size) {
  if (!caption || !size) return null;
  if (![2, 3, 4].includes(driveType)) return null;

  const root = caption.endsWith('\\') ? caption : `${caption}\\`;
  return {
    name: caption,
    path: root,
    capacity: size,
    used: Math.max(0, size - free)
  };
}

async function scanChildren(parentNode, depth, minSize, scanId, progress, sendUpdate) {
  if (depth >= COLUMN_COUNT) return [];

  const children = parentNode.children;
  let entries;
  try {
    entries = await fs.promises.readdir(parentNode.path, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .slice(0, MAX_CHILDREN_PER_DIR);

  for (const entry of dirs) {
    if (scanId !== activeScanId) return children;
    const childPath = path.join(parentNode.path, entry.name);
    progress.visited += 1;

    const probe = await measureDirectoryUntil(childPath, minSize);
    if (!probe.exceeded) continue;

    const child = {
      id: childPath,
      name: entry.name,
      path: childPath,
      type: 'folder',
      size: probe.size,
      estimated: true,
      children: []
    };
    children.push(child);
    children.sort((a, b) => b.size - a.size);
    parentNode.children = children;
    progress.visible += 1;
    sendUpdate(`Found ${childPath}`, true);

    await scanDirectory(child, depth, minSize, scanId, progress, sendUpdate);
    if (!child || child.size < minSize) continue;
    children.sort((a, b) => b.size - a.size);
    sendUpdate(`Measured ${childPath}`);
  }

  children.sort((a, b) => b.size - a.size);
  return children;
}

async function scanDirectory(node, depth, minSize, scanId, progress, sendUpdate) {
  let total = 0;
  const children = [];
  let entries;

  try {
    entries = await fs.promises.readdir(node.path, { withFileTypes: true });
  } catch {
    node.estimated = false;
    return;
  }

  for (const entry of entries) {
    if (scanId !== activeScanId) return;
    const entryPath = path.join(node.path, entry.name);
    try {
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        progress.visited += 1;
        const probe = await measureDirectoryUntil(entryPath, minSize);
        if (!probe.exceeded) {
          total += probe.size;
          continue;
        }

        const child = {
          id: entryPath,
          name: entry.name,
          path: entryPath,
          type: 'folder',
          size: probe.size,
          estimated: true,
          children: []
        };

        if (depth + 1 < COLUMN_COUNT && children.length < MAX_CHILDREN_PER_DIR) {
          children.push(child);
          children.sort((a, b) => b.size - a.size);
          node.children = children;
          progress.visible += 1;
          sendUpdate(`Found ${entryPath}`, true);
        }

        await scanDirectory(child, depth + 1, minSize, scanId, progress, sendUpdate);
        total += child.size;
      } else if (entry.isFile()) {
        const stat = await fs.promises.stat(entryPath);
        total += stat.size;
      }
    } catch {
      // Some system folders deny access; skip them and keep the scan moving.
    }
  }

  children.sort((a, b) => b.size - a.size);
  node.size = total;
  node.estimated = false;
  node.children = children;
}

async function measureDirectoryUntil(dirPath, limit) {
  let total = 0;
  const stack = [dirPath];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;

    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      try {
        if (entry.isSymbolicLink()) continue;

        if (entry.isDirectory()) {
          stack.push(entryPath);
        } else if (entry.isFile()) {
          const stat = await fs.promises.stat(entryPath);
          total += stat.size;
          if (total >= limit) {
            return { size: total, exceeded: true };
          }
        }
      } catch {
        // Access-denied and transient files are ignored; the visual remains best effort.
      }
    }
  }

  return { size: total, exceeded: false };
}
