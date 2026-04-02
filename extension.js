/* exported init enable disable */

const { GLib, Soup, Geoclue, Gio, Clutter, St, GdkPixbuf } = imports.gi;
const Cairo = imports.cairo;
let Rsvg = null;
try {
  Rsvg = imports.gi.Rsvg;
} catch (e) {
  Rsvg = null;
}
let Gdk = null;
try {
  Gdk = imports.gi.Gdk;
} catch (e) {
  Gdk = null;
}

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const ExtensionUtils = imports.misc.extensionUtils;
const ThemeContext = St.ThemeContext;

const CHECK_INTERVAL_SEC = 300; // 5 minutes
const ISS_POSITION_INTERVAL_SEC = 30; // 30 seconds
const LEAD_TIME_SEC = 600; // 10 minutes
const API_COUNT = 5;

const MAP_WIDTH = 320;
const MAP_HEIGHT = 180;
const USE_360_LONGITUDE = true;
const USE_SIMPLE_WATER_MAP = false;

let _timeoutId = 0;
let _issTimerId = 0;
let _session = null;
let _simple = null;
let _lastNotifiedRise = 0;
let _notifiedPermissionError = false;
let _indicator = null;
let _mapCanvas = null;
let _mapActor = null;
let _timeLabel = null;
let _statusLabel = null;
let _countdownLabel = null;
let _nextPass = null;
let _latEntry = null;
let _lonEntry = null;
let _useManualLocation = false;
let _manualLat = null;
let _manualLon = null;
let _styleSheet = null;
let _mapPixbuf = null;
let _mapSurface = null;
let _mapSurfaceW = 0;
let _mapSurfaceH = 0;
let _mapSurfacePath = '';
let _mapBaseW = 0;
let _mapBaseH = 0;

let _issHistory = [];
let _issLatest = null;

const CONFIG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'iss-detector']);
const CONFIG_FILE = GLib.build_filenamev([CONFIG_DIR, 'config.ini']);

function init() {}

function enable() {
  _session = new Soup.Session();
  _loadStyles();
  _createIndicator();
  _loadManualLocation();
  if (!_useManualLocation)
    _initGeoclue();

  _timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CHECK_INTERVAL_SEC, () => {
    _checkPasses();
    return GLib.SOURCE_CONTINUE;
  });

  _issTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, ISS_POSITION_INTERVAL_SEC, () => {
    _fetchIssPosition();
    return GLib.SOURCE_CONTINUE;
  });

  _checkPasses();
  _fetchIssPosition();
}

function disable() {
  if (_timeoutId) {
    GLib.source_remove(_timeoutId);
    _timeoutId = 0;
  }

  if (_issTimerId) {
    GLib.source_remove(_issTimerId);
    _issTimerId = 0;
  }

  if (_simple)
    _simple = null;

  if (_session) {
    _session.abort();
    _session = null;
  }

  if (_indicator) {
    _indicator.destroy();
    _indicator = null;
  }

  _unloadStyles();

  _mapCanvas = null;
  _mapActor = null;
  _timeLabel = null;
  _statusLabel = null;
  _countdownLabel = null;
  _latEntry = null;
  _lonEntry = null;
  _nextPass = null;
  _useManualLocation = false;
  _manualLat = null;
  _manualLon = null;
  _issHistory = [];
  _issLatest = null;
  _mapPixbuf = null;
  _mapSurface = null;
  _mapSurfaceW = 0;
  _mapSurfaceH = 0;
  _mapSurfacePath = '';
  _mapBaseW = 0;
  _mapBaseH = 0;
  _lastNotifiedRise = 0;
  _notifiedPermissionError = false;
}

function _initGeoclue() {
  Geoclue.Simple.new(
    'iss-detector',
    Geoclue.AccuracyLevel.CITY,
    null,
    (obj, res) => {
      try {
        _simple = Geoclue.Simple.new_finish(res);
        _setStatus('Location acquired.');
        _checkPasses();
        _invalidateMap();
      } catch (e) {
        if (!_notifiedPermissionError) {
          _notifiedPermissionError = true;
          Main.notify('ISS Detector', 'Location permission denied or unavailable.');
        }
        _setStatus('Location permission denied.');
      }
    }
  );
}

function _checkPasses() {
  if (!_session)
    return;

  const center = _getCenter();
  if (!center)
    return;

  const url = `https://api.open-notify.org/iss-pass.json?lat=${center.lat}&lon=${center.lon}&n=${API_COUNT}`;
  const msg = Soup.Message.new('GET', url);

  _session.queue_message(msg, (_session, message) => {
    if (message.status_code !== Soup.KnownStatusCode.OK)
      return;

    let data = null;
    try {
      data = JSON.parse(message.response_body.data);
    } catch (e) {
      return;
    }

    if (!data || data.message !== 'success' || !Array.isArray(data.response))
      return;

    _maybeNotify(data.response);
    _updateNextPass(data.response);
  });
}

