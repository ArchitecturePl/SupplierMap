// Minimal from-scratch slippy map: OSM/raster tiles + custom pan/zoom/pinch + a
// declarative marker/halo/popup layer. No external map library.
const TILE_SIZE = 256;
const MERC_MAX_LAT = 85.05112878;

function project(lat, lng, z) {
  const scale = TILE_SIZE * Math.pow(2, z);
  const x = (lng + 180) / 360 * scale;
  const rad = Math.max(-MERC_MAX_LAT, Math.min(MERC_MAX_LAT, lat)) * Math.PI / 180;
  const merc = Math.log(Math.tan(Math.PI / 4 + rad / 2));
  const y = (0.5 - merc / (2 * Math.PI)) * scale;
  return { x, y };
}
function unproject(x, y, z) {
  const scale = TILE_SIZE * Math.pow(2, z);
  const lng = x / scale * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y / scale;
  const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}
function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

export class MiniMap {
  constructor(container, opts) {
    this.el = container;
    this.tileUrl = opts.tileUrl;
    this.subdomains = (opts.subdomains || 'abc').split('');
    this.minZoom = opts.minZoom || 0;
    this.maxZoom = opts.maxZoom || 19;
    this.center = { lat: opts.center[0], lng: opts.center[1] };
    this.zoom = opts.zoom || 2;
    this.tiles = new Map();
    this.markers = new Map();
    this.openPopupId = null;
    this._zoomToken = 0;
    this._settleTimer = null;

    if (getComputedStyle(this.el).position === 'static') this.el.style.position = 'relative';
    this.el.style.overflow = 'hidden';
    this.el.style.touchAction = 'none';
    this.el.style.cursor = 'grab';
    this.el.style.userSelect = 'none';
    this.el.style.webkitUserSelect = 'none';
    this.el.style.webkitTapHighlightColor = 'transparent';
    this.el.style.webkitTouchCallout = 'none';
    this.el.style.background = '#e6e6e0';
    this.backdropPane = document.createElement('div');
    this.backdropPane.style.cssText = 'position:absolute; left:0; top:0; will-change:transform;';
    const bd = (u, x, y) => { const i = document.createElement('img'); i.crossOrigin = 'anonymous'; i.src = u; i.draggable = false; i.style.cssText = `position:absolute; left:${x}px; top:${y}px; width:256px; height:256px; max-width:none; max-height:none;`; this.backdropPane.appendChild(i); };
    for (let bx = 0; bx < 4; bx++) for (let by = 0; by < 4; by++) {
      const sub = ['a', 'b', 'c', 'd'][(bx + by) % 4];
      bd(`https://${sub}.basemaps.cartocdn.com/light_all/2/${bx}/${by}.png`, bx * 256, by * 256);
    }
    this.el.appendChild(this.backdropPane);

    this.tilePane = document.createElement('div');
    this.tilePane.style.cssText = 'position:absolute; left:0; top:0; will-change:transform;';
    this.markerPane = document.createElement('div');
    this.markerPane.style.cssText = 'position:absolute; left:0; top:0; width:0; height:0;';
    this.el.appendChild(this.tilePane);
    this.el.appendChild(this.markerPane);

    this._buildControls(opts.attribution);
    this._bindInteraction();

    this._ro = new ResizeObserver(() => this.invalidateSize());
    this._ro.observe(this.el);
    this.invalidateSize();
  }

  destroy() {
    this._ro && this._ro.disconnect();
    clearTimeout(this._settleTimer);
    document.removeEventListener('pointerdown', this._outsideCloser, true);
    this.el.innerHTML = '';
  }

  invalidateSize() {
    const r = this.el.getBoundingClientRect();
    this.size = { w: r.width, h: r.height };
    this._apply();
  }

  getCenter() { return { ...this.center }; }
  getZoom() { return this.zoom; }
  setMinZoom(z) { this.minZoom = z; if (this.zoom < z) this.zoom = z; this._apply(); }

  _clampCenter() {
    this.center.lat = clamp(this.center.lat, -MERC_MAX_LAT, MERC_MAX_LAT);
    if (!this.size) return;
    const worldSize = TILE_SIZE * Math.pow(2, this.zoom);
    const centerPx = project(this.center.lat, this.center.lng, this.zoom);
    if (worldSize <= this.size.h) centerPx.y = worldSize / 2;
    else centerPx.y = clamp(centerPx.y, this.size.h / 2, worldSize - this.size.h / 2);
    const ll = unproject(centerPx.x, centerPx.y, this.zoom);
    this.center.lat = ll.lat;
  }

