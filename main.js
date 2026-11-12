'use strict';

const obsidian = require('obsidian');
const { Plugin, ItemView, PluginSettingTab, Setting, Modal, Menu, TFolder, debounce, setIcon, normalizePath } = obsidian;

const VIEW_TYPE = 'orbit-folders-view';
const TAU = Math.PI * 2;

/* ---------- i18n ---------- */

let LANG = 'en';

// Interface language: the one picked in the plugin settings, or Obsidian's own
function detectLanguage(setting) {
  if (setting === 'en' || setting === 'ru') return setting;
  let lang = '';
  try {
    lang = typeof obsidian.getLanguage === 'function' ? obsidian.getLanguage() : window.localStorage.getItem('language');
  } catch (e) {
    lang = '';
  }
  return lang && lang.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

function tr(en, ru) {
  return LANG === 'ru' ? ru : en;
}

function filesLabel(n) {
  if (LANG === 'ru') return n + ' ' + plural(n, 'файл', 'файла', 'файлов');
  return n + (n === 1 ? ' file' : ' files');
}

const DEFAULT_SETTINGS = {
  language: 'auto',
  // what to show
  rootPath: '',
  excluded: '',
  hideEmpty: false,
  // орбиты
  orbitCount: 4,
  firstRadius: 170,
  orbitGap: 110,
  tilt: 0.42,
  rotation: -8,
  showOrbits: true,
  orbitOpacity: 0.16,
  distribution: 'size',
  stableLayout: true,
  fileOrbits: 'center',
  // движение
  animate: true,
  speed: 1,
  planetSpeed: 1,
  fileSpeed: 1.6,
  speedSpread: 0.2,
  alternate: false,
  pauseOnHover: true,
  // папки
  nodeSize: 14,
  scaleBySize: true,
  labels: 'always',
  showIcons: true,
  centerSize: 30,
  centerStyle: 'star',
  // файлы
  showFiles: true,
  showSubfolders: true,
  recursiveFiles: false,
  showRootFiles: true,
  centerFilesOrbit: true,
  maxSatellites: 60,
  burstRadius: 75,
  showLines: true,
  colorByType: false,
  highlightRecentDays: 3,
  // оформление
  background: 'space',
  stars: true,
  nebulae: true,
  cursorFx: true,
  signals: true,
  signalInterval: 4,
  signalCount: 4,
  comets: true,
  cometInterval: 25,
  accent: '#c8f31d',
  openInNewTab: false,
  // индивидуальные настройки папок: { [path]: { hidden, color, icon, orbit } }
  folders: {},
};

const PALETTE = [
  '#7aa2ff', '#ff8a5c', '#5ce0c6', '#ff6b9d', '#b98cff', '#ffd166',
  '#4cc9f0', '#f4978e', '#9be564', '#e8eaed', '#ff5d5d', '#6ee7ff',
];

const TYPE_COLORS = {
  image: '120,200,255',
  pdf: '255,120,110',
  media: '185,140,255',
  canvas: '92,224,198',
  other: '255,209,102',
};
const EXT_TYPES = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image', webp: 'image', bmp: 'image', avif: 'image',
  pdf: 'pdf',
  mp3: 'media', wav: 'media', ogg: 'media', m4a: 'media', flac: 'media', mp4: 'media', webm: 'media', mov: 'media', mkv: 'media',
  canvas: 'canvas', base: 'canvas',
};

/* ---------- helpers ---------- */

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '255,255,255';
  const n = parseInt(m[1], 16);
  return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
}

function cssToRgb(color) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(color || '');
  if (!m) return null;
  return Math.round(+m[1]) + ',' + Math.round(+m[2]) + ',' + Math.round(+m[3]);
}

// три тона для шара планеты: освещённый, основной и ночной
function planetTones(rgb) {
  const c = rgb.split(',').map(Number);
  const mix = (t, f) => 'rgb(' + c.map((v) => Math.round(v + (t - v) * f)).join(',') + ')';
  return { light: mix(255, 0.32), mid: mix(0, 0.28), dark: mix(0, 0.9) };
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function easeOut(x) {
  return 1 - Math.pow(1 - x, 3);
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

function shortCount(n) {
  return n >= 10000 ? Math.round(n / 1000) + 'k' : String(n);
}

function defaultColor(path) {
  return PALETTE[hashStr(path) % PALETTE.length];
}

function cleanPath(path) {
  const p = normalizePath((path || '').trim());
  return p === '/' ? '' : p;
}

function parseExcluded(text) {
  return (text || '')
    .split(/[\n,]/)
    .map(cleanPath)
    .filter(Boolean);
}

/* ---------- plugin ---------- */

class OrbitFoldersPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    LANG = detectLanguage(this.settings.language);
    this.icon = obsidian.getIcon && obsidian.getIcon('orbit') ? 'orbit' : 'sun';
    this.saveSoon = debounce(() => this.saveData(this.settings), 400, true);

    this.registerView(VIEW_TYPE, (leaf) => new OrbitView(leaf, this));
    this.addRibbonIcon(this.icon, tr('Open orbit folders', 'Открыть орбиты папок'), () => this.activateView());
    this.addCommand({
      id: 'open',
      name: tr('Open orbit view', 'Открыть орбиты папок'),
      callback: () => this.activateView(),
    });
    this.addSettingTab(new OrbitSettingTab(this.app, this));

    // переносим индивидуальные настройки при переименовании папок
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        const map = this.settings.folders;
        let changed = false;
        for (const key of Object.keys(map)) {
          if (key === oldPath || key.startsWith(oldPath + '/')) {
            map[file.path + key.slice(oldPath.length)] = map[key];
            delete map[key];
            changed = true;
          }
        }
        if (changed) this.saveSoon();
      })
    );
  }

  async loadSettings() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.settings.folders = Object.assign({}, data.folders || {});
  }

  saveSettings() {
    LANG = detectLanguage(this.settings.language);
    this.saveSoon();
    this.refreshViews();
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof OrbitView) leaf.view.onSettingsChanged();
    }
  }

  folderCfg(path) {
    return this.settings.folders[path] || {};
  }

  setFolderCfg(path, patch) {
    const cfg = Object.assign({}, this.settings.folders[path], patch);
    for (const key of Object.keys(cfg)) {
      if (!cfg[key]) delete cfg[key];
    }
    if (Object.keys(cfg).length) this.settings.folders[path] = cfg;
    else delete this.settings.folders[path];
    this.saveSettings();
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  // app.setting is not part of the public API, so it is used defensively
  openSettings() {
    const setting = this.app.setting;
    if (!setting || typeof setting.open !== 'function') return;
    setting.open();
    if (typeof setting.openTabById === 'function') setting.openTabById(this.manifest.id);
  }
}

/* ---------- view ---------- */