function _maybeNotify(passes) {
  const now = Math.floor(Date.now() / 1000);

  for (const pass of passes) {
    const rise = pass.risetime;
    if (!rise || rise <= now)
      continue;

    const delta = rise - now;
    if (delta <= LEAD_TIME_SEC && rise !== _lastNotifiedRise) {
      _lastNotifiedRise = rise;
      const dt = GLib.DateTime.new_from_unix_local(rise);
      const timeStr = dt.format('%H:%M');
      const durationMin = Math.round((pass.duration || 0) / 60);

      const detail = durationMin > 0
        ? `ISS overhead at ${timeStr} (about ${durationMin} min).`
        : `ISS overhead at ${timeStr}.`;

      Main.notify('ISS Detector', detail);
      break;
    }
  }
}

function _fetchIssPosition() {
  if (!_session)
    return;

  const url = 'http://api.open-notify.org/iss-now.json';
  const msg = Soup.Message.new('GET', url);

  _session.queue_message(msg, (_session, message) => {
    if (message.status_code !== Soup.KnownStatusCode.OK)
      return;

    let data = null;
    try {
      data = JSON.parse(message.response_body.data);
    } catch (e) {
      return;
    }

    if (!data || data.message !== 'success' || !data.iss_position)
      return;

    const lat = Number.parseFloat(data.iss_position.latitude);
    const lon = Number.parseFloat(data.iss_position.longitude);
    const ts = Number.parseInt(data.timestamp, 10);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(ts))
      return;

    _issHistory.push({ lat, lon, ts });
    _issLatest = { lat, lon, ts };
    if (_issHistory.length > 360)
      _issHistory.shift();

    _updateIssStatus();
    _invalidateMap();
  });
}

function _createIndicator() {
  const ext = ExtensionUtils.getCurrentExtension();
  const iconPath = GLib.build_filenamev([ext.path, 'icons', 'iss-symbolic.svg']);
  const gicon = new Gio.FileIcon({ file: Gio.File.new_for_path(iconPath) });
  _mapPixbuf = null;

  _indicator = new PanelMenu.Button(0.0, 'ISS Detector');
  const icon = new St.Icon({ gicon, style_class: 'system-status-icon' });
  _indicator.add_child(icon);

  const box = new St.BoxLayout({
    vertical: true,
    style_class: 'iss-detector-box',
    x_expand: true,
    y_expand: true,
  });

  const headerBox = new St.BoxLayout({ vertical: false, x_expand: true });
  _countdownLabel = new St.Label({ text: '--', style_class: 'iss-countdown', x_align: Clutter.ActorAlign.START });
  _timeLabel = new St.Label({ text: 'Next pass: unknown', style_class: 'iss-nextpass', x_align: Clutter.ActorAlign.END, x_expand: true });
  headerBox.add_child(_countdownLabel);
  headerBox.add_child(_timeLabel);

  _statusLabel = new St.Label({ text: 'Waiting for location…', style_class: 'iss-status', x_align: Clutter.ActorAlign.START });

  const formBox = new St.BoxLayout({ vertical: false, style_class: 'iss-detector-form' });
  _latEntry = new St.Entry({
    text: '',
    hint_text: 'Latitude',
    x_expand: true,
    can_focus: true,
  });
  _lonEntry = new St.Entry({
    text: '',
    hint_text: 'Longitude',
    x_expand: true,
    can_focus: true,
  });
  const submitBtn = new St.Button({ label: 'Use', style_class: 'iss-detector-button' });
  submitBtn.connect('clicked', _applyManualLocation);
  formBox.add_child(_latEntry);
  formBox.add_child(_lonEntry);
  formBox.add_child(submitBtn);

  _mapActor = new St.Widget({
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    x_expand: true,
    y_expand: false,
    style_class: 'iss-map',
  });
  _mapCanvas = new Clutter.Canvas();
  _mapCanvas.set_size(MAP_WIDTH, MAP_HEIGHT);
  _mapCanvas.connect('draw', _drawMap);
  _mapActor.set_content(_mapCanvas);

  box.add_child(headerBox);
  box.add_child(_statusLabel);
  box.add_child(formBox);
  box.add_child(_mapActor);

  const item = new imports.ui.popupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
  item.add_child(box);
  _indicator.menu.addMenuItem(item);

  _indicator.menu.addMenuItem(new imports.ui.popupMenu.PopupSeparatorMenuItem());
  const refreshItem = new imports.ui.popupMenu.PopupMenuItem('Refresh now');
  refreshItem.connect('activate', () => {
    _checkPasses();
    _fetchIssPosition();
  });
  _indicator.menu.addMenuItem(refreshItem);

  Main.panel.addToStatusArea('iss-detector', _indicator);
  _invalidateMap();
}