  setView(lat, lng, zoom, opts) {
    zoom = clamp(zoom == null ? this.zoom : zoom, this.minZoom, this.maxZoom);
    opts = opts || {};
    if (!opts.animate) { this.center = { lat, lng }; this.zoom = zoom; this._clampCenter(); this._apply(); return; }
    const startCenter = { ...this.center }, startZoom = this.zoom;
    const token = ++this._zoomToken;
    const t0 = performance.now(), duration = opts.duration || 450;
    const apply = (t) => {
      const e = easeOutCubic(t);
      this.center = { lat: startCenter.lat + (lat - startCenter.lat) * e, lng: startCenter.lng + (lng - startCenter.lng) * e };
      this.zoom = clamp(startZoom + (zoom - startZoom) * e, this.minZoom, this.maxZoom);
      this._clampCenter(); this._apply();
    };
    const step = (now) => {
      if (token !== this._zoomToken) return;
      const t = Math.min(1, (now - t0) / duration);
      apply(t);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    const watchdog = setInterval(() => {
      if (token !== this._zoomToken) { clearInterval(watchdog); return; }
      const t = Math.min(1, (performance.now() - t0) / duration);
      apply(t);
      if (t >= 1) clearInterval(watchdog);
    }, 50);
  }

  _computeFit(points, padding) {
    const pad = padding.padding || [0, 0];
    const padTL = padding.paddingTopLeft || pad;
    const padBR = padding.paddingBottomRight || pad;
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    points.forEach(([lat, lng]) => { minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat); minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng); });
    const p0min = project(minLat, minLng, 0), p0max = project(maxLat, maxLng, 0);
    const worldW = Math.max(1e-6, Math.abs(p0max.x - p0min.x)), worldH = Math.max(1e-6, Math.abs(p0min.y - p0max.y));
    const availW = Math.max(1, this.size.w - padTL[0] - padBR[0]);
    const availH = Math.max(1, this.size.h - padTL[1] - padBR[1]);
    let z = Math.min(Math.log2(availW / worldW), Math.log2(availH / worldH));
    z = clamp(z, this.minZoom, this.maxZoom);
    const bc1 = project(minLat, minLng, z), bc2 = project(maxLat, maxLng, z);
    const cx = (bc1.x + bc2.x) / 2 - (padTL[0] - padBR[0]) / 2;
    const cy = (bc1.y + bc2.y) / 2 - (padTL[1] - padBR[1]) / 2;
    return { zoom: z, center: unproject(cx, cy, z) };
  }

  getBoundsZoom(points, opts) { return points.length ? this._computeFit(points, opts || {}).zoom : this.zoom; }

  fitBounds(points, opts) {
    if (!points.length) return;
    if (points.every(p => p[0] === points[0][0] && p[1] === points[0][1])) {
      this.setView(points[0][0], points[0][1], Math.min(this.maxZoom, 15), opts); return;
    }
    const fit = this._computeFit(points, opts || {});
    this.zoom = fit.zoom; this.center = fit.center; this._clampCenter(); this._apply();
  }

  _buildControls(attribution) {
    const zoomWrap = document.createElement('div');
    zoomWrap.style.cssText = 'position:absolute; right:12px; bottom:34px; z-index:5; display:flex; flex-direction:column; border-radius:8px; overflow:hidden; box-shadow:0 1px 4px rgba(0,0,0,0.3); font-family:system-ui,sans-serif;';
    const mkBtn = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label; b.type = 'button';
      b.setAttribute('data-mm-control', '1');
      b.style.cssText = 'width:30px; height:30px; border:none; background:#fff; color:#333; font-size:17px; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center; touch-action:manipulation; -webkit-tap-highlight-color:transparent;';
      b.addEventListener('mouseenter', () => b.style.background = '#f2f2f2');
      b.addEventListener('mouseleave', () => b.style.background = '#fff');
      b.addEventListener('click', fn);
      return b;
    };
    const inBtn = mkBtn('+', () => this._beginZoomAnim(this.zoom + 1, { x: this.size.w / 2, y: this.size.h / 2 }, 260));
    const outBtn = mkBtn('\u2212', () => this._beginZoomAnim(this.zoom - 1, { x: this.size.w / 2, y: this.size.h / 2 }, 260));
    inBtn.style.borderBottom = '1px solid #ddd';
    zoomWrap.appendChild(inBtn); zoomWrap.appendChild(outBtn);
    this.el.appendChild(zoomWrap);

    const attr = document.createElement('div');
    attr.setAttribute('data-mm-control', '1');
    attr.style.cssText = 'position:absolute; right:6px; bottom:4px; z-index:5; font-size:10px; color:#333; background:rgba(255,255,255,0.75); padding:1px 6px; border-radius:4px; font-family:system-ui,sans-serif; pointer-events:none;';
    attr.textContent = attribution || '';
    this.el.appendChild(attr);

    this.popupEl = document.createElement('div');
    this.popupEl.style.cssText = 'position:absolute; left:0; top:0; z-index:10; background:#fff; border-radius:10px; box-shadow:0 4px 16px rgba(0,0,0,0.22); padding:9px 11px; font-size:13px; line-height:1.4; color:#222; max-width:220px; display:none; font-family:system-ui,sans-serif; pointer-events:auto;';
    this.el.appendChild(this.popupEl);

    this._outsideCloser = (e) => {
      const t = e.target;
      if (t && t.closest && (t.closest('[data-mm-marker]') || t.closest('[data-mm-popup]'))) return;
      this.closePopup();
    };
    document.addEventListener('pointerdown', this._outsideCloser, true);
  }

  _bindInteraction() {
    const el = this.el;
    let mode = null;
    let dragStartCenterPx = null, dragStartPointer = null, dragStartZoom = null;
    const pointers = new Map();
    let pinchStartDist = 0, pinchStartZoom = 0, pinchStartMid = null, pinchStartCenterPx = null;
    let velSamples = [];
    const pushVelSample = (p) => {
      const now = performance.now();
      velSamples.push({ x: p.x, y: p.y, t: now });
      while (velSamples.length && now - velSamples[0].t > 100) velSamples.shift();
    };
    const rectPt = (e) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest && (e.target.closest('[data-mm-control]') || e.target.closest('[data-mm-popup]'))) return;
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      this._inertiaToken = (this._inertiaToken || 0) + 1;
      pointers.set(e.pointerId, rectPt(e));
      if (pointers.size === 1) {
        mode = 'pan';
        dragStartPointer = rectPt(e);
        dragStartCenterPx = project(this.center.lat, this.center.lng, this.zoom);
        dragStartZoom = this.zoom;
        velSamples = [dragStartPointer && { x: dragStartPointer.x, y: dragStartPointer.y, t: performance.now() }];
        el.style.cursor = 'grabbing';
      } else if (pointers.size === 2) {
        mode = 'pinch';
        const pts = Array.from(pointers.values());
        pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        pinchStartMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        pinchStartZoom = this.zoom;
        pinchStartCenterPx = project(this.center.lat, this.center.lng, this.zoom);
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, rectPt(e));
      if (mode === 'pan' && pointers.size === 1) {
        const p = rectPt(e);
        const dx = p.x - dragStartPointer.x, dy = p.y - dragStartPointer.y;
        const newCenterPx = { x: dragStartCenterPx.x - dx, y: dragStartCenterPx.y - dy };
        this.center = unproject(newCenterPx.x, newCenterPx.y, dragStartZoom);
        this._clampCenter(); this._apply();
        pushVelSample(p);
      } else if (mode === 'pinch' && pointers.size === 2) {
        const pts = Array.from(pointers.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        const newZoom = clamp(pinchStartZoom + Math.log2(dist / pinchStartDist), this.minZoom, this.maxZoom);
        const worldUnderMid = { x: pinchStartCenterPx.x + (pinchStartMid.x - this.size.w / 2), y: pinchStartCenterPx.y + (pinchStartMid.y - this.size.h / 2) };
        const latlng = unproject(worldUnderMid.x, worldUnderMid.y, pinchStartZoom);
        this.zoom = clamp(newZoom, this.minZoom, this.maxZoom);
        const wp = project(latlng.lat, latlng.lng, newZoom);
        const centerPx = { x: wp.x - (mid.x - this.size.w / 2), y: wp.y - (mid.y - this.size.h / 2) };
        this.center = unproject(centerPx.x, centerPx.y, newZoom);
        this._clampCenter(); this._apply();
      }
    });

    const endPointer = (e) => {
      const wasPan = mode === 'pan' && pointers.size === 1;
      pointers.delete(e.pointerId);
      if (pointers.size === 0) {
        mode = null; el.style.cursor = 'grab';
        if (wasPan) this._startInertia(velSamples);
      } else if (pointers.size === 1) {
        mode = 'pan';
        dragStartPointer = Array.from(pointers.values())[0];
        dragStartCenterPx = project(this.center.lat, this.center.lng, this.zoom);
        dragStartZoom = this.zoom;
        velSamples = [{ x: dragStartPointer.x, y: dragStartPointer.y, t: performance.now() }];
      }
    };
    el.addEventListener('pointerup', endPointer);
    el.addEventListener('pointercancel', endPointer);

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = -e.deltaY * (Math.abs(e.deltaY) > 40 ? 0.01 : 0.02);
      const target = clamp(this.zoom + clamp(delta, -1, 1), this.minZoom, this.maxZoom);
      this._beginZoomAnim(target, { x: this.size.w / 2, y: this.size.h / 2 }, 200);
    }, { passive: false });

    el.addEventListener('dblclick', (e) => {
      if (e.target.closest && (e.target.closest('[data-mm-control]') || e.target.closest('[data-mm-popup]'))) return;
      this._beginZoomAnim(this.zoom + 1, rectPt(e), 260);
    });

    this._markerTap = (id) => {
      let startX, startY, moved;
      const onMove = (ev) => { if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) moved = true; };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        if (moved) return;
        const entry = this.markers.get(id);
        if (!entry || !entry.data) return;
        if (entry.data.popupHtml) this._togglePopup(id);
        if (entry.data.onClick) entry.data.onClick(id);
      };
      return (ev) => {
        startX = ev.clientX; startY = ev.clientY; moved = false;
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
      };
    };
  }

  _startInertia(velSamples) {
    if (!velSamples || velSamples.length < 2) return;
    const first = velSamples[0], last = velSamples[velSamples.length - 1];
    const dt = last.t - first.t;
    if (dt <= 0) return;
    let vx = (last.x - first.x) / dt, vy = (last.y - first.y) / dt; // px/ms
    if (Math.hypot(vx, vy) < 0.03) return; // too slow to bother
    this._inertiaToken = (this._inertiaToken || 0) + 1;
    const token = this._inertiaToken;
    const friction = 0.0025; // px/ms^2 deceleration
    let last_t = performance.now();
    const step = (now) => {
      if (token !== this._inertiaToken) return;
      const dtStep = now - last_t;
      last_t = now;
      const speed = Math.hypot(vx, vy);
      if (speed < 0.01) return;
      const decel = Math.min(1, friction * dtStep / speed);
      vx *= (1 - decel); vy *= (1 - decel);
      const centerPx = project(this.center.lat, this.center.lng, this.zoom);
      const newCenterPx = { x: centerPx.x - vx * dtStep, y: centerPx.y - vy * dtStep };
      this.center = unproject(newCenterPx.x, newCenterPx.y, this.zoom);
      this._clampCenter(); this._apply();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  _beginZoomAnim(targetZoom, px, duration) {
    targetZoom = clamp(targetZoom, this.minZoom, this.maxZoom);
    const token = ++this._zoomToken;
    const startZoom = this.zoom;
    const beforeCenterPx = project(this.center.lat, this.center.lng, startZoom);
    const worldPx = { x: beforeCenterPx.x + (px.x - this.size.w / 2), y: beforeCenterPx.y + (px.y - this.size.h / 2) };
    const latlng = unproject(worldPx.x, worldPx.y, startZoom);
    const t0 = performance.now();
    const apply = (t) => {
      const e = easeOutCubic(t);
      this.zoom = clamp(startZoom + (targetZoom - startZoom) * e, this.minZoom, this.maxZoom);
      const z = this.zoom;
      const wp = project(latlng.lat, latlng.lng, z);
      const centerPx = { x: wp.x - (px.x - this.size.w / 2), y: wp.y - (px.y - this.size.h / 2) };
      this.center = unproject(centerPx.x, centerPx.y, z);
      this._clampCenter(); this._apply();
    };
    // Driven by rAF for smoothness, but a wall-clock watchdog guarantees the zoom lands on target
    // even if rAF is throttled/stalled (e.g. backgrounded tab or headless preview).
    const step = (now) => {
      if (token !== this._zoomToken) return;
      const t = Math.min(1, (now - t0) / duration);
      apply(t);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    const watchdog = setInterval(() => {
      if (token !== this._zoomToken) { clearInterval(watchdog); return; }
      const t = Math.min(1, (performance.now() - t0) / duration);
      apply(t);
      if (t >= 1) clearInterval(watchdog);
    }, 50);
  }

  setMarkers(list) {
    const seen = new Set();
    list.forEach((m) => {
      seen.add(m.id);
      let entry = this.markers.get(m.id);
      if (!entry) {
        const halo = document.createElement('div');
        halo.setAttribute('data-mm-marker', '1');
        halo.style.cssText = 'position:absolute; left:0; top:0; border-radius:50%; box-sizing:border-box; overflow:hidden; pointer-events:none;';
        const haloFill = document.createElement('div');
        haloFill.style.cssText = 'position:absolute; inset:0; border-radius:50%;';
        halo.appendChild(haloFill);
        const dot = document.createElement('div');
        dot.setAttribute('data-mm-marker', '1');
        dot.style.cssText = 'position:absolute; left:0; top:0; border-radius:50%; border:1.5px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,0.18); cursor:pointer; box-sizing:border-box; touch-action:manipulation; -webkit-tap-highlight-color:transparent;';
        this.markerPane.appendChild(halo);
        this.markerPane.appendChild(dot);
        const onDown = this._markerTap(m.id);
        dot.addEventListener('pointerdown', (e) => { e.stopPropagation(); onDown(e); });
        entry = { dot, halo, haloFill };
        this.markers.set(m.id, entry);
      }
      entry.data = m;
    });
    for (const [id, entry] of this.markers) {
      if (!seen.has(id)) {
        entry.dot.remove(); entry.halo.remove(); this.markers.delete(id);
        if (this.openPopupId === id) this.closePopup();
      }
    }
    this._layoutMarkers();
  }

  _togglePopup(id) {
    if (this.openPopupId === id) { this.closePopup(); return; }
    const entry = this.markers.get(id);
    if (!entry || !entry.data) return;
    this.openPopupId = id;
    this.popupEl.innerHTML = entry.data.popupHtml;
    this.popupEl.setAttribute('data-mm-popup', '1');
    this.popupEl.style.display = 'block';
    this._positionPopup();
  }
  openPopupFor(id) { if (this.openPopupId !== id) this._togglePopup(id); }
  closePopup() { this.openPopupId = null; this.popupEl.style.display = 'none'; }

  _positionPopup() {
    if (!this.openPopupId) return;
    const entry = this.markers.get(this.openPopupId);
    if (!entry) { this.closePopup(); return; }
    const p = this._screenPos(entry.data.lat, entry.data.lng);
    const r = entry.data.radius || 6;
    this.popupEl.style.transform = `translate(${p.x}px, ${p.y - r - 10}px) translate(-50%, -100%)`;
  }

  _screenPos(lat, lng) {
    const centerPx = project(this.center.lat, this.center.lng, this.zoom);
    const p = project(lat, lng, this.zoom);
    return { x: this.size.w / 2 + (p.x - centerPx.x), y: this.size.h / 2 + (p.y - centerPx.y) };
  }

  _layoutMarkers() {
    if (!this.size) return;
    for (const [, entry] of this.markers) {
      const m = entry.data;
      if (!m.visible) { entry.dot.style.display = 'none'; entry.halo.style.display = 'none'; continue; }
      const pos = this._screenPos(m.lat, m.lng);
      const r = m.radius || 6, d = r * 2;
      entry.dot.style.display = 'block';
      entry.dot.style.width = d + 'px'; entry.dot.style.height = d + 'px';
      entry.dot.style.background = m.color;
      entry.dot.style.transform = `translate(${pos.x}px, ${pos.y}px) translate(-50%,-50%) scale(${m.selected ? 1.4 : 1})`;
      entry.dot.style.boxShadow = m.selected ? '0 0 0 3px #201e1d, 0 0 0 5px rgba(0,0,0,0.18)' : '0 0 0 1px rgba(0,0,0,0.18)';
      entry.dot.style.zIndex = m.selected ? 6 : 2;
      if (m.approxMeters) {
        const metersPerPixel = 156543.03392 * Math.cos(m.lat * Math.PI / 180) / Math.pow(2, this.zoom);
        const hd = (m.approxMeters / metersPerPixel) * 2;
        if (hd < 4) { entry.halo.style.display = 'none'; }
        else {
          entry.halo.style.display = 'block';
          entry.halo.style.width = hd + 'px'; entry.halo.style.height = hd + 'px';
          entry.halo.style.transform = `translate(${pos.x}px, ${pos.y}px) translate(-50%,-50%)`;
          entry.halo.style.border = `2px dashed ${m.color}`;
          entry.haloFill.style.background = m.color;
          entry.haloFill.style.opacity = '0.15';
        }
      } else { entry.halo.style.display = 'none'; }
    }
    this._positionPopup();
  }

  _addTile(tileZoom, x, y, key) {
    const n = Math.pow(2, tileZoom);
    const xx = ((x % n) + n) % n;
    const sub = this.subdomains[Math.abs(x + y) % this.subdomains.length];
    const retina = window.devicePixelRatio >= 2 ? '@2x' : '';
    const url = this.tileUrl.replace('{s}', sub).replace('{z}', tileZoom).replace('{x}', xx).replace('{y}', y).replace('{r}', retina);
    const img = document.createElement('img');
    img.crossOrigin = 'anonymous';
    img.src = url; img.draggable = false;
    img.style.cssText = `position:absolute; width:${TILE_SIZE}px; height:${TILE_SIZE}px; max-width:none; max-height:none; opacity:0; transition:opacity .15s ease;`;
    img.style.left = (x * TILE_SIZE - this._origin.x) + 'px';
    img.style.top = (y * TILE_SIZE - this._origin.y) + 'px';
    img.addEventListener('load', () => { img.style.opacity = '1'; });
    img.addEventListener('error', () => { img.style.opacity = '1'; });
    this.tilePane.appendChild(img);
    this.tiles.set(key, img);
    return img;
  }

  _apply() {
    if (!this.size) return;
    const w = this.size.w, h = this.size.h;
    const tileZoomTarget = Math.round(clamp(this.zoom, this.minZoom, this.maxZoom));
    const renderZoom = this._origin ? this._origin.z : tileZoomTarget;
    const scale = Math.pow(2, this.zoom - renderZoom);
    const centerPx = project(this.center.lat, this.center.lng, renderZoom);

    const REBASE_DIST = 2048;
    if (!this._origin || Math.abs(centerPx.x - this._origin.x) > REBASE_DIST || Math.abs(centerPx.y - this._origin.y) > REBASE_DIST) {
      const newOrigin = { x: Math.round(centerPx.x / TILE_SIZE) * TILE_SIZE, y: Math.round(centerPx.y / TILE_SIZE) * TILE_SIZE, z: renderZoom };
      if (this._origin && this._origin.z === renderZoom) {
        for (const [key, img] of this.tiles) {
          const parts = key.split('/');
          const x = +parts[1], y = +parts[2];
          img.style.left = (x * TILE_SIZE - newOrigin.x) + 'px';
          img.style.top = (y * TILE_SIZE - newOrigin.y) + 'px';
        }
      }
      this._origin = newOrigin;
    }

    const tx = w / 2 - (centerPx.x - this._origin.x) * scale, ty = h / 2 - (centerPx.y - this._origin.y) * scale;
    this.tilePane.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    this.tilePane.style.transformOrigin = '0 0';

    const bScale = Math.pow(2, this.zoom - 2);
    const bCenterPx = project(this.center.lat, this.center.lng, 2);
    const btx = w / 2 - bCenterPx.x * bScale, bty = h / 2 - bCenterPx.y * bScale;
    this.backdropPane.style.transform = `translate(${btx}px, ${bty}px) scale(${bScale})`;
    this.backdropPane.style.transformOrigin = '0 0';

    if (this._retiringPanes) {
      for (const en of this._retiringPanes) {
        const rScale = Math.pow(2, this.zoom - en.z);
        const rCenterPx = project(this.center.lat, this.center.lng, en.z);
        const rtx = w / 2 - (rCenterPx.x - en.origin.x) * rScale, rty = h / 2 - (rCenterPx.y - en.origin.y) * rScale;
        en.pane.style.transform = `translate(${rtx}px, ${rty}px) scale(${rScale})`;
        en.pane.style.transformOrigin = '0 0';
      }
    }

    if (tileZoomTarget === renderZoom) {
      clearTimeout(this._settleTimer);
      this._settleTimer = null;
      this._scheduleReconcile(renderZoom, centerPx);
    } else {
      clearTimeout(this._settleTimer);
      this._settleTimer = setTimeout(() => {
        this._settleTimer = null;
        this._retireCurrentTiles();
        this._origin = null;
        this._apply();
      }, 220);
    }
    this._layoutMarkers();
  }

  _scheduleReconcile(renderZoom, centerPx) {
    const last = this._lastReconcileCenterPx;
    const moved = !last || last.z !== renderZoom || Math.hypot(centerPx.x - last.x, centerPx.y - last.y) > TILE_SIZE / 3;
    if (!moved || this._reconcileRaf) return;
    this._reconcileRaf = requestAnimationFrame(() => {
      this._reconcileRaf = null;
      const rz = Math.round(clamp(this.zoom, this.minZoom, this.maxZoom));
      if (rz !== renderZoom || !this.size) return; // zoom bucket moved on; next _apply call handles it
      const cp = project(this.center.lat, this.center.lng, renderZoom);
      const sc = Math.pow(2, this.zoom - renderZoom);
      this._lastReconcileCenterPx = { x: cp.x, y: cp.y, z: renderZoom };
      this._reconcileTiles(renderZoom, cp, sc, this.size.w, this.size.h);
    });
  }

  _retireCurrentTiles() {
    if (!this.tiles.size) return;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:absolute; left:0; top:0; pointer-events:none;';
    for (const img of this.tiles.values()) wrap.appendChild(img);
    this.tiles.clear();
    this.tilePane.parentNode.insertBefore(wrap, this.tilePane);
    this._retiringPanes = this._retiringPanes || [];
    this._retiringPanes.push({ pane: wrap, z: this._origin.z, origin: { x: this._origin.x, y: this._origin.y } });
  }

  _reconcileTiles(tileZoom, centerPx, scale, w, h) {
    const buffer = 1;
    const minX = Math.floor((centerPx.x - (w / 2) / scale) / TILE_SIZE) - buffer;
    const maxX = Math.floor((centerPx.x + (w / 2) / scale) / TILE_SIZE) + buffer;
    const minY = Math.floor((centerPx.y - (h / 2) / scale) / TILE_SIZE) - buffer;
    const maxY = Math.floor((centerPx.y + (h / 2) / scale) / TILE_SIZE) + buffer;
    const n = Math.pow(2, tileZoom);
    const wanted = new Set();
    const MAX_SPAN = 64;
    const loMinX = maxX - minX > MAX_SPAN ? maxX - MAX_SPAN : minX;
    const loMinY = Math.max(0, minY);
    const loMaxYFull = Math.min(n - 1, maxY);
    const loMaxY = loMaxYFull - loMinY > MAX_SPAN ? loMinY + MAX_SPAN : loMaxYFull;
    const freshImgs = [];
    for (let x = loMinX; x <= maxX; x++) {
      for (let y = loMinY; y <= loMaxY; y++) {
        const key = tileZoom + '/' + x + '/' + y;
        wanted.add(key);
        if (!this.tiles.has(key)) freshImgs.push(this._addTile(tileZoom, x, y, key));
      }
    }
    for (const [key, img] of this.tiles) {
      const z = +key.split('/')[0];
      if (z !== tileZoom || !wanted.has(key)) { img.remove(); this.tiles.delete(key); }
    }
    if (this._retiringPanes && this._retiringPanes.length) {
      const entries = this._retiringPanes;
      this._retiringPanes = [];
      if (freshImgs.length) {
        let remaining = freshImgs.length;
        const finish = () => { if (--remaining <= 0) entries.forEach(en => en.pane.remove()); };
        freshImgs.forEach(img => {
          if (img.complete) finish();
          else { img.addEventListener('load', finish, { once: true }); img.addEventListener('error', finish, { once: true }); }
        });
      } else {
        entries.forEach(en => en.pane.remove());
      }
    }
  }
}