class OrbitView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentPath = null;
    // отдельные «часы» для папок и файлов, чтобы скорость можно было менять без скачков
    this.tp = 0;
    this.tf = 0;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.userView = false;
    this.paused = false;
    this.hits = [];
    this.hover = null;
    this.mouse = null;
    this.drag = null;
    this.scene = null;
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.fg = '255,255,255';
    this.nodeFill = '#0b0d11';
    this.font = 'sans-serif';
    this.enterAt = 0;
    this.last = 0;
    this.raf = 0;
    this.stars = [];
    const r = makeRng(20240611);
    for (let i = 0; i < 170; i++) this.stars.push({ x: r(), y: r(), r: 0.4 + r() * 0.9, a: 0.08 + r() * 0.3 });
    const tints = ['90,120,255', '160,95,255', '60,200,190', '255,120,165', '110,150,255'];
    this.nebulae = [];
    for (let i = 0; i < 7; i++) {
      this.nebulae.push({ x: r(), y: r(), r: 0.22 + r() * 0.26, a: 0.045 + r() * 0.04, rgb: tints[i % tints.length], cur: 1 });
    }
    this.dust = [];
    for (let i = 0; i < 90; i++) {
      this.dust.push({
        x: r(), y: r(), r: 0.035 + r() * 0.075, gain: 0.15 + r() * r() * 1.1,
        rgb: r() < 0.35 ? '225,230,245' : tints[Math.floor(r() * tints.length)], cur: 0,
      });
    }
    this.pings = [];
    this.comets = [];
    this.nextComet = 0;
    this.channels = [];
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return tr('Orbit folders', 'Орбиты папок');
  }

  getIcon() {
    return this.plugin.icon;
  }

  getState() {
    return Object.assign({}, super.getState(), { path: this.currentPath });
  }

  async setState(state, result) {
    if (state && typeof state.path === 'string') {
      this.currentPath = state.path;
      this.rebuild();
    }
    await super.setState(state, result);
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('orbit-folders');

    this.canvas = root.createEl('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.crumbs = root.createDiv({ cls: 'orbit-crumbs' });
    const tools = root.createDiv({ cls: 'orbit-tools' });
    this.pauseBtn = this.toolBtn(tools, 'pause', () => {
      this.paused = !this.paused;
      this.updateLabels();
    });
    this.fitBtn = this.toolBtn(tools, 'maximize', () => this.fit());
    this.settingsBtn = this.toolBtn(tools, 'settings', () => this.plugin.openSettings());
    this.updateLabels();
    this.tip = root.createDiv({ cls: 'orbit-tip' });

    this.rebuildSoon = debounce(() => this.rebuild(), 300, true);
    const vault = this.app.vault;
    this.registerEvent(vault.on('create', this.rebuildSoon));
    this.registerEvent(vault.on('delete', this.rebuildSoon));
    this.registerEvent(vault.on('rename', this.rebuildSoon));
    this.registerEvent(this.app.workspace.on('css-change', () => this.readTheme()));

    const c = this.canvas;
    this.registerDomEvent(c, 'pointerdown', (e) => this.onPointerDown(e));
    this.registerDomEvent(c, 'pointermove', (e) => this.onPointerMove(e));
    this.registerDomEvent(c, 'pointerup', (e) => this.onPointerUp(e));
    this.registerDomEvent(c, 'pointercancel', () => {
      this.drag = null;
      c.removeClass('is-grabbing');
    });
    this.registerDomEvent(c, 'pointerleave', () => {
      this.mouse = null;
      this.setHover(null);
    });
    this.registerDomEvent(c, 'wheel', (e) => this.onWheel(e), { passive: false });
    this.registerDomEvent(c, 'contextmenu', (e) => this.onContextMenu(e));
    this.registerDomEvent(c, 'dblclick', (e) => {
      const p = this.localPos(e);
      if (!this.pick(p.x, p.y)) this.fit();
    });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(root);

    this.readTheme();
    this.resize();
    this.enterAt = performance.now();
    this.nextComet = this.enterAt + 5000;
    this.rebuild();

    this.last = performance.now();
    const loop = (now) => {
      this.raf = requestAnimationFrame(loop);
      if (this.canvas.offsetParent === null) {
        this.last = now;
        return;
      }
      try {
        this.draw(now);
      } catch (e) {
        cancelAnimationFrame(this.raf);
        console.error('Orbit Folders: render error', e);
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  async onClose() {
    cancelAnimationFrame(this.raf);
    if (this.ro) this.ro.disconnect();
  }

  toolBtn(parent, icon, onClick) {
    const btn = parent.createDiv({ cls: 'orbit-tool' });
    setIcon(btn, icon);
    this.registerDomEvent(btn, 'click', onClick);
    return btn;
  }

  updateLabels() {
    if (!this.pauseBtn) return;
    setIcon(this.pauseBtn, this.paused ? 'play' : 'pause');
    this.pauseBtn.setAttribute('aria-label', this.paused ? tr('Resume', 'Запустить') : tr('Pause', 'Пауза'));
    this.fitBtn.setAttribute('aria-label', tr('Fit to view', 'Вписать в окно'));
    this.settingsBtn.setAttribute('aria-label', tr('Open settings', 'Открыть настройки'));
  }

  onSettingsChanged() {
    this.updateLabels();
    this.readTheme();
    this.rebuild();
  }

  /* ----- theme & size ----- */

  readTheme() {
    if (!this.canvas) return;
    const s = this.plugin.settings;
    const el = this.contentEl;
    const space = s.background === 'space';
    el.toggleClass('is-space', space);
    const cs = getComputedStyle(el);
    this.font = cs.fontFamily || 'sans-serif';
    if (space) {
      this.fg = '255,255,255';
      this.nodeFill = '#0b0d11';
      this.bgColor = null;
    } else {
      this.fg = cssToRgb(cs.color) || '128,128,128';
      this.bgColor = cs.getPropertyValue('--background-primary').trim() || '#ffffff';
      this.nodeFill = this.bgColor;
    }
    this.bgGrad = null;
  }

  resize() {
    if (!this.canvas) return;
    const w = this.contentEl.clientWidth;
    const h = this.contentEl.clientHeight;
    if (!w || !h) return;
    this.dpr = window.devicePixelRatio || 1;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.bgGrad = null;
    if (!this.userView) this.fit();
  }

  fit() {
    const s = this.plugin.settings;
    this.userView = false;
    this.panX = 0;
    this.panY = 0;
    if (!this.w || !this.h) return;
    const rMax = s.firstRadius + (s.orbitCount - 1) * s.orbitGap + s.burstRadius * 0.7 + s.nodeSize;
    const zx = this.w / (2 * rMax);
    const zy = this.h / (2 * (rMax * Math.max(s.tilt, 0.15) + s.burstRadius * 0.6 + 30));
    this.zoom = clamp(Math.min(zx, zy) * 0.97, 0.15, 1.5);
  }

  /* ----- scene ----- */

  getFolder(path) {
    const vault = this.app.vault;
    const clean = cleanPath(path);
    if (!clean) return vault.getRoot();
    const f = vault.getAbstractFileByPath(clean);
    return f instanceof TFolder ? f : null;
  }

  canGoUp() {
    return !!(this.current && this.base && this.current !== this.base && this.current.parent);
  }

  setCurrent(path) {
    this.currentPath = path;
    // каждая папка открывается с одной и той же начальной расстановкой
    this.tp = 0;
    this.tf = 0;
    this.enterAt = performance.now();
    this.setHover(null);
    this.rebuild();
    this.app.workspace.requestSaveLayout();
  }

  rebuild() {
    if (!this.canvas) return;
    const s = this.plugin.settings;
    const plugin = this.plugin;
    const vault = this.app.vault;
    const base = this.getFolder(s.rootPath) || vault.getRoot();
    let cur = this.currentPath != null ? this.getFolder(this.currentPath) : null;
    const inside = (f) => base.isRoot() || f.path === base.path || f.path.startsWith(base.path + '/');
    if (!cur || !inside(cur)) cur = base;
    this.base = base;
    this.current = cur;
    this.currentPath = cur.path;

    const excluded = parseExcluded(s.excluded);
    const isHidden = (path) => {
      if (plugin.folderCfg(path).hidden) return true;
      for (const e of excluded) if (path === e || path.startsWith(e + '/')) return true;
      return false;
    };

    const memo = new Map();
    const countFiles = (folder) => {
      let c = memo.get(folder);
      if (c !== undefined) return c;
      c = 0;
      for (const ch of folder.children) {
        if (ch instanceof TFolder) {
          if (!isHidden(ch.path)) c += countFiles(ch);
        } else c++;
      }
      memo.set(folder, c);
      return c;
    };

    const now = Date.now();
    const recentMs = s.highlightRecentDays > 0 ? s.highlightRecentDays * 86400000 : 0;

    const rOuter = s.firstRadius + (Math.max(1, s.orbitCount) - 1) * s.orbitGap;
    const makeSats = (folder, innerR, withSubfolders, free, dir) => {
      const subs = [];
      const files = [];
      const collect = (f, deep) => {
        for (const ch of f.children) {
          if (ch instanceof TFolder) {
            if (isHidden(ch.path)) continue;
            if (!deep && withSubfolders && s.showSubfolders) subs.push(ch);
            if (s.recursiveFiles) collect(ch, true);
          } else if (s.showFiles) files.push(ch);
        }
      };
      collect(folder, false);
      files.sort((a, b) => ((b.stat && b.stat.mtime) || 0) - ((a.stat && a.stat.mtime) || 0));
      const all = subs.concat(files);
      const items = all.slice(0, Math.max(0, s.maxSatellites));
      const spread = s.burstRadius * (0.5 + 0.5 * Math.min(1, Math.sqrt(items.length / 45)));
      const sats = items.map((file) => {
        const r = makeRng(hashStr(file.path));
        const a = r() * TAU;
        const u = r();
        // свободные файлы центра летают по всей системе, остальные — вокруг своей папки
        const d = free
          ? innerR + 24 + u * Math.max(40, rOuter - innerR - 24)
          : innerR + 6 + spread * (0.12 + 0.88 * Math.sqrt(u));
        // близость к своей папке: 1 — у самой папки, 0 — на краю облака
        const near = free ? 1 : 1 - Math.sqrt(u);
        // ближе к папке — ярче, дальше — тусклее
        const alpha = free ? 0.4 + 0.6 * r() : (0.6 + 0.4 * r()) * (0.22 + 0.78 * near);
        const w = free ? 0.06 * Math.sqrt(s.firstRadius / d) : dir * 0.09 * Math.sqrt(40 / d);
        // личная поправка к скорости: одни чуть обгоняют, другие отстают
        const v = r();
        if (file instanceof TFolder) {
          const cnt = countFiles(file);
          const cfg = plugin.folderCfg(file.path);
          return {
            kind: 'folder', file, a, d, w, v, free, near, alpha: 1, count: cnt,
            r: 3 + Math.min(3, Math.sqrt(cnt) * 0.3),
            rgb: hexToRgb(cfg.color || s.accent),
          };
        }
        const size = (file.stat && file.stat.size) || 0;
        const mtime = (file.stat && file.stat.mtime) || 0;
        let rgb = null;
        if (s.colorByType && file.extension !== 'md') rgb = TYPE_COLORS[EXT_TYPES[file.extension] || 'other'];
        return {
          kind: 'file', file, a, d, w, v, free, near, rgb,
          // файлы, летающие сами по орбитам вокруг центра, крупнее и ярче
          alpha: free ? Math.max(alpha, 0.8) : alpha,
          r: (free ? 2.6 : 0.9) + Math.min(2.2, Math.log10(1 + size / 1024) * 0.8),
          recent: recentMs > 0 && now - mtime < recentMs,
        };
      });
      return { sats, more: all.length - items.length };
    };

    // планеты — подпапки текущей папки
    let planets = [];
    for (const ch of cur.children) {
      if (!(ch instanceof TFolder) || isHidden(ch.path)) continue;
      const count = countFiles(ch);
      if (s.hideEmpty && count === 0) continue;
      const cfg = plugin.folderCfg(ch.path);
      const hex = cfg.color || defaultColor(ch.path);
      planets.push({
        kind: 'planet', file: ch, path: ch.path, name: ch.name, count,
        hex, rgb: hexToRgb(hex),
        icon: cfg.icon || Array.from(ch.name)[0].toUpperCase(),
        manualOrbit: cfg.orbit ? clamp(Math.round(cfg.orbit), 1, s.orbitCount) : 0,
        spin: hashStr(ch.path) % 2 ? 1 : -1,
        v: hashStr(ch.path + '#speed') / 4294967296,
      });
    }
    const maxCount = planets.reduce((m, p) => Math.max(m, p.count), 1);
    for (const p of planets) {
      p.size = s.nodeSize * (s.scaleBySize ? 0.75 + 0.85 * Math.sqrt(p.count / maxCount) : 1);
      const res = makeSats(p.file, p.size, true, false, p.spin);
      p.sats = res.sats;
      p.fileSats = res.sats.filter((x) => x.kind === 'file');
      p.more = res.more;
      // внешний вид планеты: тона, полосы, кольца
      const tones = planetTones(p.rgb);
      p.cLight = tones.light;
      p.cMid = tones.mid;
      p.cDark = tones.dark;
      const pr = makeRng(hashStr(p.path + '#look'));
      p.ringed = pr() < 0.28;
      p.ringRot = (pr() - 0.5) * 0.5;
      p.bandRot = (pr() - 0.5) * 0.6;
      p.bands = null;
      if (pr() < 0.65) {
        p.bands = [];
        const nb = 2 + Math.floor(pr() * 3);
        for (let b = 0; b < nb; b++) {
          p.bands.push({
            y: -0.85 + pr() * 1.5,
            h: 0.1 + pr() * 0.22,
            c: pr() < 0.5 ? 'rgba(0,0,0,0.17)' : 'rgba(255,255,255,0.11)',
          });
        }
      }
    }

    // распределение по орбитам
    const n = Math.max(1, Math.round(s.orbitCount));
    const orbits = Array.from({ length: n }, () => []);
    const auto = [];
    for (const p of planets) {
      if (p.manualOrbit) orbits[p.manualOrbit - 1].push(p);
      else auto.push(p);
    }
    if (s.stableLayout) {
      // постоянное расположение: орбита и место на ней зависят только от пути папки,
      // поэтому каждая папка всегда оказывается в одном и том же месте системы
      for (const p of auto) orbits[hashStr(p.path + '#orbit') % n].push(p);
      orbits.forEach((list, k) => {
        for (const p of list) {
          p.orbit = k;
          p.angle0 = (hashStr(p.path + '#angle') / 4294967296) * TAU;
        }
        // слегка раздвигаем соседей, которые иначе слиплись бы
        list.sort((a, b) => a.angle0 - b.angle0);
        const minGap = Math.min(0.45, (TAU / Math.max(1, list.length)) * 0.6);
        for (let i = 1; i < list.length; i++) {
          if (list[i].angle0 - list[i - 1].angle0 < minGap) list[i].angle0 = list[i - 1].angle0 + minGap;
        }
      });
    } else {
      if (s.distribution === 'name') auto.sort((a, b) => a.name.localeCompare(b.name));
      else if (s.distribution === 'size-out') auto.sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));
      else auto.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      const weights = orbits.map((_, i) => s.firstRadius + i * s.orbitGap);
      const total = weights.reduce((a, b) => a + b, 0);
      let acc = 0;
      const cum = weights.map((w) => (acc += w / total));
      auto.forEach((p, i) => {
        const f = (i + 0.5) / auto.length;
        let k = cum.findIndex((c) => f <= c);
        if (k < 0) k = n - 1;
        orbits[k].push(p);
      });
      orbits.forEach((list, k) => {
        const phase = (k * 2.399963) % TAU;
        list.forEach((p, i) => {
          p.orbit = k;
          p.angle0 = phase + (i / list.length) * TAU;
        });
      });
    }

    const centerRes = s.showRootFiles
      ? makeSats(cur, s.centerSize, false, !!s.centerFilesOrbit, 1)
      : { sats: [], more: 0 };
    const center = {
      kind: 'center', file: cur, path: cur.path,
      name: cur.isRoot() ? vault.getName() : cur.name,
      count: countFiles(cur), sats: centerRes.sats, more: centerRes.more,
      fileSats: centerRes.sats.filter((x) => x.kind === 'file'),
      spin: 1, sx: 0, sy: 0, ds: 1,
    };

    this.pings = [];
    const usedOrbits = new Set(planets.map((p) => p.orbit));
    this.scene = { planets, center, orbitCount: n, usedOrbits };
    this.accentRgb = hexToRgb(s.accent);
    this.renderCrumbs();
    if (!this.userView) this.fit();
  }

  renderCrumbs() {
    const el = this.crumbs;
    el.empty();
    const chain = [];
    let f = this.current;
    while (f) {
      chain.unshift(f);
      if (f === this.base) break;
      f = f.parent;
    }
    chain.forEach((folder, i) => {
      if (i > 0) el.createSpan({ cls: 'orbit-crumb-sep', text: '›' });
      const last = i === chain.length - 1;
      const name = folder.isRoot() ? this.app.vault.getName() : folder.name;
      const crumb = el.createSpan({ cls: 'orbit-crumb' + (last ? ' is-current' : ''), text: name });
      if (!last) crumb.addEventListener('click', () => this.setCurrent(folder.path));
    });
  }

  /* ----- drawing ----- */

  draw(now) {
    const s = this.plugin.settings;
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    const scene = this.scene;
    if (!w || !h || !scene) return;

    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const running = s.animate && !this.paused && !(s.pauseOnHover && this.hover);
    if (running) {
      this.tp += dt * s.speed * s.planetSpeed;
      this.tf += dt * s.speed * s.fileSpeed;
    }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBackground(ctx, w, h, dt);

    const k = easeOut(clamp((now - this.enterAt) / 650, 0, 1));
    const grow = 0.65 + 0.35 * k;
    const z = this.zoom;
    const cx = w / 2 + this.panX;
    const cy = h / 2 + this.panY;
    const rot = (s.rotation * Math.PI) / 180;
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    const tilt = s.tilt;
    const fg = this.fg;
    const dragging = this.drag && this.drag.moved;
    this.frame = { k, z, tilt, rot, cr, sr, now, hits: [], mouse: s.cursorFx && !dragging ? this.mouse : null };

    if (s.showOrbits) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(' + fg + ',' + s.orbitOpacity * k + ')';
      for (let i = 0; i < scene.orbitCount; i++) {
        // орбиту без единой папки не рисуем
        if (!scene.usedOrbits.has(i)) continue;
        const R = (s.firstRadius + i * s.orbitGap) * z * grow;
        ctx.beginPath();
        ctx.ellipse(cx, cy, R, Math.max(0.5, R * tilt), rot, 0, TAU);
        ctx.stroke();
      }
    }

    for (const p of scene.planets) {
      const R = s.firstRadius + p.orbit * s.orbitGap;
      const dir = s.alternate && p.orbit % 2 ? -1 : 1;
      const vary = 1 + s.speedSpread * (2 * p.v - 1);
      const a = p.angle0 + this.tp * 0.06 * dir * vary * Math.sqrt(s.firstRadius / R);
      const ex = Math.cos(a) * R * grow;
      const ey = Math.sin(a) * R * tilt * grow;
      p.sx = cx + (ex * cr - ey * sr) * z;
      p.sy = cy + (ex * sr + ey * cr) * z;
      p.depth = Math.sin(a);
      p.ds = 1 + 0.22 * p.depth * (1 - tilt);
      p.light = Math.atan2(cy - p.sy, cx - p.sx);
    }
    const order = scene.planets.slice().sort((a, b) => a.depth - b.depth);

    const c = scene.center;
    c.sx = cx;
    c.sy = cy;
    let i = 0;
    for (; i < order.length && order[i].depth < 0; i++) this.drawBody(ctx, order[i]);
    this.drawBody(ctx, c);
    for (; i < order.length; i++) this.drawBody(ctx, order[i]);

    if (!scene.planets.length && !c.sats.length) {
      ctx.font = '13px ' + this.font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(' + fg + ',0.5)';
      ctx.fillText(tr('No folders or files to show here', 'Здесь нет папок и файлов для отображения'), cx, cy + s.centerSize * z + 60);
    }

    this.drawComets(ctx, running ? dt : 0, cx, cy);
    this.drawPings(ctx, now);

    this.hits = this.frame.hits;
    if (this.mouse && !dragging) this.setHover(this.pick(this.mouse.x, this.mouse.y));
  }

  drawBackground(ctx, w, h, dt) {
    const s = this.plugin.settings;
    if (s.background === 'space') {
      if (!this.bgGrad) {
        const g = ctx.createRadialGradient(w / 2, h * 0.45, 0, w / 2, h * 0.45, Math.max(w, h) * 0.75);
        g.addColorStop(0, '#171a20');
        g.addColorStop(0.55, '#0d0f13');
        g.addColorStop(1, '#07080a');
        this.bgGrad = g;
      }
      ctx.fillStyle = this.bgGrad;
    } else {
      ctx.fillStyle = this.bgColor || '#ffffff';
    }
    ctx.fillRect(0, 0, w, h);

    const m = s.cursorFx ? this.mouse : null;

    if (s.nebulae) {
      const size = Math.max(w, h);
      for (const n of this.nebulae) {
        const x = n.x * w;
        const y = n.y * h;
        const rad = n.r * size;
        let target = 1;
        if (m) target = 1 + 1.7 * Math.max(0, 1 - Math.hypot(m.x - x, m.y - y) / (rad * 1.05));
        n.cur += (target - n.cur) * Math.min(1, dt * 3.5);
        const a = n.a * n.cur;
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, 'rgba(' + n.rgb + ',' + a + ')');
        g.addColorStop(0.5, 'rgba(' + n.rgb + ',' + a * 0.38 + ')');
        g.addColorStop(1, 'rgba(' + n.rgb + ',0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      }
    }

    if (s.stars) {
      for (const st of this.stars) {
        ctx.fillStyle = 'rgba(' + this.fg + ',' + st.a + ')';
        ctx.beginPath();
        ctx.arc(st.x * w, st.y * h, st.r, 0, TAU);
        ctx.fill();
      }
    }

    // вместо ровного пятна под курсором проступают отдельные клочья космической пыли:
    // у каждого своя яркость, размер и оттенок, поэтому свет получается неровным
    const size = Math.max(w, h);
    const lerp = Math.min(1, dt * 3);
    for (const d of this.dust) {
      const x = d.x * w;
      const y = d.y * h;
      let target = 0;
      if (m) {
        const near = 1 - Math.hypot(m.x - x, m.y - y) / 260;
        if (near > 0) target = near * near * d.gain;
      }
      d.cur += (target - d.cur) * lerp;
      if (d.cur < 0.01) continue;
      const rad = d.r * size;
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, 'rgba(' + d.rgb + ',' + 0.1 * d.cur + ')');
      g.addColorStop(0.5, 'rgba(' + d.rgb + ',' + 0.035 * d.cur + ')');
      g.addColorStop(1, 'rgba(' + d.rgb + ',0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
  }

  drawBody(ctx, p) {
    const s = this.plugin.settings;
    const f = this.frame;
    const { k, z, tilt, rot, cr, sr, hits, mouse } = f;
    const fg = this.fg;
    const acc = this.accentRgb;
    const isCenter = p.kind === 'center';
    const sc = z * (p.ds || 1);
    const hov = this.hover;
    const hovered = !!hov && hov.owner === p;
    // файлы вокруг папки подсвечиваются всей группой; файлы, летающие по орбитам
    // вокруг центра, — только ближайшие к курсору (см. drawSat)
    const groupLit = hovered;
    const sats = p.sats;
    const t = this.tf;

    // спутники движутся в плоскости эклиптики — той же, что и орбиты системы
    for (const sat of sats) {
      const a = sat.a + t * sat.w * (1 + s.speedSpread * (2 * sat.v - 1));
      const ex = Math.cos(a) * sat.d;
      const ey = Math.sin(a) * sat.d * tilt;
      sat.sx = p.sx + (ex * cr - ey * sr) * sc * k;
      sat.sy = p.sy + (ex * sr + ey * cr) * sc * k;
      sat.front = Math.sin(a) >= 0;
    }

    if (s.showLines && sats.length) {
      // лучи тоже гаснут к краю облака: рисуем их четырьмя группами по близости к папке
      ctx.lineWidth = 0.6;
      const BUCKETS = 4;
      for (let bi = 0; bi < BUCKETS; bi++) {
        ctx.beginPath();
        let any = false;
        for (const sat of sats) {
          if (sat.free) continue;
          if (Math.min(BUCKETS - 1, Math.floor(sat.near * BUCKETS)) !== bi) continue;
          ctx.moveTo(p.sx, p.sy);
          ctx.lineTo(sat.sx, sat.sy);
          any = true;
        }
        if (!any) continue;
        const fade = 0.3 + 0.7 * ((bi + 0.5) / BUCKETS);
        ctx.strokeStyle = groupLit
          ? 'rgba(' + acc + ',' + 0.4 * fade * k + ')'
          : 'rgba(' + fg + ',' + 0.16 * fade * k + ')';
        ctx.stroke();
      }
    }

    // у каждого файла своя видимая орбита — сколько файлов, столько орбит
    if (s.fileOrbits === 'all' || (s.fileOrbits === 'center' && isCenter)) {
      ctx.lineWidth = 0.7;
      for (const sat of sats) {
        if (!isCenter && sat.free) continue;
        const isHov = !!hov && hov.obj === sat;
        const R = sat.d * sc * k;
        if (R < 2) continue;
        const base = isCenter ? s.orbitOpacity * 0.5 : s.orbitOpacity * 0.28;
        ctx.strokeStyle = isHov ? 'rgba(' + acc + ',0.55)' : 'rgba(' + fg + ',' + base * k + ')';
        ctx.beginPath();
        ctx.ellipse(p.sx, p.sy, R, Math.max(0.5, R * tilt), rot, 0, TAU);
        ctx.stroke();
      }
    }

    const st = {
      dotScale: clamp(sc, 0.6, 2.2), hovered: groupLit, isCenter,
      lx: Math.cos(p.light || 0), ly: Math.sin(p.light || 0),
      ringTilt: Math.max(0.22, tilt * 0.7),
    };
    for (const sat of sats) if (!sat.front) this.drawSat(ctx, p, sat, st);

    const x = p.sx;
    const y = p.sy;
    let r;
    if (isCenter) {
      r = Math.max(10, s.centerSize * z * (0.7 + 0.3 * k));
      const on = hovered && hov.obj === p;
      if (s.centerStyle === 'ring') this.drawCenter(ctx, p, x, y, r, on);
      else this.drawStar(ctx, p, x, y, r, on, f.now);
    } else {
      r = Math.max(4, p.size * sc);
      let prox = 0;
      if (mouse && !hovered) {
        const d = Math.hypot(mouse.x - x, mouse.y - y);
        if (d < 130) prox = 1 - d / 130;
      }
      this.drawPlanet(ctx, p, x, y, r, hovered, prox, st);
    }

    for (const sat of sats) if (sat.front) this.drawSat(ctx, p, sat, st);

    const showLabel = isCenter || s.labels === 'always' || (s.labels === 'hover' && hovered);
    if (showLabel) {
      // подпись планеты: мелкая и полупрозрачная, растёт и светлеет рядом с курсором
      let near = hovered ? 1 : 0;
      const mm = this.mouse;
      if (!near && mm && !isCenter) {
        const d = Math.hypot(mm.x - x, mm.y - y);
        if (d < 150) near = easeOut(1 - d / 150);
      }
      ctx.font = (isCenter ? '600 13px ' : (9.5 + 4.5 * near).toFixed(1) + 'px ') + this.font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const alpha = isCenter ? 0.95 : 0.34 + 0.61 * near;
      ctx.fillStyle = 'rgba(' + fg + ',' + alpha * k + ')';
      const ly = y + r + (isCenter ? 12 : 7);
      ctx.fillText(p.name, x, ly);
      if (isCenter && s.centerStyle !== 'ring') {
        ctx.font = '11px ' + this.font;
        ctx.fillStyle = 'rgba(' + fg + ',' + 0.5 * k + ')';
        ctx.fillText(filesLabel(p.count), x, ly + 17);
      }
    }
    hits.push({ x, y, r: r + 4, obj: p, owner: p });
  }

  drawSat(ctx, p, sat, st) {
    const { k, hits, mouse } = this.frame;
    const acc = this.accentRgb;
    const hov = this.hover;
    const isHover = !!hov && hov.obj === sat;
    const x = sat.sx;
    const y = sat.sy;
    let r = Math.max(0.7, sat.r * st.dotScale);

    // свободные файлы центра не подсвечиваются всей группой — только рядом с курсором
    const group = st.hovered && !sat.free;
    let prox = 0;
    if (mouse && !group && !isHover) {
      const dx = mouse.x - x;
      const dy = mouse.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 5625) prox = 1 - Math.sqrt(d2) / 75;
    }
    r += prox * 1.2;
    const lit = group || isHover;
    const rgb = lit ? acc : sat.rgb || this.fg;
    const alpha = Math.min(1, lit ? Math.max(sat.alpha, 0.85) : sat.alpha + prox * 0.4) * k;

    // свет идёт от звезды в центре системы
    let lx = st.lx;
    let ly = st.ly;
    if (st.isCenter) {
      const dx = p.sx - x;
      const dy = p.sy - y;
      const d = Math.hypot(dx, dy) || 1;
      lx = dx / d;
      ly = dy / d;
    }

    if (r < 1.7) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fillStyle = 'rgba(' + rgb + ',' + alpha + ')';
      ctx.fill();
    } else {
      // ночная сторона и освещённый бок
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fillStyle = this.nodeFill;
      ctx.fill();
      ctx.fillStyle = 'rgba(' + rgb + ',' + alpha * (sat.free ? 0.62 : 0.4) + ')';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x + lx * r * 0.28, y + ly * r * 0.28, r * 0.68, 0, TAU);
      ctx.fillStyle = 'rgba(' + rgb + ',' + alpha + ')';
      ctx.fill();
    }

    // подпапки — спутники-луны без колец; обводка только у свежих файлов
    if (sat.kind !== 'folder' && sat.recent && !lit) {
      ctx.beginPath();
      ctx.arc(x, y, r + 2.2, 0, TAU);
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = 'rgba(' + acc + ',' + 0.7 * k + ')';
      ctx.stroke();
    }
    if (prox > 0) {
      ctx.beginPath();
      ctx.arc(x, y, r + 1.6, 0, TAU);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(' + acc + ',' + prox * 0.9 + ')';
      ctx.stroke();
    }
    if (isHover) {
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, TAU);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(' + acc + ',1)';
      ctx.stroke();
    }
    hits.push({ x, y, r: r + 4, obj: sat, owner: p });
  }

  drawPlanet(ctx, p, x, y, r, hovered, prox, st) {
    const s = this.plugin.settings;
    const { k, rot } = this.frame;
    const acc = this.accentRgb;
    const lx = st.lx;
    const ly = st.ly;

    const glowRgb = hovered ? acc : p.rgb;
    // тонкая атмосфера вместо яркого ореола: планеты не светятся сами, как звезда
    const glow = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 1.7);
    glow.addColorStop(0, 'rgba(' + glowRgb + ',' + (0.07 + 0.14 * prox + (hovered ? 0.16 : 0)) * k + ')');
    glow.addColorStop(1, 'rgba(' + glowRgb + ',0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.7, 0, TAU);
    ctx.fill();

    const ringed = p.ringed && r >= 7;
    const ringRgb = hovered ? acc : p.rgb;
    const ring = (from, to) => {
      ctx.lineWidth = Math.max(1, r * 0.16);
      ctx.strokeStyle = 'rgba(' + ringRgb + ',' + 0.55 * k + ')';
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.8, r * 1.8 * st.ringTilt, rot + p.ringRot, from, to);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(' + ringRgb + ',' + 0.3 * k + ')';
      ctx.beginPath();
      ctx.ellipse(x, y, r * 2.15, r * 2.15 * st.ringTilt, rot + p.ringRot, from, to);
      ctx.stroke();
    };
    if (ringed) ring(Math.PI, TAU);

    // шар, освещённый со стороны звезды
    ctx.globalAlpha = k;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = this.nodeFill;
    ctx.fill();
    const g = ctx.createRadialGradient(x + lx * r * 0.5, y + ly * r * 0.5, r * 0.05, x + lx * r * 0.12, y + ly * r * 0.12, r * 1.25);
    g.addColorStop(0, p.cLight);
    g.addColorStop(0.45, p.cMid);
    g.addColorStop(1, p.cDark);
    ctx.fillStyle = g;
    ctx.fill();

    if (p.bands && r >= 8) {
      ctx.save();
      ctx.clip();
      ctx.translate(x, y);
      ctx.rotate(rot + p.bandRot);
      for (const b of p.bands) {
        ctx.fillStyle = b.c;
        ctx.fillRect(-r, b.y * r, r * 2, b.h * r);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.lineWidth = hovered ? 1.8 : 1.1;
    ctx.strokeStyle = hovered ? 'rgba(' + acc + ',1)' : 'rgba(' + p.rgb + ',' + 0.7 * k + ')';
    ctx.stroke();
    if (prox > 0) {
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = 'rgba(' + acc + ',' + prox + ')';
      ctx.stroke();
    }

    if (ringed) ring(0, Math.PI);

    if (s.showIcons && r >= 6) {
      ctx.font = '600 ' + Math.round(r * 1.0) + 'px ' + this.font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(0,0,0,' + 0.55 * k + ')';
      ctx.fillText(p.icon, x + 0.8, y + r * 0.06 + 1);
      ctx.fillStyle = 'rgba(255,255,255,' + 0.95 * k + ')';
      ctx.fillText(p.icon, x, y + r * 0.06);
    }
    if (hovered) {
      ctx.beginPath();
      ctx.arc(x, y, r + 4.5, 0, TAU);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(' + acc + ',0.6)';
      ctx.stroke();
    }
  }

  drawStar(ctx, c, x, y, R, hovered, now) {
    const pulse = 1 + 0.05 * Math.sin(now / 900);
    const corona = ctx.createRadialGradient(x, y, R * 0.4, x, y, R * 3.4 * pulse);
    corona.addColorStop(0, 'rgba(255,214,130,0.55)');
    corona.addColorStop(0.22, 'rgba(255,170,70,0.22)');
    corona.addColorStop(0.6, 'rgba(255,120,60,0.06)');
    corona.addColorStop(1, 'rgba(255,120,60,0)');
    ctx.fillStyle = corona;
    ctx.beginPath();
    ctx.arc(x, y, R * 3.4 * pulse, 0, TAU);
    ctx.fill();

    const core = ctx.createRadialGradient(x - R * 0.25, y - R * 0.25, 0, x, y, R);
    core.addColorStop(0, '#fffdf2');
    core.addColorStop(0.5, '#ffe392');
    core.addColorStop(1, '#ffa93a');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, TAU);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,244,210,0.75)';
    ctx.stroke();

    if (hovered) {
      if (this.canGoUp() && R >= 12) {
        ctx.font = '600 ' + Math.round(R * 0.9) + 'px ' + this.font;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(70,40,0,0.8)';
        ctx.fillText('↑', x, y + 1);
      }
      ctx.beginPath();
      ctx.arc(x, y, R + 5, 0, TAU);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(' + this.accentRgb + ',1)';
      ctx.stroke();
    }
  }

  drawCenter(ctx, c, x, y, R, hovered) {
    const fg = this.fg;
    const lw = R * 0.42;
    const rr = R - lw / 2;

    const glow = ctx.createRadialGradient(x, y, R * 0.6, x, y, R * 2.8);
    glow.addColorStop(0, 'rgba(' + fg + ',0.10)');
    glow.addColorStop(1, 'rgba(' + fg + ',0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, R * 2.8, 0, TAU);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, R - lw, 0, TAU);
    ctx.fillStyle = this.nodeFill;
    ctx.fill();

    const g = ctx.createLinearGradient(x - R, y - R, x + R, y + R);
    g.addColorStop(0, '#eef2f7');
    g.addColorStop(0.2, '#8e98a8');
    g.addColorStop(0.42, '#20242b');
    g.addColorStop(0.58, '#39414d');
    g.addColorStop(0.72, '#4f8f8a');
    g.addColorStop(0.84, '#7d68a6');
    g.addColorStop(1, '#dfe6ee');
    ctx.lineWidth = lw;
    ctx.strokeStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, TAU);
    ctx.stroke();

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath();
    ctx.arc(x, y, R - 0.5, -2.7, -0.7);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.arc(x, y, R - lw + 0.5, 0.5, 2.5);
    ctx.stroke();

    if (R >= 16) {
      const up = hovered && this.canGoUp();
      ctx.font = '600 ' + Math.round(R * (up ? 0.5 : 0.3)) + 'px ' + this.font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(' + fg + ',0.85)';
      ctx.fillText(up ? '↑' : shortCount(c.count), x, y + 1);
    }
    if (hovered) {
      ctx.beginPath();
      ctx.arc(x, y, R + 4, 0, TAU);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(' + this.accentRgb + ',1)';
      ctx.stroke();
    }
  }

  /* ----- comets ----- */

  spawnComet() {
    const s = this.plugin.settings;
    const rRef = (s.firstRadius + (Math.max(1, s.orbitCount) - 1) * s.orbitGap) * 1.5 + 260;
    // траектория должна начинаться и заканчиваться за краем окна при любом масштабе и сдвиге
    const z = this.zoom;
    const tilt = Math.max(s.tilt, 0.15);
    const rot = (s.rotation * Math.PI) / 180;
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    const cx = this.w / 2 + this.panX;
    const cy = this.h / 2 + this.panY;
    const corner = Math.hypot(Math.max(cx, this.w - cx), Math.max(cy, this.h - cy));
    const rOut = Math.max(rRef, (corner / (z * tilt)) * 1.15);
    // параболическая траектория в плоскости эклиптики: q — расстояние в перигелии
    const q = s.centerSize + 30 + Math.random() * s.firstRadius;
    const th0 = Math.acos(clamp((2 * q) / rOut - 1, -1, 1));
    const dir = Math.random() < 0.5 ? -1 : 1;
    const om = Math.random() * TAU;
    const M = 40;
    const visible = (th) => {
      const r = (2 * q) / (1 + Math.cos(th));
      const a = dir * th + om;
      const wx = r * Math.cos(a);
      const wy = r * Math.sin(a);
      const sx = cx + (wx * cr - wy * s.tilt * sr) * z;
      const sy = cy + (wx * sr + wy * s.tilt * cr) * z;
      return sx > -M && sx < this.w + M && sy > -M && sy < this.h + M;
    };
    // стартуем там, где комета вот-вот пересечёт край окна
    let start = null;
    for (let th = -th0; th < 0; th += 0.003) {
      if (visible(th)) {
        start = th - 0.003;
        break;
      }
    }
    if (start === null) return; // траектория не проходит через окно
    this.comets.push({
      q, th0, rRef, dir, om,
      th: Math.max(-th0, start),
      v: 230 + Math.random() * 110,
      size: 1.5 + Math.random() * 1.1,
      trail: [], done: false, age: 0,
    });
  }

  drawComets(ctx, dt, cx, cy) {
    const s = this.plugin.settings;
    if (!s.comets) {
      this.comets.length = 0;
      return;
    }
    const { z, tilt, cr, sr, now, k } = this.frame;
    if (now >= this.nextComet) {
      if (now - this.nextComet < 5000 && this.comets.length < 2) this.spawnComet();
      this.nextComet = now + s.cometInterval * 1000 * (0.6 + 0.8 * Math.random());
    }
    const FADE = 9; // секунд живёт след
    const rgb = '200,232,255';
    const px = (x, y) => cx + (x * cr - y * tilt * sr) * z;
    const py = (x, y) => cy + (x * sr + y * tilt * cr) * z;

    for (let i = this.comets.length - 1; i >= 0; i--) {
      const c = this.comets[i];
      c.age += dt;
      let r = 0;
      let wx = 0;
      let wy = 0;
      if (!c.done) {
        // у Солнца комета летит быстрее
        r = (2 * c.q) / (1 + Math.cos(c.th));
        const v = c.v * Math.sqrt(clamp(140 / r, 0.12, 2.2));
        c.th += (dt * v * Math.cos(c.th / 2)) / r;
        if (c.th >= c.th0) {
          c.th = c.th0;
          c.done = true;
        }
        r = (2 * c.q) / (1 + Math.cos(c.th));
        const a = c.dir * c.th + c.om;
        wx = r * Math.cos(a);
        wy = r * Math.sin(a);
        // после перигелия комета летит, пока не скроется за краем окна
        if (c.th > 0) {
          const sx = px(wx, wy);
          const sy = py(wx, wy);
          if (sx < -60 || sx > this.w + 60 || sy < -60 || sy > this.h + 60) c.done = true;
        }
        const last = c.trail[c.trail.length - 1];
        if (!last || Math.hypot(wx - last.x, wy - last.y) > 7) c.trail.push({ x: wx, y: wy, t: c.age });
      }
      while (c.trail.length && c.age - c.trail[0].t > FADE) c.trail.shift();
      if (c.done && !c.trail.length) {
        this.comets.splice(i, 1);
        continue;
      }

      // след — пройденный участок орбиты, постепенно гаснет
      ctx.lineWidth = 1;
      const tr = c.trail;
      for (let j = 1; j < tr.length; j++) {
        const a0 = tr[j - 1];
        const a1 = tr[j];
        ctx.beginPath();
        ctx.moveTo(px(a0.x, a0.y), py(a0.x, a0.y));
        ctx.lineTo(px(a1.x, a1.y), py(a1.x, a1.y));
        ctx.strokeStyle = 'rgba(' + rgb + ',' + (1 - (c.age - a1.t) / FADE) * 0.42 * k + ')';
        ctx.stroke();
      }
      if (c.done) continue;

      const hx = px(wx, wy);
      const hy = py(wx, wy);
      if (tr.length) {
        const l = tr[tr.length - 1];
        ctx.beginPath();
        ctx.moveTo(px(l.x, l.y), py(l.x, l.y));
        ctx.lineTo(hx, hy);
        ctx.strokeStyle = 'rgba(' + rgb + ',' + 0.42 * k + ')';
        ctx.stroke();
      }

      // чем ближе к Солнцу, тем ярче голова и длиннее хвост; хвост направлен от Солнца
      const near = clamp(1 - (r - c.q) / (c.rRef * 0.55), 0, 1);
      const b = near * near;
      const dx = hx - cx;
      const dy = hy - cy;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d;
      const uy = dy / d;
      const zf = clamp(z, 0.5, 1.6);
      const len = (16 + 150 * b) * zf;
      const wid = c.size * (1 + 1.5 * b) * zf;
      const alpha = (0.3 + 0.7 * b) * k;
      const tx = hx + ux * len;
      const ty = hy + uy * len;
      const g = ctx.createLinearGradient(hx, hy, tx, ty);
      g.addColorStop(0, 'rgba(' + rgb + ',' + alpha * 0.8 + ')');
      g.addColorStop(0.4, 'rgba(' + rgb + ',' + alpha * 0.25 + ')');
      g.addColorStop(1, 'rgba(' + rgb + ',0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(hx - uy * wid, hy + ux * wid);
      ctx.lineTo(tx, ty);
      ctx.lineTo(hx + uy * wid, hy - ux * wid);
      ctx.closePath();
      ctx.fill();

      const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, wid * 4.5);
      halo.addColorStop(0, 'rgba(' + rgb + ',' + alpha * 0.7 + ')');
      halo.addColorStop(1, 'rgba(' + rgb + ',0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(hx, hy, wid * 4.5, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,' + Math.min(1, alpha + 0.25) + ')';
      ctx.beginPath();
      ctx.arc(hx, hy, wid, 0, TAU);
      ctx.fill();
    }
  }

  /* ----- signals ----- */

  // независимые «передатчики»: у каждого своя частота и размер волны
  makeChannels(count, now) {
    this.channels = [];
    for (let i = 0; i < count; i++) {
      const f = count > 1 ? i / (count - 1) : 0.4;
      this.channels.push({
        m: 0.7 + 0.9 * f, // множитель интервала: первые чаще, последние реже
        dur: 1300 + 900 * f,
        rings: 1,
        reach: 11 + 9 * f,
        next: now + 800 + Math.random() * 2500,
      });
    }
  }

  spawnPing(now, ch) {
    const scene = this.scene;
    const bodies = [scene.center].concat(scene.planets).filter((b) => b.fileSats && b.fileSats.length);
    if (!bodies.length) return;
    for (let tries = 0; tries < 6; tries++) {
      const b = bodies[Math.floor(Math.random() * bodies.length)];
      const sat = b.fileSats[Math.floor(Math.random() * b.fileSats.length)];
      if (sat.sx > 0 && sat.sx < this.w && sat.sy > 0 && sat.sy < this.h) {
        this.pings.push({ sat, start: now, ch });
        return;
      }
    }
  }

  drawPings(ctx, now) {
    const s = this.plugin.settings;
    if (!s.signals) {
      this.pings.length = 0;
      return;
    }
    const count = clamp(Math.round(s.signalCount), 1, 20);
    if (this.channels.length !== count) this.makeChannels(count, now);
    for (const ch of this.channels) {
      if (now < ch.next) continue;
      if (now - ch.next < 5000) this.spawnPing(now, ch);
      ch.next = now + s.signalInterval * ch.m * 1000 * (0.6 + 0.8 * Math.random());
    }
    const zf = clamp(this.zoom, 0.7, 1.6);
    ctx.lineWidth = 1.1;
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const ping = this.pings[i];
      const ch = ping.ch;
      const age = (now - ping.start) / ch.dur;
      if (age >= 1) {
        this.pings.splice(i, 1);
        continue;
      }
      const gap = 0.6 / ch.rings;
      for (let j = 0; j < ch.rings; j++) {
        const a = (age - j * gap) / (1 - j * gap);
        if (a <= 0) continue;
        ctx.beginPath();
        ctx.arc(ping.sat.sx, ping.sat.sy, 3 + easeOut(a) * ch.reach * zf, 0, TAU);
        ctx.strokeStyle = 'rgba(' + this.accentRgb + ',' + (1 - a) * 0.75 + ')';
        ctx.stroke();
      }
    }
  }

  /* ----- interaction ----- */

  localPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  pick(x, y) {
    const hits = this.hits;
    for (let i = hits.length - 1; i >= 0; i--) {
      const hit = hits[i];
      const dx = x - hit.x;
      const dy = y - hit.y;
      if (dx * dx + dy * dy <= hit.r * hit.r) return hit;
    }
    return null;
  }

  setHover(hit) {
    const changed = (hit && hit.obj) !== (this.hover && this.hover.obj);
    this.hover = hit;
    if (!this.canvas) return;
    this.canvas.toggleClass('is-pointer', !!hit);
    const tip = this.tip;
    if (!hit || !this.mouse) {
      tip.removeClass('is-visible');
      return;
    }
    if (changed) this.fillTip(hit.obj);
    tip.addClass('is-visible');
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = this.mouse.x + 14;
    let top = this.mouse.y + 16;
    if (left + tw > this.w - 8) left = this.mouse.x - tw - 10;
    if (top + th > this.h - 8) top = this.mouse.y - th - 10;
    tip.setCssProps({ '--orbit-tip-x': Math.max(4, left) + 'px', '--orbit-tip-y': Math.max(4, top) + 'px' });
  }

  fillTip(obj) {
    const tip = this.tip;
    tip.empty();
    const file = obj.file;
    if (obj.kind === 'file') {
      tip.createDiv({ cls: 'orbit-tip-title', text: file.name });
      if (file.parent && !file.parent.isRoot()) tip.createDiv({ cls: 'orbit-tip-sub', text: file.parent.path });
      if (file.stat && file.stat.mtime) {
        const date = new Date(file.stat.mtime).toLocaleDateString();
        tip.createDiv({ cls: 'orbit-tip-sub', text: tr('Modified: ', 'Изменён: ') + date });
      }
      return;
    }
    tip.createDiv({ cls: 'orbit-tip-title', text: obj.kind === 'center' ? obj.name : file.name });
    tip.createDiv({ cls: 'orbit-tip-sub', text: filesLabel(obj.count || 0) });
    if (obj.more > 0) tip.createDiv({ cls: 'orbit-tip-sub', text: tr('Not shown: ', 'Не показано точек: ') + obj.more });
    if (obj.kind === 'center') {
      if (this.canGoUp()) tip.createDiv({ cls: 'orbit-tip-sub', text: tr('Click to go up a level', 'Клик — на уровень выше') });
    } else {
      tip.createDiv({ cls: 'orbit-tip-sub', text: tr('Click to enter this folder', 'Клик — открыть орбиту папки') });
    }
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    const p = this.localPos(e);
    this.drag = { x: p.x, y: p.y, panX: this.panX, panY: this.panY, moved: false };
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
  }

  onPointerMove(e) {
    const p = this.localPos(e);
    this.mouse = p;
    const d = this.drag;
    if (d) {
      const dx = p.x - d.x;
      const dy = p.y - d.y;
      if (!d.moved && dx * dx + dy * dy > 16) {
        d.moved = true;
        this.setHover(null);
        this.canvas.addClass('is-grabbing');
      }
      if (d.moved) {
        this.panX = d.panX + dx;
        this.panY = d.panY + dy;
        this.userView = true;
      }
      return;
    }
    this.setHover(this.pick(p.x, p.y));
  }

  onPointerUp(e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    this.canvas.removeClass('is-grabbing');
    if (d.moved) return;
    const p = this.localPos(e);
    const hit = this.pick(p.x, p.y);
    if (hit) this.activate(hit.obj, e);
  }

  onWheel(e) {
    e.preventDefault();
    const p = this.localPos(e);
    const nz = clamp(this.zoom * Math.exp(-e.deltaY * 0.0015), 0.12, 6);
    const f = nz / this.zoom;
    const mx = p.x - this.w / 2 - this.panX;
    const my = p.y - this.h / 2 - this.panY;
    this.panX -= mx * (f - 1);
    this.panY -= my * (f - 1);
    this.zoom = nz;
    this.userView = true;
  }

  activate(obj, e) {
    if (obj.kind === 'file') {
      this.openFile(obj.file, this.plugin.settings.openInNewTab || !!(e && (e.ctrlKey || e.metaKey)));
    } else if (obj.kind === 'center') {
      if (this.canGoUp()) this.setCurrent(this.current.parent.path);
    } else {
      this.setCurrent(obj.file.path);
    }
  }

  async openFile(file, newTab) {
    await this.app.workspace.getLeaf(newTab ? 'tab' : false).openFile(file);
  }

  onContextMenu(e) {
    e.preventDefault();
    const p = this.localPos(e);
    const hit = this.pick(p.x, p.y);
    const menu = new Menu();
    const obj = hit && hit.obj;
    if (obj && obj.kind === 'file') {
      menu.addItem((i) => i.setTitle(tr('Open', 'Открыть')).setIcon('file').onClick(() => this.openFile(obj.file, false)));
      menu.addItem((i) =>
        i.setTitle(tr('Open in new tab', 'Открыть в новой вкладке')).setIcon('file-plus').onClick(() => this.openFile(obj.file, true))
      );
      menu.addSeparator();
      this.app.workspace.trigger('file-menu', menu, obj.file, 'orbit-folders');
    } else if (obj && obj.kind !== 'center') {
      const path = obj.file.path;
      menu.addItem((i) => i.setTitle(tr('Enter folder', 'Открыть орбиту папки')).setIcon('log-in').onClick(() => this.setCurrent(path)));
      menu.addItem((i) =>
        i
          .setTitle(tr('Customize appearance…', 'Настроить отображение…'))
          .setIcon('palette')
          .onClick(() => new FolderModal(this.app, this.plugin, path).open())
      );
      menu.addItem((i) =>
        i.setTitle(tr('Hide folder', 'Скрыть папку')).setIcon('eye-off').onClick(() => this.plugin.setFolderCfg(path, { hidden: true }))
      );
      menu.addSeparator();
      this.app.workspace.trigger('file-menu', menu, obj.file, 'orbit-folders');
    } else {
      if (this.canGoUp()) {
        menu.addItem((i) =>
          i.setTitle(tr('Go up a level', 'На уровень выше')).setIcon('arrow-up').onClick(() => this.setCurrent(this.current.parent.path))
        );
      }
      menu.addItem((i) => i.setTitle(tr('Fit to view', 'Вписать в окно')).setIcon('maximize').onClick(() => this.fit()));
      menu.addItem((i) => i.setTitle(tr('Open settings', 'Открыть настройки')).setIcon('settings').onClick(() => this.plugin.openSettings()));
    }
    menu.showAtMouseEvent(e);
  }
}