function _setStatus(text) {
  if (_statusLabel)
    _statusLabel.text = text;
}

function _updateIssStatus() {
  if (!_issLatest || !_statusLabel)
    return;
  const dt = GLib.DateTime.new_from_unix_utc(_issLatest.ts);
  const timeStr = dt ? dt.format('%Y-%m-%d %H:%M UTC') : '';
  const latStr = _issLatest.lat.toFixed(4);
  const lonStr = _issLatest.lon.toFixed(4);
  _statusLabel.text = `ISS: ${latStr}, ${lonStr} @ ${timeStr}`;
}

function _updateNextPass(passes) {
  const now = Math.floor(Date.now() / 1000);
  let next = null;
  for (const pass of passes) {
    if (pass.risetime && pass.risetime > now) {
      next = pass;
      break;
    }
  }

  _nextPass = next;
  if (_timeLabel) {
    if (!next) {
      _timeLabel.text = 'Next pass: none found';
      if (_countdownLabel)
        _countdownLabel.text = '--';
    } else {
      const dt = GLib.DateTime.new_from_unix_local(next.risetime);
      const timeStr = dt.format('%Y-%m-%d %H:%M');
      const durationMin = Math.round((next.duration || 0) / 60);
      _timeLabel.text = durationMin > 0
        ? `Next pass: ${timeStr} (${durationMin} min)`
        : `Next pass: ${timeStr}`;

      if (_countdownLabel)
        _countdownLabel.text = _formatCountdown(next.risetime - now);
    }
  }

  _setStatus('Tracking ISS passes.');
  _updateIssStatus();
}

function _invalidateMap() {
  if (_mapCanvas)
    _mapCanvas.invalidate();
}

function _drawMap(canvas, cr, width, height) {
  cr.setSourceRGBA(0, 0, 0, 0);
  cr.paint();

  const ext = ExtensionUtils.getCurrentExtension();
  const mapPathPrimary = GLib.build_filenamev([ext.path, 'assets', 'color_map.svg.org.svg']);
  const mapPathSecondary = GLib.build_filenamev([ext.path, 'assets', 'color_map.svg']);
  const mapPathFallback = GLib.build_filenamev([ext.path, 'assets', 'world-map.svg']);
  const mapPath = GLib.file_test(mapPathPrimary, GLib.FileTest.EXISTS)
    ? mapPathPrimary
    : (GLib.file_test(mapPathSecondary, GLib.FileTest.EXISTS) ? mapPathSecondary : mapPathFallback);
  const isSvg = mapPath.toLowerCase().endsWith('.svg');

  try {
    if (USE_SIMPLE_WATER_MAP) {
      cr.setSourceRGBA(0.45, 0.67, 0.86, 1); // water blue
      cr.rectangle(0, 0, width, height);
      cr.fill();
    } else if (isSvg && Rsvg) {
      if (!_mapSurface || _mapSurfaceW !== width || _mapSurfaceH !== height || _mapSurfacePath !== mapPath) {
        const handle = Rsvg.Handle.new_from_file(mapPath);
        const dims = handle.get_dimensions ? handle.get_dimensions() : null;
        const baseW = dims && dims.width ? dims.width : width;
        const baseH = dims && dims.height ? dims.height : height;
        _mapBaseW = baseW;
        _mapBaseH = baseH;
        _mapSurface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
        const ctx = new Cairo.Context(_mapSurface);
        ctx.scale(width / baseW, height / baseH);
        handle.render_cairo(ctx);
        _mapSurfaceW = width;
        _mapSurfaceH = height;
        _mapSurfacePath = mapPath;
      }
      cr.setSourceSurface(_mapSurface, 0, 0);
      cr.paint();
    } else {
      if (!GdkPixbuf) {
        cr.setSourceRGBA(1, 1, 1, 0.6);
        cr.selectFontFace('Sans', 0, 0);
        cr.setFontSize(12);
        cr.moveTo(10, 20);
        cr.showText('GdkPixbuf not available.');
        return true;
      }
      if (!_mapPixbuf) {
        const base = GdkPixbuf.Pixbuf.new_from_file(mapPath);
        _mapBaseW = base.get_width();
        _mapBaseH = base.get_height();
        _mapPixbuf = base.scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR);
      }
      if (Gdk && _mapPixbuf) {
        Gdk.cairo_set_source_pixbuf(cr, _mapPixbuf, 0, 0);
        cr.paint();
      }
    }
  } catch (e) {
    cr.setSourceRGBA(0.15, 0.17, 0.2, 1);
    cr.rectangle(0, 0, width, height);
    cr.fill();
    return true;
  }

  // Draw ISS ground track and current position in equirectangular projection
  if (_issHistory.length > 1) {
    cr.setLineWidth(2);
    cr.setSourceRGBA(1, 0.3, 0.3, 0.9);
    let started = false;
    for (const pt of _issHistory) {
      const sx = _lonToX(pt.lon, width);
      const sy = _latToY(pt.lat, height);
      if (!started) {
        cr.moveTo(sx, sy);
        started = true;
      } else {
        cr.lineTo(sx, sy);
      }
    }
    cr.stroke();

    const last = _issHistory[_issHistory.length - 1];
    if (last) {
      const sx = _lonToX(last.lon, width);
      const sy = _latToY(last.lat, height);
      cr.setSourceRGBA(1, 1, 1, 0.95);
      cr.arc(sx, sy, 4, 0, 2 * Math.PI);
      cr.fill();
    }
  }

  return true;
}

