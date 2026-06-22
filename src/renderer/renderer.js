const svg = document.querySelector('#treeSvg');
const scanButton = document.querySelector('#scanButton');
const scanPathInput = document.querySelector('#scanPathInput');
const showLabelsToggle = document.querySelector('#showLabelsToggle');
const statusMessage = document.querySelector('#statusMessage');
const statusCounts = document.querySelector('#statusCounts');
const emptyState = document.querySelector('#emptyState');

const SVG_NS = 'http://www.w3.org/2000/svg';
const TOP_PADDING = 18;
const SIDE_PADDING = 18;
const COLUMN_GAP = 22;

let currentTree = null;
let nodeRects = new Map();
let showLabels = showLabelsToggle.checked;

scanButton.addEventListener('click', scan);
showLabelsToggle.addEventListener('change', () => {
  showLabels = showLabelsToggle.checked;
  if (currentTree) draw(currentTree);
});
window.addEventListener('resize', () => {
  if (currentTree) draw(currentTree);
});
window.diskTree.onSaveRequest(saveCurrentResults);
window.diskTree.onLoadRequest(loadResults);
window.diskTree.onUpdate((tree) => {
  currentTree = tree;
  draw(tree);
  emptyState.hidden = tree.data.length > 0;
  const scan = tree.scan || {};
  setStatus(scan.message || 'Scanning', scan);
});

async function scan() {
  currentTree = null;
  svg.replaceChildren();
  nodeRects = new Map();
  scanButton.disabled = true;
  scanButton.textContent = 'Scanning';
  setStatus('Scanning...', { visible: 0, visited: 0 });
  emptyState.hidden = false;
  emptyState.textContent = 'Scanning...';

  try {
    currentTree = await window.diskTree.scan(scanPathInput.value.trim());
    draw(currentTree);
    setStatus(`Done. Total capacity ${formatBytes(currentTree.totalCapacity)}`, currentTree.scan);
    emptyState.hidden = currentTree.data.length > 0;
  } catch (error) {
    setStatus('Scan failed');
    emptyState.hidden = false;
    emptyState.textContent = error.message || String(error);
  } finally {
    scanButton.disabled = false;
    scanButton.textContent = 'Scan';
  }
}

async function saveCurrentResults() {
  if (!currentTree) {
    setStatus('Nothing to save yet.');
    return;
  }

  try {
    const result = await window.diskTree.saveResults(currentTree);
    if (result.saved) setStatus(`Saved ${result.filePath}`, currentTree.scan);
  } catch (error) {
    setStatus(`Save failed: ${error.message || error}`, currentTree.scan);
  }
}

async function loadResults() {
  try {
    const result = await window.diskTree.loadResults();
    if (!result.loaded) return;

    currentTree = result.tree;
    draw(currentTree);
    emptyState.hidden = currentTree.data.length > 0;
    setStatus(`Loaded ${result.filePath}`, currentTree.scan);
  } catch (error) {
    setStatus(`Load failed: ${error.message || error}`);
  }
}

function setStatus(message, scan = {}) {
  statusMessage.textContent = message;
  statusCounts.textContent = `Visible ${scan.visible || 0}, scanned ${scan.visited || 0}`;
}

function draw(tree) {
  const width = svg.clientWidth || 900;
  const height = svg.clientHeight || 560;
  const drawableHeight = height - TOP_PADDING;
  const columnWidth = (width - SIDE_PADDING * 2 - COLUMN_GAP * (tree.columns - 1)) / tree.columns;
  const scale = drawableHeight / Math.max(1, tree.totalCapacity);
  const columns = buildColumns(tree.data, tree.columns, scale);

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.replaceChildren();
  nodeRects = new Map();

  for (let columnIndex = 0; columnIndex < tree.columns; columnIndex += 1) {
    const x = SIDE_PADDING + columnIndex * (columnWidth + COLUMN_GAP);
    drawColumnGuide(x, columnWidth, height, columnIndex);

    for (const item of columns[columnIndex]) {
      drawNode(item.node, x, item.y, columnWidth, item.height, columnIndex, item.color, item.pathChain, item.visualSize);
    }
  }
}

function buildColumns(data, columnCount, scale) {
  const columns = Array.from({ length: columnCount }, () => []);
  let capacityOffset = TOP_PADDING;

  data.forEach((root, index) => {
    const color = rootColor(root, index);
    const visualSize = getVisualSize(root);
    const height = Math.max(1, visualSize * scale);
    const pathChain = [root.path];
    columns[0].push({ node: root, y: capacityOffset, height, color, pathChain, visualSize });
    visitChildren(root, 1, capacityOffset, color, pathChain);
    capacityOffset += (root.capacity ?? root.size) * scale;
  });

  function visitChildren(parent, depth, parentY, parentColor, parentPathChain) {
    if (depth >= columnCount) return;
    if (!parent.children || parent.children.length === 0) return;

    let usedOffset = parentY;
    for (const node of parent.children) {
      const color = childColor(node.path, depth, parentColor);
      const visualSize = getVisualSize(node);
      const height = Math.max(1, visualSize * scale);
      const pathChain = [...parentPathChain, node.path];
      columns[depth].push({ node, y: usedOffset, height, color, pathChain, visualSize });
      visitChildren(node, depth + 1, usedOffset, color, pathChain);
      usedOffset += visualSize * scale;
    }
  }

  return columns;
}