/* ---------- per-folder modal ---------- */

class FolderModal extends Modal {
  constructor(app, plugin, path, onDone) {
    super(app);
    this.plugin = plugin;
    this.path = path;
    this.onDone = onDone;
  }

  onOpen() {
    const { contentEl, plugin, path } = this;
    const s = plugin.settings;
    const cfg = plugin.folderCfg(path);
    contentEl.empty();
    this.titleEl.setText(tr('Folder: ', 'Папка: ') + path);

    new Setting(contentEl)
      .setName(tr('Show on orbits', 'Показывать на орбитах'))
      .addToggle((t) => t.setValue(!cfg.hidden).onChange((v) => plugin.setFolderCfg(path, { hidden: !v })));

    new Setting(contentEl)
      .setName(tr('Color', 'Цвет'))
      .setDesc(tr('Color of the planet and its glow.', 'Цвет планеты и её свечения.'))
      .addColorPicker((c) => c.setValue(cfg.color || defaultColor(path)).onChange((v) => plugin.setFolderCfg(path, { color: v })));

    new Setting(contentEl)
      .setName(tr('Icon', 'Значок'))
      .setDesc(
        tr(
          'An emoji or one or two characters shown on the planet. Leave empty to use the first letter of the name.',
          'Эмодзи или 1–2 символа на планете. Пусто — первая буква названия.'
        )
      )
      .addText((t) =>
        t
          .setPlaceholder('🧠')
          .setValue(cfg.icon || '')
          .onChange((v) => plugin.setFolderCfg(path, { icon: Array.from(v.trim()).slice(0, 2).join('') }))
      );

    new Setting(contentEl)
      .setName(tr('Orbit', 'Орбита'))
      .setDesc(tr('Pin the folder to a specific orbit. Orbit 1 is closest to the center.', 'Закрепить папку на конкретной орбите (1 — ближайшая к центру).'))
      .addDropdown((d) => {
        d.addOption('0', tr('Automatic', 'Автоматически'));
        for (let i = 1; i <= s.orbitCount; i++) d.addOption(String(i), tr('Orbit ', 'Орбита ') + i);
        d.setValue(String(cfg.orbit || 0)).onChange((v) => plugin.setFolderCfg(path, { orbit: parseInt(v, 10) || 0 }));
      });

    new Setting(contentEl).addButton((b) =>
      b.setButtonText(tr('Reset folder customization', 'Сбросить настройки папки')).onClick(() => {
        delete s.folders[path];
        plugin.saveSettings();
        this.close();
      })
    );
  }

