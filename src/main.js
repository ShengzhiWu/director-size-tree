const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const COLUMN_COUNT = 5;
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
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'Save Results...',
          click: (_menuItem, browserWindow) => {
            browserWindow?.webContents.send('results:save-request');
          }
        },
        {
          label: 'Load Results...',
          click: (_menuItem, browserWindow) => {
            browserWindow?.webContents.send('results:load-request');
          }
        }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('scan:start', async (event, rootPath = '') => {
  const scanId = ++activeScanId;
  const requestedPath = String(rootPath || '').trim();
  if (requestedPath) {
    return scanFolderRoot(event, scanId, requestedPath);
  }

  return scanComputer(event, scanId);
});

async function scanComputer(event, scanId) {
  const drives = await listDrives();
  const totalCapacity = drives.reduce((sum, drive) => sum + drive.capacity, 0);
  const minSize = Math.max(1, totalCapacity / 1000);

  const tree = {
    columns: COLUMN_COUNT,
    minSize,
    totalCapacity,
    source: { type: 'computer' },
    data: drives.map((drive) => ({
      name: drive.name,
      path: drive.path,
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

  for (const root of tree.data) {
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
}

async function scanFolderRoot(event, scanId, rootPath) {
  const resolvedPath = path.resolve(rootPath);
  const stat = await fs.promises.stat(resolvedPath);
  if (!stat.isDirectory()) throw new Error('Scan path must be a folder.');

  const totalSize = await measureDirectory(resolvedPath);
  const minSize = Math.max(1, totalSize / 1000);
  const root = {
    name: path.basename(resolvedPath) || resolvedPath,
    path: resolvedPath,
    size: totalSize,
    children: []
  };
  const tree = {
    columns: COLUMN_COUNT,
    minSize,
    totalCapacity: totalSize,
    source: { type: 'folder', path: resolvedPath },
    data: root.children,
    scan: {
      status: 'running',
      visited: 0,
      visible: 0,
      message: `Scanning ${resolvedPath}`
    }
  };
  const progress = {
    visited: 0,
    visible: 0,
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

  sendUpdate(`Scanning ${resolvedPath}`, true);
  await scanChildren(root, 0, minSize, scanId, progress, sendUpdate);
  tree.data = root.children;
  tree.scan = {
    status: scanId === activeScanId ? 'done' : 'cancelled',
    visited: progress.visited,
    visible: progress.visible,
    message: scanId === activeScanId ? 'Done' : 'Cancelled'
  };
  event.sender.send('scan:update', tree);
  return tree;
}

ipcMain.handle('folder:open', async (_event, folderPath) => {
  try {
    const stat = await fs.promises.stat(folderPath);
    if (!stat.isDirectory()) return { opened: false };

    const error = await shell.openPath(folderPath);
    return { opened: !error, error };
  } catch (error) {
    return { opened: false, error: error.message };
  }
});

ipcMain.handle('results:save', async (event, tree) => {
  if (!tree) return { saved: false };

  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Save Results',
    defaultPath: 'director-size-tree-results.json',
    filters: [{ name: 'JSON Files', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return { saved: false };

  const snapshot = createTreeSnapshot(tree);
  await fs.promises.writeFile(result.filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return { saved: true, filePath: result.filePath };
});

ipcMain.handle('results:load', async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Load Results',
    filters: [{ name: 'JSON Files', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return { loaded: false };

  const text = await fs.promises.readFile(result.filePaths[0], 'utf8');
  activeScanId += 1;
  return {
    loaded: true,
    filePath: result.filePaths[0],
    tree: normalizeTreeSnapshot(JSON.parse(text))
  };
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
    execFile('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,FreeSpace,Size | ConvertTo-Json'
    ], { windowsHide: true }, (_error, stdout) => {
      resolve(parsePowerShellDrives(stdout));
    });
  });
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
  if (driveType !== 3) return null;

  const root = caption.endsWith('\\') ? caption : `${caption}\\`;
  return {
    name: caption,
    path: root,
    capacity: size,
    used: Math.max(0, size - free)
  };
}

async function scanChildren(parentNode, depth, minSize, scanId, progress, sendUpdate) {
  if (depth >= COLUMN_COUNT) return;

  const children = parentNode.children;
  let entries;
  try {
    entries = await fs.promises.readdir(parentNode.path, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (scanId !== activeScanId) return;
    const childPath = path.join(parentNode.path, entry.name);
    progress.visited += 1;

    try {
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        const probe = await measureDirectoryUntil(childPath, minSize);
        if (!probe.exceeded) continue;

        const child = createNode(entry.name, childPath, probe.size);
        addVisibleChild(parentNode, children, child, progress);
        sendUpdate(`Found ${childPath}`, true);

        await scanDirectory(child, depth, minSize, scanId, progress, sendUpdate);
        children.sort((a, b) => b.size - a.size);
        sendUpdate(`Measured ${childPath}`);
      } else if (entry.isFile()) {
        const stat = await fs.promises.stat(childPath);
        if (stat.size < minSize) continue;

        addVisibleChild(parentNode, children, createNode(entry.name, childPath, stat.size), progress);
        sendUpdate(`Found ${childPath}`, true);
      }
    } catch {
      // Access-denied and transient files are ignored; the visual remains best effort.
    }
  }

  children.sort((a, b) => b.size - a.size);
}

async function scanDirectory(node, depth, minSize, scanId, progress, sendUpdate) {
  let total = 0;
  const children = [];
  let entries;

  try {
    entries = await fs.promises.readdir(node.path, { withFileTypes: true });
  } catch {
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

        const child = createNode(entry.name, entryPath, probe.size);

        if (depth + 1 < COLUMN_COUNT && children.length < MAX_CHILDREN_PER_DIR) {
          addVisibleChild(node, children, child, progress);
          sendUpdate(`Found ${entryPath}`, true);
        }

        await scanDirectory(child, depth + 1, minSize, scanId, progress, sendUpdate);
        total += child.size;
      } else if (entry.isFile()) {
        const stat = await fs.promises.stat(entryPath);
        total += stat.size;
        if (depth + 1 < COLUMN_COUNT && children.length < MAX_CHILDREN_PER_DIR && stat.size >= minSize) {
          addVisibleChild(node, children, createNode(entry.name, entryPath, stat.size), progress);
          sendUpdate(`Found ${entryPath}`, true);
        }
      }
    } catch {
      // Some system folders deny access; skip them and keep the scan moving.
    }
  }

  children.sort((a, b) => b.size - a.size);
  node.size = total;
  node.children = children;
}

function createNode(name, nodePath, size) {
  return {
    name,
    path: nodePath,
    size,
    children: []
  };
}

function addVisibleChild(parentNode, children, child, progress) {
  if (children.length >= MAX_CHILDREN_PER_DIR) return;
  children.push(child);
  children.sort((a, b) => b.size - a.size);
  parentNode.children = children;
  progress.visible += 1;
}

function createTreeSnapshot(tree) {
  return {
    version: 1,
    columns: tree.columns,
    minSize: tree.minSize,
    totalCapacity: tree.totalCapacity,
    source: tree.source,
    data: tree.data.map(copyNode)
  };
}

function copyNode(node) {
  const copy = {
    name: node.name,
    path: node.path,
    size: node.size,
    children: (node.children || []).map(copyNode)
  };
  if (typeof node.capacity === 'number') copy.capacity = node.capacity;
  return copy;
}

function normalizeTreeSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.data)) {
    throw new Error('Invalid results file.');
  }

  return {
    columns: Number(snapshot.columns) || COLUMN_COUNT,
    minSize: Number(snapshot.minSize) || 1,
    totalCapacity: Number(snapshot.totalCapacity) || snapshot.data.reduce((sum, root) => sum + (Number(root.capacity) || 0), 0),
    source: normalizeSource(snapshot.source),
    data: snapshot.data.map(normalizeNode),
    scan: {
      status: 'loaded',
      visited: 0,
      visible: countNodes(snapshot.data),
      message: 'Loaded results'
    }
  };
}

function normalizeSource(source) {
  if (!source || !['computer', 'folder'].includes(source.type)) {
    throw new Error('Invalid results file.');
  }
  const normalized = { type: source.type };
  if (source.type === 'folder') normalized.path = String(source.path || '');
  return normalized;
}

function normalizeNode(node) {
  const normalized = {
    name: String(node.name || ''),
    path: String(node.path || ''),
    size: Number(node.size) || 0,
    children: Array.isArray(node.children) ? node.children.map(normalizeNode) : []
  };
  if (typeof node.capacity !== 'undefined') normalized.capacity = Number(node.capacity) || 0;
  return normalized;
}

function countNodes(nodes) {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children || []), 0);
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

async function measureDirectory(dirPath) {
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
        }
      } catch {
        // Access-denied and transient files are ignored; the visual remains best effort.
      }
    }
  }

  return total;
}
