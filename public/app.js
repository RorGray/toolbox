// Toolbox UI logic. Plain ES modules, no framework — keeps the image slim.

const board = document.getElementById('board');
const search = document.getElementById('search');
const addBtn = document.getElementById('add');
const refreshBtn = document.getElementById('refresh');
const readout = document.getElementById('readout');
const colophon = document.getElementById('colophon');

const dialog = document.getElementById('editor');
const form = document.getElementById('editor-form');
const editorTitle = document.getElementById('editor-title');
const editorError = document.getElementById('editor-error');
const categoriesList = document.getElementById('categories');
const iconUrlInput = form.querySelector('.icon-url');
const iconFileInput = form.querySelector('.icon-file');
const keepModeLabel = form.querySelector('.keep-only');

let state = { tools: [], isAdmin: false, user: null, filter: '' };
let editingId = null;

// ---------- theme (modern ⇄ brass) ----------
const themeToggle = document.getElementById('theme-toggle');
const themeLabel = themeToggle.querySelector('.theme-toggle-label');
function currentTheme() {
  return document.documentElement.dataset.theme === 'brass' ? 'brass' : 'modern';
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('toolbox-theme', theme); } catch { /* private mode */ }
  // the button advertises the look you'd switch *to*
  themeLabel.textContent = theme === 'brass' ? 'Modern' : 'Brass';
  themeToggle.setAttribute('aria-label', `Switch to ${themeLabel.textContent} look`);
}
applyTheme(currentTheme()); // sync label with whatever the head script set
themeToggle.addEventListener('click', () =>
  applyTheme(currentTheme() === 'brass' ? 'modern' : 'brass')
);

// ---------- data ----------
async function api(path, options) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function load() {
  const [me, list] = await Promise.all([api('/api/me'), api('/api/tools')]);
  state.isAdmin = me.isAdmin;
  state.user = me.user;
  state.tools = list.tools;
  addBtn.hidden = !me.isAdmin;
  refreshBtn.hidden = !me.isAdmin;
  render();
}

// ---------- helpers ----------
function hostOf(url) { try { return new URL(url).host; } catch { return url; } }
function initials(name) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0] || '').join('').toUpperCase() || '?';
}
function relTime(iso) {
  if (!iso) return 'never';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

// ---------- status readout (the rack-panel signature) ----------
function renderReadout() {
  const total = state.tools.length;
  const up = state.tools.filter((t) => t.health?.status === 'up').length;
  const down = state.tools.filter((t) => t.health?.status === 'down').length;
  readout.innerHTML = '';
  if (total === 0) return;
  readout.append(
    el('span', { class: 'ok' }, `${up} reachable`),
    document.createTextNode(' · '),
    down > 0 ? el('span', { class: 'bad' }, `${down} unreachable`) : el('span', {}, `${down} unreachable`),
    document.createTextNode(` · ${total} total`)
  );
}

function renderColophon() {
  // The hub stats only make sense with tools, but the Grayo mark always shows.
  colophon.hidden = false;
  colophon.innerHTML = '';
  if (state.tools.length > 0) {
    const cats = new Set(state.tools.map((t) => t.category || 'Uncategorised'));
    colophon.append(
      el('span', {}, `${state.tools.length} tools · ${cats.size} categories`),
      el('span', {}, 'status refreshed every 60s'),
      el('span', {}, state.user ? `${state.user}${state.isAdmin ? ' · admin' : ' · read-only'}` : 'Toolbox')
    );
  }
  colophon.append(
    el('a', {
      class: 'grayo',
      href: 'https://gograyo.com',
      target: '_blank',
      rel: 'noopener noreferrer',
      title: 'A Grayo product',
    }, el('img', { src: '/grayo-logo.svg', alt: 'Grayo', width: '74', height: '18' }))
  );
}

// ---------- render ----------
function render() {
  board.innerHTML = '';
  const q = state.filter.toLowerCase();
  const tools = state.tools.filter((t) => {
    if (!q) return true;
    return (
      t.name.toLowerCase().includes(q) ||
      (t.url || '').toLowerCase().includes(q) ||
      (t.description || '').toLowerCase().includes(q) ||
      (t.category || '').toLowerCase().includes(q) ||
      (t.tags || []).some((tag) => tag.toLowerCase().includes(q))
    );
  });

  // datalist of existing categories for the editor
  const cats = [...new Set(state.tools.map((t) => t.category).filter(Boolean))].sort();
  categoriesList.innerHTML = '';
  cats.forEach((c) => categoriesList.append(el('option', { value: c })));

  renderReadout();
  renderColophon();

  if (tools.length === 0) {
    const msg = state.tools.length === 0
      ? state.isAdmin
        ? el('p', { class: 'empty' }, 'No tools yet. Use ', el('b', {}, 'Add tool'), ' to create the first entry.')
        : el('p', { class: 'empty' }, 'No tools have been added yet.')
      : el('p', { class: 'empty' }, `No tools match “${state.filter}”.`);
    board.append(msg);
    return;
  }

  // group by category; Uncategorised sinks to the bottom
  const groups = new Map();
  for (const t of tools) {
    const cat = t.category || 'Uncategorised';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(t);
  }
  const orderedCats = [...groups.keys()].sort((a, b) => {
    if (a === 'Uncategorised') return 1;
    if (b === 'Uncategorised') return -1;
    return a.localeCompare(b);
  });

  for (const cat of orderedCats) {
    const items = groups.get(cat).sort((a, b) => a.name.localeCompare(b.name));
    const panel = el('section', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('h2', {}, cat),
        el('span', { class: 'count' }, String(items.length))
      )
    );
    const grid = el('div', { class: 'grid' });
    items.forEach((t) => grid.append(card(t)));
    panel.append(grid);
    board.append(panel);
  }
}