  onClose() {
    this.contentEl.empty();
    if (this.onDone) this.onDone();
  }
}

/* ---------- settings tab ---------- */

class OrbitSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const el = this.containerEl;
    const plugin = this.plugin;
    const s = plugin.settings;
    el.empty();

    const heading = (name) => new Setting(el).setName(name).setHeading();
    const toggle = (name, desc, key) =>
      new Setting(el).setName(name).setDesc(desc).addToggle((t) =>
        t.setValue(!!s[key]).onChange((v) => {
          s[key] = v;
          plugin.saveSettings();
        })
      );
    const slider = (name, desc, key, min, max, step) =>
      new Setting(el).setName(name).setDesc(desc).addSlider((sl) =>
        sl
          .setLimits(min, max, step)
          .setValue(s[key])
          .setDynamicTooltip()
          .onChange((v) => {
            s[key] = v;
            plugin.saveSettings();
          })
      );
    const dropdown = (name, desc, key, options, after) =>
      new Setting(el).setName(name).setDesc(desc).addDropdown((d) => {
        for (const k of Object.keys(options)) d.addOption(k, options[k]);
        d.setValue(s[key]).onChange((v) => {
          s[key] = v;
          plugin.saveSettings();
          if (after) after();
        });
      });

    // general settings: no heading
    dropdown(
      tr('Language', 'Язык'),
      tr(
        'Interface language of the plugin. The ribbon icon tooltip and command name update after Obsidian restarts.',
        'Язык интерфейса плагина. Подсказка значка на панели и название команды обновятся после перезапуска Obsidian.'
      ),
      'language',
      { auto: tr('Same as Obsidian', 'Как в Obsidian'), en: 'English', ru: 'Русский' },
      () => this.display()
    );
    new Setting(el)
      .setName(tr('Root folder', 'Корневая папка'))
      .setDesc(tr('Folder that becomes the center of the system. Leave empty to use the whole vault.', 'Папка, которая станет центром системы. Пусто — всё хранилище.'))
      .addText((t) =>
        t
          .setPlaceholder(tr('Example: Projects', 'Например: Проекты'))
          .setValue(s.rootPath)
          .onChange((v) => {
            s.rootPath = cleanPath(v);
            plugin.saveSettings();
          })
      );
    new Setting(el)
      .setName(tr('Excluded folders', 'Исключённые папки'))
      .setDesc(tr('Folders to hide and leave out of file counts. One path per line.', 'Папки, которые не нужно показывать и учитывать. По одному пути на строку.'))
      .addTextArea((t) => {
        t.setPlaceholder(tr('Templates\nArchive/Old', 'Шаблоны\nАрхив/Старое'))
          .setValue(s.excluded)
          .onChange((v) => {
            s.excluded = v;
            plugin.saveSettings();
          });
        t.inputEl.rows = 4;
      });
    toggle(tr('Hide empty folders', 'Скрывать пустые папки'), tr('Don’t show folders that contain no files.', 'Не показывать папки, в которых нет ни одного файла.'), 'hideEmpty');

    heading(tr('Orbits', 'Орбиты'));
    slider(tr('Number of orbits', 'Количество орбит'), '', 'orbitCount', 1, 10, 1);
    slider(tr('First orbit radius', 'Радиус первой орбиты'), tr('Distance from the center to the nearest orbit.', 'Расстояние от центра до ближайшей орбиты.'), 'firstRadius', 60, 500, 10);
    slider(tr('Orbit spacing', 'Расстояние между орбитами'), '', 'orbitGap', 30, 300, 5);
    slider(
      tr('Tilt', 'Наклон'),
      tr('1 is a top-down view with circular orbits. Lower values flatten orbits into ellipses.', '1 — вид сверху (круги), меньше — орбиты сплющиваются в эллипсы.'),
      'tilt', 0.15, 1, 0.01
    );
    slider(tr('Rotation', 'Поворот системы'), tr('Rotation of the ellipses, in degrees.', 'Угол поворота эллипсов, в градусах.'), 'rotation', -45, 45, 1);
    toggle(tr('Show orbit lines', 'Линии орбит'), tr('Draw the orbits themselves. Orbits without folders are never drawn.', 'Рисовать сами орбиты. Орбиты без папок не рисуются.'), 'showOrbits');
    slider(tr('Orbit line opacity', 'Яркость линий орбит'), '', 'orbitOpacity', 0.02, 0.6, 0.02);
    toggle(
      tr('Stable layout', 'Постоянное расположение'),
      tr(
        'Each folder’s orbit and position depend only on its path, so folders always stay in the same place. Turn off to arrange folders by the rule below.',
        'Орбита и место каждой папки зависят только от её пути, поэтому папки всегда на своих местах. Если выключить — папки раскладываются по правилу ниже.'
      ),
      'stableLayout'
    );
    dropdown(
      tr('Folder arrangement', 'Распределение папок по орбитам'),
      tr('Used when stable layout is off. Folders pinned to an orbit stay on it.', 'Работает, когда постоянное расположение выключено. Папки с орбитой, заданной вручную, остаются на своей.'),
      'distribution',
      {
        size: tr('Larger folders closer to the center', 'Крупные ближе к центру'),
        'size-out': tr('Larger folders farther out', 'Крупные дальше от центра'),
        name: tr('Alphabetical', 'По алфавиту'),
      }
    );

    heading(tr('Motion', 'Движение'));
    toggle(tr('Animate', 'Анимация'), tr('Folders and files move along their orbits.', 'Папки и файлы движутся по орбитам.'), 'animate');
    slider(tr('Overall speed', 'Общая скорость'), tr('Multiplier for all motion.', 'Множитель для всего движения.'), 'speed', 0.1, 5, 0.1);
    slider(tr('Folder speed', 'Скорость папок'), tr('How fast folders travel along the system’s orbits.', 'Как быстро папки-планеты идут по орбитам системы.'), 'planetSpeed', 0, 5, 0.1);
    slider(tr('File speed', 'Скорость файлов'), tr('How fast files circle their folders and the star.', 'Как быстро файлы обращаются вокруг своих папок и звезды.'), 'fileSpeed', 0, 5, 0.1);
    slider(
      tr('Speed variation', 'Разброс скорости'),
      tr(
        'How much each folder and file differs from the average speed of its kind, so some overtake others. 0 makes them all equal.',
        'Насколько скорость каждой папки и файла отличается от средней для их типа: одни чуть обгоняют, другие отстают. 0 — все одинаково.'
      ),
      'speedSpread', 0, 0.6, 0.05
    );
    toggle(tr('Alternate direction', 'Чередовать направление'), tr('Neighboring orbits turn in opposite directions.', 'Соседние орбиты вращаются в разные стороны.'), 'alternate');
    toggle(tr('Pause on hover', 'Пауза при наведении'), tr('Stop motion while the pointer is over a folder or file.', 'Останавливать движение, пока курсор над папкой или файлом.'), 'pauseOnHover');

    heading(tr('Folders', 'Папки'));
    slider(tr('Planet size', 'Размер узла папки'), '', 'nodeSize', 6, 40, 1);
    toggle(tr('Size by file count', 'Размер по количеству файлов'), tr('Folders with more files are drawn larger.', 'Чем больше файлов в папке, тем крупнее узел.'), 'scaleBySize');
    dropdown(
      tr('Folder labels', 'Подписи папок'),
      tr('Small translucent label under the planet that grows and brightens near the pointer.', 'Подпись под планетой мелкая и полупрозрачная, рядом с курсором растёт и светлеет.'),
      'labels',
      { always: tr('Always', 'Всегда'), hover: tr('On hover only', 'Только при наведении'), never: tr('Never', 'Никогда') }
    );
    toggle(tr('Icons on planets', 'Значки на планетах'), tr('A letter or emoji on top of each planet.', 'Буква или эмодзи поверх планеты.'), 'showIcons');
    dropdown(tr('Center style', 'Центр системы'), '', 'centerStyle', { star: tr('Star', 'Звезда'), ring: tr('Glass ring', 'Стеклянное кольцо') });
    slider(tr('Center size', 'Размер центра'), '', 'centerSize', 14, 90, 1);

    heading(tr('Files', 'Файлы'));
    toggle(tr('Show files', 'Показывать файлы'), tr('Files are dots scattered around their folder.', 'Файлы — точки, разлетающиеся вокруг папки.'), 'showFiles');
    toggle(tr('Show subfolders', 'Показывать подпапки'), tr('Subfolders appear as moons among the files. Click one to open it.', 'Подпапки — луны среди файлов, по клику открываются.'), 'showSubfolders');
    toggle(tr('Include files from subfolders', 'Файлы из подпапок'), tr('Add dots for files in all nested folders.', 'Добавлять к папке точки файлов из всех вложенных папок.'), 'recursiveFiles');
    toggle(tr('Files of the current folder', 'Файлы текущей папки'), tr('Show files that sit directly in the current folder around the center.', 'Показывать вокруг центра файлы, лежащие прямо в текущей папке.'), 'showRootFiles');
    toggle(
      tr('Center files orbit the star', 'Файлы центра летают по орбитам'),
      tr('Files of the current folder circle the star across the whole system instead of clustering next to it.', 'Файлы текущей папки сами обращаются вокруг звезды, а не висят облаком возле неё.'),
      'centerFilesOrbit'
    );
    dropdown(
      tr('File orbits', 'Орбиты файлов'),
      tr('Each file gets its own visible orbit line, regardless of the number of folder orbits.', 'У каждого файла своя видимая линия орбиты, независимо от количества орбит папок.'),
      'fileOrbits',
      {
        center: tr('Around the star only', 'Только вокруг звезды'),
        all: tr('Everywhere, including around folders', 'Везде, и вокруг папок'),
        none: tr('Hidden', 'Не показывать'),
      }
    );
    slider(tr('Maximum dots per folder', 'Максимум точек на папку'), tr('When a folder has more files, the most recent ones are shown.', 'Если файлов больше, остаются самые свежие.'), 'maxSatellites', 0, 300, 5);
    slider(tr('Spread', 'Разлёт точек'), tr('Radius of the file cloud around a folder.', 'Радиус облака файлов вокруг папки.'), 'burstRadius', 20, 220, 5);
    toggle(tr('Rays to files', 'Лучи к файлам'), tr('Thin lines from a folder to its files.', 'Тонкие линии от папки к её файлам.'), 'showLines');
    toggle(tr('Color by file type', 'Цвет по типу файла'), tr('Tint images, PDFs, media and other attachments.', 'Картинки, PDF, медиа и прочие вложения подкрашиваются.'), 'colorByType');
    slider(
      tr('Highlight recent files', 'Подсветка свежих файлов'),
      tr('Outline files changed in the last N days. 0 turns it off.', 'Обводить файлы, изменённые за последние N дней. 0 — выключить.'),
      'highlightRecentDays', 0, 30, 1
    );
    toggle(
      tr('Open files in a new tab', 'Открывать файлы в новой вкладке'),
      tr('Otherwise files open in the current tab. Ctrl+click always opens a new tab.', 'Иначе — в текущей (Ctrl+клик всегда открывает в новой).'),
      'openInNewTab'
    );

    heading(tr('Appearance', 'Оформление'));
    dropdown(tr('Background', 'Фон'), '', 'background', { space: tr('Space (dark)', 'Космос (тёмный)'), theme: tr('Match Obsidian theme', 'Как в теме Obsidian') });
    toggle(tr('Stars', 'Звёзды'), tr('Small dots in the background.', 'Мелкие точки на фоне.'), 'stars');
    toggle(tr('Nebulae', 'Туманности'), tr('Colored clouds in the background.', 'Цветные облака на заднем фоне.'), 'nebulae');
    toggle(
      tr('Pointer effects', 'Реакция на курсор'),
      tr('Nebulae brighten and nearby planets and files light up near the pointer.', 'Туманности светлеют, а планеты и файлы рядом с курсором подсвечиваются.'),
      'cursorFx'
    );
    new Setting(el)
      .setName(tr('Accent color', 'Акцентный цвет'))
      .setDesc(tr('Hover outlines, subfolders, recent files and signals.', 'Обводка при наведении, подпапки, свежие файлы и сигналы.'))
      .addColorPicker((c) =>
        c.setValue(s.accent).onChange((v) => {
          s.accent = v;
          plugin.saveSettings();
        })
      );

    heading(tr('Effects', 'Эффекты'));
    toggle(tr('Signals', 'Сигналы'), tr('Small waves ripple out from random files.', 'От случайных файлов расходится небольшая волна.'), 'signals');
    slider(
      tr('Signal sources', 'Количество сигналов'),
      tr('How many sources send signals at once. Each has its own rate and wave size.', 'Сколько источников подают сигналы одновременно. У каждого своя частота и размер волны.'),
      'signalCount', 1, 20, 1
    );
    slider(
      tr('Signal interval', 'Частота сигналов'),
      tr('Average seconds between signals from one source. Lower means more often.', 'Средний интервал между сигналами одного источника, в секундах. Меньше — чаще.'),
      'signalInterval', 0.5, 30, 0.5
    );
    toggle(
      tr('Comets', 'Кометы'),
      tr(
        'Now and then a comet flies through the system. It brightens near the star, grows a longer tail and leaves a fading trail.',
        'Иногда через систему пролетает комета: у звезды она ярче, хвост длиннее, за ней остаётся гаснущий след.'
      ),
      'comets'
    );
    slider(tr('Comet interval', 'Интервал комет'), tr('Average seconds between comets.', 'Среднее время между кометами, в секундах.'), 'cometInterval', 5, 120, 5);

    heading(tr('Individual folders', 'Отдельные папки'));
    const base = (() => {
      const f = s.rootPath ? this.app.vault.getAbstractFileByPath(cleanPath(s.rootPath)) : null;
      return f instanceof TFolder ? f : this.app.vault.getRoot();
    })();
    const paths = new Set(Object.keys(s.folders));
    for (const ch of base.children) if (ch instanceof TFolder) paths.add(ch.path);
    const sorted = Array.from(paths).sort((a, b) => a.localeCompare(b));
    if (!sorted.length) el.createEl('p', { cls: 'setting-item-description', text: tr('No folders yet.', 'Папок пока нет.') });
    for (const path of sorted) {
      const cfg = plugin.folderCfg(path);
      const row = new Setting(el);
      row.settingEl.addClass('orbit-settings-folder');
      const sw = row.nameEl.createSpan({ cls: 'orbit-swatch' });
      sw.setCssProps({ '--orbit-swatch-color': cfg.color || defaultColor(path) });
      row.nameEl.createSpan({ text: (cfg.icon ? cfg.icon + ' ' : '') + path });
      if (cfg.orbit) row.setDesc(tr('Pinned to orbit ', 'Закреплена на орбите ') + cfg.orbit);
      row.addToggle((t) =>
        t
          .setTooltip(tr('Show', 'Показывать'))
          .setValue(!cfg.hidden)
          .onChange((v) => plugin.setFolderCfg(path, { hidden: !v }))
      );
      row.addExtraButton((b) =>
        b
          .setIcon('settings')
          .setTooltip(tr('Color, icon and orbit', 'Цвет, значок, орбита'))
          .onClick(() => new FolderModal(this.app, plugin, path, () => this.display()).open())
      );
    }
  }
}

module.exports = OrbitFoldersPlugin;
module.exports.default = OrbitFoldersPlugin;