function _lonToX(lon, width) {
  let adjLon = lon;
  if (USE_360_LONGITUDE && adjLon < 0)
    adjLon += 360;
  if (USE_360_LONGITUDE)
    return (adjLon / 360) * width;
  return (adjLon + 180) / 360 * width;
}

function _latToY(lat, height) {
  return (90 - lat) / 180 * height;
}

function _getCenter() {
  if (_useManualLocation && Number.isFinite(_manualLat) && Number.isFinite(_manualLon))
    return { lat: _manualLat, lon: _manualLon };
  if (_simple) {
    const location = _simple.get_location();
    if (location)
      return { lat: location.latitude, lon: location.longitude };
  }
  return null;
}

function _applyManualLocation() {
  if (!_latEntry || !_lonEntry)
    return;

  const latText = _latEntry.get_text().trim();
  const lonText = _lonEntry.get_text().trim();
  const lat = Number.parseFloat(latText);
  const lon = Number.parseFloat(lonText);

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    Main.notify('ISS Detector', 'Invalid latitude or longitude.');
    return;
  }

  _useManualLocation = true;
  _manualLat = lat;
  _manualLon = lon;
  _saveManualLocation();
  _setStatus(`Using manual location: ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
  _checkPasses();
  _invalidateMap();
}

function _loadManualLocation() {
  try {
    const keyFile = new GLib.KeyFile();
    if (!GLib.file_test(CONFIG_FILE, GLib.FileTest.EXISTS))
      return;
    keyFile.load_from_file(CONFIG_FILE, GLib.KeyFileFlags.NONE);
    const lat = keyFile.get_double('location', 'lat');
    const lon = keyFile.get_double('location', 'lon');
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      _useManualLocation = true;
      _manualLat = lat;
      _manualLon = lon;
      if (_latEntry)
        _latEntry.set_text(String(lat));
      if (_lonEntry)
        _lonEntry.set_text(String(lon));
      _setStatus(`Using manual location: ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
    }
  } catch (e) {
    // Ignore config errors
  }
}

function _saveManualLocation() {
  try {
    const keyFile = new GLib.KeyFile();
    keyFile.set_double('location', 'lat', _manualLat);
    keyFile.set_double('location', 'lon', _manualLon);
    GLib.mkdir_with_parents(CONFIG_DIR, 0o755);
    keyFile.save_to_file(CONFIG_FILE);
  } catch (e) {
    // Ignore save errors
  }
}

function _formatCountdown(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0)
    return '--';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0)
    return `${d}d ${h}h ${m}m`;
  if (h > 0)
    return `${h}h ${m}m`;
  return `${m}m`;
}

function _loadStyles() {
  try {
    const ext = ExtensionUtils.getCurrentExtension();
    const cssPath = GLib.build_filenamev([ext.path, 'stylesheet.css']);
    _styleSheet = Gio.File.new_for_path(cssPath);
    ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(_styleSheet);
  } catch (e) {
    // Ignore style load errors
  }
}

function _unloadStyles() {
  try {
    if (_styleSheet) {
      ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(_styleSheet);
      _styleSheet = null;
    }
  } catch (e) {
    // Ignore style unload errors
  }
}