function getVisualSize(node) {
  const children = node.children || [];
  const visibleChildrenSize = children.reduce((sum, child) => sum + getVisualSize(child), 0);
  return Math.max(node.size || 0, visibleChildrenSize);
}

function drawColumnGuide(x, width, height, columnIndex) {
  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('x', x);
  label.setAttribute('y', 13);
  label.setAttribute('class', 'column-label');
  label.textContent = columnIndex === 0 && currentTree?.source?.type !== 'folder' ? 'Drives' : `Level ${columnIndex + 1}`;
  svg.append(label);

  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('x1', x + width + COLUMN_GAP / 2);
  line.setAttribute('x2', x + width + COLUMN_GAP / 2);
  line.setAttribute('y1', TOP_PADDING);
  line.setAttribute('y2', height);
  line.setAttribute('class', 'guide-line');
  svg.append(line);
}

function drawNode(node, x, y, width, height, depth, color, pathChain, visualSize) {
  const group = document.createElementNS(SVG_NS, 'g');
  const rect = document.createElementNS(SVG_NS, 'rect');
  const title = document.createElementNS(SVG_NS, 'title');
  const text = document.createElementNS(SVG_NS, 'text');

  rect.setAttribute('x', x);
  rect.setAttribute('y', y);
  rect.setAttribute('width', Math.max(1, width));
  rect.setAttribute('height', height);
  rect.setAttribute('rx', 0);
  rect.setAttribute('shape-rendering', 'crispEdges');
  rect.setAttribute('fill', `hsl(${color.h} ${color.s}% ${color.l}%)`);
  rect.setAttribute('opacity', String(Math.max(0.35, 0.95 - depth * 0.06)));
  rect.setAttribute('class', 'node-rect');

  title.textContent = `${node.path}\n${formatBytes(visualSize)}`;

  if ((depth === 0 || showLabels) && height >= 16) {
    text.setAttribute('x', x + 6);
    text.setAttribute('y', y + Math.min(15, height - 4));
    text.setAttribute('class', 'node-label');
    text.textContent = fitText(getNodeLabel(node, depth, visualSize), width);
  }

  group.append(rect, title);
  if (height >= 16) group.append(text);
  group.addEventListener('mouseenter', () => highlightPath(pathChain));
  group.addEventListener('mouseleave', clearHighlight);
  group.addEventListener('dblclick', async (event) => {
    event.stopPropagation();
    const result = await window.diskTree.openFolder(node.path);
    if (result.reason === 'missing') {
      window.alert('This item no longer exists.');
    }
  });
  nodeRects.set(node.path, rect);
  svg.append(group);
}

function highlightPath(pathChain) {
  clearHighlight();
  for (const nodePath of pathChain) {
    const rect = nodeRects.get(nodePath);
    if (rect) rect.classList.add('node-rect-highlight');
  }
}

function clearHighlight() {
  for (const rect of nodeRects.values()) {
    rect.classList.remove('node-rect-highlight');
  }
}

function fitText(text, width) {
  const maxChars = Math.max(4, Math.floor(width / 7));
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}...`;
}

function getNodeLabel(node, depth, visualSize) {
  if (depth === 0 && typeof node.capacity === 'number') {
    return `${node.name} ${formatBytes(visualSize)}/${formatBytes(node.capacity)}`;
  }
  return `${node.name} ${formatBytes(visualSize)}`;
}

function rootColor(node, index) {
  if (currentTree?.source?.type === 'folder') {
    return { h: hashRange(node.path, 0, 359), s: 70, l: 50 };
  }
  return { h: 0, s: 0, l: index % 2 === 0 ? 40 : 60 };
}

function childColor(key, depth, parentColor) {
  if (depth === 1 && currentTree?.source?.type !== 'folder') {
    return {
      h: hashRange(key, 0, 359),
      s: 70,
      l: parentColor.l
    };
  }

  return {
    h: wrapHue(parentColor.h + hashRange(`${key}:h`, -45, 45)),
    s: 70,
    l: clamp(parentColor.l + hashRange(`${key}:l`, -14, 14), 22, 78)
  };
}

function hashRange(key, min, max) {
  return min + (hashString(key) % (max - min + 1));
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function wrapHue(value) {
  return ((value % 360) + 360) % 360;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Number(bytes) || 0;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}