function card(t) {
  const status = t.health?.status || 'unknown';
  const node = el('a', {
    class: `card status-${status}`,
    href: t.url,
    target: '_blank',
    rel: 'noopener noreferrer',
  });

  const iconWrap = el('div', { class: 'card-icon' });
  if (t.iconFile) {
    iconWrap.append(el('img', { src: `/icons/${encodeURIComponent(t.iconFile)}`, alt: '', loading: 'lazy' }));
  } else {
    iconWrap.classList.add('is-mono');
    iconWrap.append(el('span', { class: 'monogram' }, initials(t.name)));
  }

  node.append(
    el('div', { class: 'card-top' },
      iconWrap,
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title' }, t.name),
        el('div', { class: 'card-host' }, hostOf(t.url))
      )
    )
  );

  if (t.description) node.append(el('p', { class: 'card-desc' }, t.description));

  if (t.tags?.length) {
    const tags = el('div', { class: 'tag-list' });
    t.tags.slice(0, 4).forEach((tag) => tags.append(el('span', { class: 'tag' }, tag)));
    node.append(tags);
  }

  const label = status === 'up' ? 'reachable' : status === 'down' ? 'unreachable' : 'unchecked';
  node.append(
    el('div', { class: 'card-foot' },
      el('span', { class: 'status-dot' }),
      el('span', { class: 'status-label' }, label),
      el('span', { class: 'checked' }, relTime(t.health?.checkedAt))
    )
  );

  if (state.isAdmin) {
    node.append(
      el('div', { class: 'card-admin' },
        el('button', { class: 'icon-btn', title: 'Edit', type: 'button',
          onclick: (e) => { e.preventDefault(); openEditor(t); } }, '✎'),
        el('button', { class: 'icon-btn danger', title: 'Delete', type: 'button',
          onclick: (e) => { e.preventDefault(); remove(t); } }, '🗑')
      )
    );
  }
  return node;
}

// ---------- editor ----------
function setIconMode(mode) {
  iconUrlInput.hidden = mode !== 'url';
  iconFileInput.hidden = mode !== 'upload';
}
[...form.elements.iconMode].forEach((r) =>
  r.addEventListener('change', () => setIconMode(form.elements.iconMode.value))
);

function openEditor(tool) {
  editingId = tool?.id || null;
  editorError.hidden = true;
  form.reset();
  editorTitle.textContent = tool ? 'Edit tool' : 'Add tool';
  keepModeLabel.hidden = !tool || !tool.iconFile;

  if (tool) {
    form.elements.name.value = tool.name;
    form.elements.url.value = tool.url;
    form.elements.category.value = tool.category === 'Uncategorised' ? '' : (tool.category || '');
    form.elements.tags.value = (tool.tags || []).join(', ');
    form.elements.description.value = tool.description || '';
    const defaultMode = tool.iconFile ? 'keep' : 'auto';
    form.elements.iconMode.value = defaultMode;
    setIconMode(defaultMode);
  } else {
    form.elements.iconMode.value = 'auto';
    setIconMode('auto');
  }
  dialog.showModal();
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  editorError.hidden = true;
  const saveBtn = document.getElementById('editor-save');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  try {
    const mode = form.elements.iconMode.value;
    const payload = {
      name: form.elements.name.value,
      url: form.elements.url.value,
      category: form.elements.category.value,
      tags: form.elements.tags.value,
      description: form.elements.description.value,
      iconMode: mode,
    };
    if (mode === 'url') payload.iconUrl = iconUrlInput.value;
    if (mode === 'upload') {
      const file = iconFileInput.files?.[0];
      if (!file) throw new Error('Choose an image file or pick another icon option.');
      payload.iconData = await fileToDataUrl(file);
    }
    if (editingId) {
      await api(`/api/tools/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/api/tools', { method: 'POST', body: JSON.stringify(payload) });
    }
    dialog.close();
    await load();
  } catch (err) {
    editorError.textContent = err.message;
    editorError.hidden = false;
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
});

async function remove(tool) {
  if (!confirm(`Remove “${tool.name}” from the hub?`)) return;
  try {
    await api(`/api/tools/${tool.id}`, { method: 'DELETE' });
    await load();
  } catch (err) {
    alert(err.message);
  }
}

// ---------- events ----------
addBtn.addEventListener('click', () => openEditor(null));
document.getElementById('editor-cancel').addEventListener('click', () => dialog.close());
refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = 'Checking…';
  try {
    const data = await api('/api/health/check', { method: 'POST' });
    state.tools = data.tools;
    render();
  } catch (err) {
    alert(err.message);
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = 'Re-check';
  }
});

let searchTimer;
search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.filter = search.value.trim(); render(); }, 120);
});

// keep status dots current without a reload
setInterval(async () => {
  try {
    const list = await api('/api/tools');
    state.tools = list.tools;
    render();
  } catch { /* ignore transient errors */ }
}, 60000);

load().catch((err) => {
  board.innerHTML = '';
  board.append(el('p', { class: 'empty' }, `Could not load: ${err.message}`));
});
