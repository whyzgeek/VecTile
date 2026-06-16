/* ────────────────────────────────────────────────────────────────
   Vectile — app.js
   Handles: upload, PDF page control, engine switching, debounced
   live re-render, palette hide/recolor, zoom/pan, SVG download.
──────────────────────────────────────────────────────────────── */

const DEBOUNCE_MS = 350;

// ── State ─────────────────────────────────────────────────────
const state = {
  imageId: null,
  kind: null,          // "image" | "pdf"
  pageCount: 1,
  currentPage: 0,
  currentDpi: 200,
  engine: "vtracer",
  params: {},
  quantizeColors: 0,
  resizePreview: true,
  currentSvg: null,
  engines: {},         // id -> engine descriptor
  presets: [],
  hiddenColors: new Set(),
  recoloredColors: {},  // originalHex -> newHex
  paletteRecolorSource: null,  // original palette key being recolored via paint picker
  backgroundEditActive: false,
  editTools: { mode: "pan", paintColor: "#000000" },
  paintRecentColors: [],
  paintPickerHsl: { h: 0, s: 0, l: 0 },
  backgroundColor: "#ffffff",
  undoStack: [],
  redoStack: [],
  originalTraceSvg: null,
  originalFile: null,
  // Print state
  paperSizes: [],
  printGrid: null,     // result of /api/print/calculate
  printOverlayVisible: false,
  activeTab: "original",  // original | vectorized | split | print
  printGridVisible: true, // toggled by the "Hide grid" button in the Print panel
  printSettings: {
    units: "in",          // "mm" | "in" — display unit, internal state stays mm
    aspectLocked: true,   // when true, poster_w_mm and poster_h_mm stay in source-SVG aspect
    posterAutoFit: true,  // when true, poster dims are auto-fitted on each fresh render
    paper_name: "Letter",
    paper_w_mm: null,
    paper_h_mm: null,
    orientation: "portrait",
    poster_w_mm: 420,
    poster_h_mm: 594,
    overlap_mm: 2,
    margin_mm: 10,
    single_page: false,
    poster_mode: "grid", // UI-only: grid | dimensions | scale
    grid_cols: 2,
    grid_rows: 2,
    scale_pct: 200,
    // Image placement on the poster (mm). The PDF and the preview both use
    // these exact values, so what's on screen is what's in the PDF.
    image_fit: "contain",         // "contain" | "cover" | "manual"
    image_scale: null,            // mm per source-SVG user unit
    image_x_mm: 0,                // top-left of the unrotated image bounding box (y-down)
    image_y_mm: 0,
    image_rotation_deg: 0,        // rotation around the image's bbox centre
    grid_offset_x_mm: 0,          // shifts where the tile grid starts on the poster
    grid_offset_y_mm: 0,
    trim_guides_to_poster: true,  // hide tile guides outside the poster bounds
    decorations: {
      overlap_shade: true,
      crop_marks: true,
      page_labels: true,
      registration_marks: true,
      scale_indicator: true,
      border_box: true,
    },
  },
};

let debounceTimer = null;
let tracingInFlight = 0;
let tracingDebouncePending = false;
let abortController = null;

// ── DOM refs ──────────────────────────────────────────────────
const dropzone       = document.getElementById("dropzone");
const fileInput      = document.getElementById("file-input");
const uploadInfo     = document.getElementById("upload-info");
const pdfSection     = document.getElementById("pdf-section");
const pdfPageLabel   = document.getElementById("pdf-page-label");
const pdfPrev        = document.getElementById("pdf-prev");
const pdfNext        = document.getElementById("pdf-next");
const pdfDpiSlider   = document.getElementById("pdf-dpi");
const pdfDpiVal      = document.getElementById("pdf-dpi-val");
const presetSelect   = document.getElementById("preset-select");
const engineTabs     = document.getElementById("engine-tabs");
const engineDesc     = document.getElementById("engine-desc");
const paramControls  = document.getElementById("param-controls");
const resizeCheckbox = document.getElementById("resize-preview");
const quantizeSlider = document.getElementById("quantize-colors");
const quantizeVal    = document.getElementById("quantize-colors-val");
const btnDownload    = document.getElementById("btn-download");
const btnReset       = document.getElementById("btn-reset");
const previewArea    = document.getElementById("preview-area");
const placeholder    = document.getElementById("preview-placeholder");
const tracingOverlay = document.getElementById("tracing-overlay");
const svgContainer   = document.getElementById("svg-container");
const splitSvgDiv    = document.getElementById("split-svg");
const originalImg    = document.getElementById("original-img");
const splitOrigImg   = document.getElementById("split-original");
const statusDim      = document.getElementById("status-dimensions");
const statusSize     = document.getElementById("status-size");
const statusTime     = document.getElementById("status-time");
const statusPaths    = document.getElementById("status-paths");
const paletteGrid    = document.getElementById("palette-grid");
const palettePlaceholder = document.getElementById("palette-placeholder");
const btnResetPalette = document.getElementById("btn-reset-palette");
const panVectorized   = document.getElementById("pan-vectorized");
const editBoxOverlay  = document.getElementById("edit-box-overlay");
const quickEditSection = document.getElementById("quick-edit-section");
const editPaintSwatch  = document.getElementById("edit-paint-swatch");
const editPaintHex     = document.getElementById("edit-paint-hex");
const editPaintSl      = document.getElementById("edit-paint-sl");
const editPaintSlCursor = document.getElementById("edit-paint-sl-cursor");
const editPaintHue     = document.getElementById("edit-paint-hue");
const editPaintRecent  = document.getElementById("edit-paint-recent");
const btnEditBg         = document.getElementById("btn-edit-bg");
const editSpeckle     = document.getElementById("edit-speckle");
const btnRemoveSpeckles = document.getElementById("btn-remove-speckles");
const btnEditUndo     = document.getElementById("btn-edit-undo");
const btnEditRedo     = document.getElementById("btn-edit-redo");

const EDIT_DRAWABLE = "path, polygon, rect, circle, ellipse, line, polyline";
const VECTILE_BG_ID = "vectile-bg";
const MAX_UNDO = 30;
const MAX_PAINT_RECENT = 8;

const paintColorPicker = {
  swatch: () => editPaintSwatch,
  hex: () => editPaintHex,
  sl: () => editPaintSl,
  slCursor: () => editPaintSlCursor,
  hue: () => editPaintHue,
  recent: () => editPaintRecent,
  getColor: () => state.editTools.paintColor,
  setColor: (c) => { state.editTools.paintColor = c; },
  getHsl: () => state.paintPickerHsl,
  setHsl: (h) => { state.paintPickerHsl = h; },
  getRecent: () => state.paintRecentColors,
  setRecent: (r) => { state.paintRecentColors = r; },
};

// ── Bootstrap ─────────────────────────────────────────────────
(async () => {
  const [enginesRes, presetsRes] = await Promise.all([
    fetch("/api/engines").then(r => r.json()),
    fetch("/api/presets").then(r => r.json()),
  ]);

  state.presets = presetsRes;
  enginesRes.forEach(e => { state.engines[e.id] = e; });

  // Build engine tabs
  enginesRes.forEach(e => {
    const btn = document.createElement("button");
    btn.className = "engine-tab" + (e.id === state.engine ? " active" : "");
    btn.textContent = e.id === "vtracer" ? "VTracer (Color)" : "B&W / Line Art";
    btn.dataset.engine = e.id;
    btn.addEventListener("click", () => setEngine(e.id));
    engineTabs.appendChild(btn);
  });
  updateEngineDesc();

  // Build preset options
  presetsRes.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    presetSelect.appendChild(opt);
  });

  // Apply default engine params
  setEngine(state.engine, false);
})();

// ── Dropzone ──────────────────────────────────────────────────
dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
fileInput.addEventListener("change", e => e.target.files[0] && handleFile(e.target.files[0]));

dropzone.addEventListener("dragover", e => { e.preventDefault(); dropzone.classList.add("drag-over"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
dropzone.addEventListener("drop", e => {
  e.preventDefault();
  dropzone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

async function handleFile(file) {
  state.originalFile = file;
  const formData = new FormData();
  formData.append("file", file);

  uploadInfo.textContent = "Uploading…";
  uploadInfo.classList.remove("hidden");

  const res = await fetch("/api/upload", { method: "POST", body: formData });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Upload failed" }));
    uploadInfo.textContent = "Error: " + (err.detail || "upload failed");
    return;
  }

  const data = await res.json();
  state.imageId = data.image_id;
  state.kind = data.kind;
  state.pageCount = data.page_count || 1;
  state.currentPage = 0;
  state.currentDpi = 200;
  state.hiddenColors.clear();
  state.recoloredColors = {};
  resetEditHistory();
  state.originalTraceSvg = null;
  state.backgroundColor = "#ffffff";
  finishBackgroundEdit(false);
  finishPaletteRecolor(false);
  // Each new upload re-enables poster auto-fit
  state.printSettings.posterAutoFit = true;

  // For raster uploads we can use the original file for the "Original" preview;
  // for PDFs the file isn't a viewable image, so we re-fetch a rendered raster.
  if (data.kind === "svg" && data.svg) {
    state.currentSvg = data.svg;
    state.originalTraceSvg = data.svg;
    resetEditHistory();
    state.backgroundColor = "#ffffff";
    renderSvg(data.svg, { showTab: "vectorized" });
    buildPalettePanel(data.palette);
    btnDownload.disabled = false;
    originalImg.removeAttribute("src");
    splitOrigImg.removeAttribute("src");
  } else if (data.kind === "image") {
    const objectUrl = URL.createObjectURL(file);
    originalImg.src = objectUrl;
    splitOrigImg.src = objectUrl;
  } else {
    // PDF: server-rendered raster will be loaded after the first vectorize call.
    originalImg.removeAttribute("src");
    splitOrigImg.removeAttribute("src");
  }

  uploadInfo.textContent = `${file.name} — ${data.width}×${data.height}${data.kind === "svg" ? " (SVG)" : ""}`;
  statusDim.textContent = `${data.width} × ${data.height}${data.kind === "svg" ? " user units" : " px"}`;

  // Show/hide PDF controls
  if (data.kind === "pdf") {
    pdfSection.style.display = "";
    pdfPageLabel.textContent = `1 / ${data.page_count}`;
    pdfPrev.disabled = true;
    pdfNext.disabled = data.page_count <= 1;
  } else {
    pdfSection.style.display = "none";
  }

  // Reveal the preview area now that we have content
  previewArea.classList.add("has-image");
  resetAllZoomPan();
  showPane(getCurrentTab() || "original");
  if (data.kind !== "svg") {
    scheduleVectorize();
  } else {
    refreshPrintEnabled();
    showPane("vectorized");
  }
}

// ── PDF controls ──────────────────────────────────────────────
pdfDpiSlider.addEventListener("input", () => {
  pdfDpiVal.textContent = pdfDpiSlider.value;
});
pdfDpiSlider.addEventListener("change", () => rerenderPdf());

pdfPrev.addEventListener("click", () => { if (state.currentPage > 0) { state.currentPage--; updatePdfPageUI(); rerenderPdf(); } });
pdfNext.addEventListener("click", () => { if (state.currentPage < state.pageCount - 1) { state.currentPage++; updatePdfPageUI(); rerenderPdf(); } });

function updatePdfPageUI() {
  pdfPageLabel.textContent = `${state.currentPage + 1} / ${state.pageCount}`;
  pdfPrev.disabled = state.currentPage === 0;
  pdfNext.disabled = state.currentPage >= state.pageCount - 1;
}

async function rerenderPdf() {
  if (!state.imageId) return;
  state.currentDpi = parseInt(pdfDpiSlider.value);
  const res = await fetch("/api/pdf-render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_id: state.imageId, page: state.currentPage, dpi: state.currentDpi }),
  });
  if (res.ok) scheduleVectorize();
}

// ── Engine & params ───────────────────────────────────────────
function setEngine(id, retrace = true) {
  state.engine = id;
  document.querySelectorAll(".engine-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.engine === id);
  });
  updateEngineDesc();
  buildParamControls();
  presetSelect.value = "";
  if (retrace) scheduleVectorize();
}

function updateEngineDesc() {
  const e = state.engines[state.engine];
  engineDesc.textContent = e ? e.description : "";
}

function buildParamControls(overrideParams = null) {
  const e = state.engines[state.engine];
  if (!e) return;
  paramControls.innerHTML = "";
  const params = overrideParams || {};

  e.param_schema.forEach(p => {
    const row = document.createElement("div");
    row.className = "param-row";

    const label = document.createElement("label");
    label.textContent = p.label;
    label.setAttribute("data-hint", p.hint || "");
    label.title = p.hint || "";

    let input, output;

    if (p.type === "int" || p.type === "float") {
      input = document.createElement("input");
      input.type = "range";
      input.min = p.min;
      input.max = p.max;
      input.step = p.step;
      input.value = params[p.name] !== undefined ? params[p.name] : p.default;
      output = document.createElement("output");
      output.textContent = input.value;
      input.addEventListener("input", () => { output.textContent = input.value; });
      input.addEventListener("change", () => { collectParams(); scheduleVectorize(); });
      row.append(label, input, output);
    } else if (p.type === "select") {
      input = document.createElement("select");
      p.options.forEach(opt => {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        input.appendChild(o);
      });
      input.value = params[p.name] !== undefined ? params[p.name] : p.default;
      input.addEventListener("change", () => { collectParams(); scheduleVectorize(); });
      row.append(label, input);
    } else if (p.type === "bool") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = params[p.name] !== undefined ? params[p.name] : p.default;
      input.addEventListener("change", () => { collectParams(); scheduleVectorize(); });
      row.append(label, input);
    }

    paramControls.appendChild(row);
  });

  collectParams();
}

function collectParams() {
  const e = state.engines[state.engine];
  if (!e) return;
  const params = {};
  e.param_schema.forEach(p => {
    const inputs = paramControls.querySelectorAll("input, select");
    // find matching by position
    const rows = paramControls.querySelectorAll(".param-row");
    rows.forEach(row => {
      const lbl = row.querySelector("label");
      if (!lbl || lbl.textContent !== p.label) return;
      const el = row.querySelector("input, select");
      if (!el) return;
      if (p.type === "int") params[p.name] = parseInt(el.value);
      else if (p.type === "float") params[p.name] = parseFloat(el.value);
      else if (p.type === "bool") params[p.name] = el.checked;
      else params[p.name] = el.value;
    });
  });
  state.params = params;
}

// ── Preset select ─────────────────────────────────────────────
presetSelect.addEventListener("change", () => {
  const preset = state.presets.find(p => p.id === presetSelect.value);
  if (!preset) return;
  // Switch engine if needed (rebuild tabs first)
  if (preset.engine !== state.engine) {
    state.engine = preset.engine;
    document.querySelectorAll(".engine-tab").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.engine === state.engine);
    });
    updateEngineDesc();
  }
  buildParamControls(preset.params);
  state.quantizeColors = preset.quantize_colors || 0;
  quantizeSlider.value = state.quantizeColors;
  quantizeVal.textContent = state.quantizeColors >= 2 ? state.quantizeColors : "Off";
  state.resizePreview = preset.resize_preview !== false;
  resizeCheckbox.checked = state.resizePreview;
  scheduleVectorize();
});

// ── Pre-trace controls ────────────────────────────────────────
resizeCheckbox.addEventListener("change", () => {
  state.resizePreview = resizeCheckbox.checked;
  scheduleVectorize();
});
quantizeSlider.addEventListener("input", () => {
  const v = parseInt(quantizeSlider.value);
  quantizeVal.textContent = v >= 2 ? v : "Off";
});
quantizeSlider.addEventListener("change", () => {
  state.quantizeColors = parseInt(quantizeSlider.value);
  scheduleVectorize();
});

// ── Vectorize ─────────────────────────────────────────────────
function scheduleVectorize() {
  if (!state.imageId) return;
  tracingDebouncePending = true;
  updateTracingOverlay();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runVectorize, DEBOUNCE_MS);
}

async function runVectorize() {
  if (!state.imageId) return;

  if (abortController) abortController.abort();
  abortController = new AbortController();

  tracingDebouncePending = false;
  beginTracing();

  try {
    const body = {
      image_id: state.imageId,
      engine: state.engine,
      params: state.params,
      quantize_colors: state.quantizeColors,
      resize_preview: state.resizePreview,
    };

    const res = await fetch("/api/vectorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "Trace failed" }));
      console.error("Vectorize error:", err.detail);
      return;
    }

    const data = await res.json();
    state.currentSvg = data.svg;
    state.originalTraceSvg = data.svg;
    state.hiddenColors.clear();
    state.recoloredColors = {};
    resetEditHistory();
    state.backgroundColor = "#ffffff";

    renderSvg(data.svg);
    buildPalettePanel(data.palette);
    updateStatusBar(data);
    btnDownload.disabled = false;
  } catch (err) {
    if (err.name !== "AbortError") console.error(err);
  } finally {
    endTracing();
  }
}

// ── SVG rendering ─────────────────────────────────────────────
function mediaIntrinsicSize(el) {
  if (!el) return null;
  if (el.tagName === "IMG") {
    if (!el.naturalWidth) return null;
    return { w: el.naturalWidth, h: el.naturalHeight };
  }
  const vb = el.getAttribute("viewBox");
  if (vb) {
    const p = vb.trim().split(/[\s,]+/).map(Number);
    if (p.length >= 4 && p[2] > 0 && p[3] > 0) return { w: p[2], h: p[3] };
  }
  const w = parseFloat(el.getAttribute("width"));
  const h = parseFloat(el.getAttribute("height"));
  if (w > 0 && h > 0) return { w, h };
  return null;
}

function fitMediaInZone(el, zone) {
  if (!el || !zone) return;
  const zw = zone.clientWidth;
  const zh = zone.clientHeight;
  // Pane may be hidden (display:none) — skip rather than sizing to 0×0.
  if (zw <= 0 || zh <= 0) return;
  const size = mediaIntrinsicSize(el);
  if (!size) return;
  const fit = Math.min(zw / size.w, zh / size.h);
  if (!Number.isFinite(fit) || fit <= 0) return;
  el.style.width = `${size.w * fit}px`;
  el.style.height = `${size.h * fit}px`;
  el.style.maxWidth = "none";
  el.style.maxHeight = "none";
}

function preparePreviewSvg(svg) {
  if (!svg) return;
  if (!svg.getAttribute("viewBox")) {
    const w = parseFloat(svg.getAttribute("width"));
    const h = parseFloat(svg.getAttribute("height"));
    if (w > 0 && h > 0) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  }
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
}

function resetVectorizedWrapperStyles() {
  const wrap = document.getElementById("svg-container");
  if (!wrap) return;
  wrap.style.removeProperty("width");
  wrap.style.removeProperty("height");
  wrap.style.removeProperty("max-width");
  wrap.style.removeProperty("max-height");
  wrap.style.removeProperty("transform");
}

function measureZone(paneId, zoneEl) {
  let zw = zoneEl?.clientWidth || 0;
  let zh = zoneEl?.clientHeight || 0;
  if (zw > 0 && zh > 0) return { zw, zh };
  const pane = document.getElementById(paneId);
  if (pane?.classList.contains("active")) {
    const r = pane.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { zw: r.width, zh: r.height };
  }
  return null;
}

function fitVectorizedPreview() {
  const zone = document.getElementById("pan-vectorized");
  const svg = svgContainer?.querySelector("svg");
  if (!zone || !svg) return;
  const ref = mediaIntrinsicSize(svg);
  if (!ref) return;
  const dims = measureZone("pane-vectorized", zone);
  if (!dims) return;
  const fit = Math.min(dims.zw / ref.w, dims.zh / ref.h);
  if (!Number.isFinite(fit) || fit <= 0) return;
  svg.style.width = `${ref.w * fit}px`;
  svg.style.height = `${ref.h * fit}px`;
  svg.style.maxWidth = "none";
  svg.style.maxHeight = "none";
}

function schedulePreviewFit() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fitPreviewMedia();
      reapplyAllZoomPan();
    });
  });
}

function fitSvgWrapperInZone(wrap, zone, ref) {
  const svg = wrap?.querySelector("svg");
  if (!wrap || !svg || !zone || !ref) return false;
  const zw = zone.clientWidth;
  const zh = zone.clientHeight;
  if (zw <= 0 || zh <= 0) return false;
  const fit = Math.min(zw / ref.w, zh / ref.h);
  if (!Number.isFinite(fit) || fit <= 0) return false;
  const w = ref.w * fit;
  const h = ref.h * fit;
  wrap.style.width = `${w}px`;
  wrap.style.height = `${h}px`;
  wrap.style.maxWidth = "none";
  wrap.style.maxHeight = "none";
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.maxWidth = "none";
  svg.style.maxHeight = "none";
  return true;
}

function fitSplitHalves() {
  const zone = document.querySelector("#split-half-left .split-pan-zone");
  const img = document.getElementById("split-original");
  const wrap = document.getElementById("split-svg");
  const svg = wrap?.querySelector("svg");
  if (!zone || !wrap || !svg) return;
  if (zone.clientWidth <= 0 || zone.clientHeight <= 0) return;

  const ref = mediaIntrinsicSize(svg) || mediaIntrinsicSize(img);
  if (!ref) return;

  const fit = Math.min(zone.clientWidth / ref.w, zone.clientHeight / ref.h);
  if (!Number.isFinite(fit) || fit <= 0) return;
  const w = ref.w * fit;
  const h = ref.h * fit;

  if (mediaIntrinsicSize(img)) {
    img.style.width = `${w}px`;
    img.style.height = `${h}px`;
    img.style.maxWidth = "none";
    img.style.maxHeight = "none";
  }

  fitSvgWrapperInZone(wrap, zone, ref);
}

function fitPreviewMedia() {
  fitVectorizedPreview();
  fitSplitHalves();
}

function fitSplitMediaToHalves() {
  fitPreviewMedia();
}

function renderSvg(svgStr, { showTab } = {}) {
  finishBackgroundEdit(false);
  svgContainer.innerHTML = svgStr;
  splitSvgDiv.innerHTML = svgStr;
  resetVectorizedWrapperStyles();
  preparePreviewSvg(svgContainer.querySelector("svg"));
  preparePreviewSvg(splitSvgDiv.querySelector("svg"));
  showPane(showTab ?? getCurrentTab());
  schedulePreviewFit();
  syncBackgroundFromSvg();
  if (typeof window.__onSvgRendered === "function") window.__onSvgRendered();
}

// ── SVG Quick Edit ────────────────────────────────────────────
function getPrimarySvg() {
  return svgContainer.querySelector("svg");
}

function serializeWorkingSvg() {
  const svg = getPrimarySvg();
  return svg ? new XMLSerializer().serializeToString(svg) : state.currentSvg;
}

/** Strip preview-only CSS and restore width/height for svglib / download / print. */
function serializeSvgForExport(svg) {
  const el = svg || getPrimarySvg();
  if (!el) return null;
  const clone = el.cloneNode(true);
  const dims = mediaIntrinsicSize(clone);
  clone.removeAttribute("style");
  clone.removeAttribute("class");
  if (dims) {
    clone.setAttribute("width", String(dims.w));
    clone.setAttribute("height", String(dims.h));
    if (!clone.getAttribute("viewBox")) {
      clone.setAttribute("viewBox", `0 0 ${dims.w} ${dims.h}`);
    }
  }
  return new XMLSerializer().serializeToString(clone);
}

function syncSplitSvgFromPrimary() {
  const src = getPrimarySvg();
  if (!src) return;
  const clone = src.cloneNode(true);
  preparePreviewSvg(clone);
  splitSvgDiv.replaceChildren(clone);
  fitSplitHalves();
  reapplyAllZoomPan();
  // Primary (vectorized) keeps its size — do not re-fit or re-prepare it here.
}

// ── Paint color picker (HSL + hex + recent + eyedropper) ─────
function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(hex) {
  const m = hex.replace("#", "").match(/^([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = m[1];
  return {
    r: parseInt(n.slice(0, 2), 16),
    g: parseInt(n.slice(2, 4), 16),
    b: parseInt(n.slice(4, 6), 16),
  };
}

function normalizeColorToHex(color) {
  if (!color || color === "none" || color === "transparent") return null;
  const c = color.trim();
  if (c.startsWith("#")) {
    let h = c.slice(1);
    if (h.length === 8) h = h.slice(0, 6);
    if (h.length === 3) h = h.split("").map(ch => ch + ch).join("");
    if (/^[0-9a-f]{6}$/i.test(h)) return `#${h.toLowerCase()}`;
    return null;
  }
  const rgb = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)$/i);
  if (rgb) return rgbToHex(+rgb[1], +rgb[2], +rgb[3]);
  return null;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = ((b - r) / d + 2); break;
      default: h = ((r - g) / d + 4); break;
    }
    h /= 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = clamp(s, 0, 100) / 100;
  l = clamp(l, 0, 100) / 100;
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = h / 360;
  const tc = t => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return {
    r: tc(hk + 1 / 3) * 255,
    g: tc(hk) * 255,
    b: tc(hk - 1 / 3) * 255,
  };
}

function hslToHex(h, s, l) {
  const { r, g, b } = hslToRgb(h, s, l);
  return rgbToHex(r, g, b);
}

function getElementFillColor(el) {
  let node = el;
  while (node && node.nodeType === 1) {
    const attrFill = node.getAttribute?.("fill");
    if (attrFill && attrFill !== "none") {
      const hex = normalizeColorToHex(attrFill);
      if (hex) return hex;
    }
    if (node.style?.fill) {
      const hex = normalizeColorToHex(node.style.fill);
      if (hex) return hex;
    }
    if (node.tagName?.toLowerCase() === "svg") break;
    node = node.parentElement;
  }
  try {
    return normalizeColorToHex(getComputedStyle(el).fill);
  } catch {
    return null;
  }
}

function updatePickerVisuals(picker) {
  const { h, s, l } = picker.getHsl();
  const sl = picker.sl();
  const slCursor = picker.slCursor();
  const hue = picker.hue();
  if (sl) sl.style.background = `hsl(${h}, 100%, 50%)`;
  if (slCursor && sl) {
    const w = sl.clientWidth || 1;
    const hgt = sl.clientHeight || 1;
    slCursor.style.left = `${(s / 100) * w}px`;
    slCursor.style.top = `${(1 - l / 100) * hgt}px`;
  }
  if (hue) hue.value = String(Math.round(h));
}

function renderPickerRecent(picker) {
  const recentEl = picker.recent?.();
  if (!recentEl) return;
  recentEl.innerHTML = "";
  picker.getRecent().forEach(color => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "edit-paint-recent-chip";
    btn.style.background = color;
    btn.title = color;
    btn.disabled = !getPrimarySvg() && !state.currentSvg;
    btn.addEventListener("click", () => {
      setPickerColor(picker, color, { addRecent: false });
    });
    recentEl.appendChild(btn);
  });
}

function setPickerColor(picker, hex, { addRecent = true, skipPickerRouting = false } = {}) {
  const normalized = normalizeColorToHex(hex);
  if (!normalized) return;
  const rgb = hexToRgb(normalized);
  if (!rgb) return;
  picker.setColor(normalized);
  picker.setHsl(rgbToHsl(rgb.r, rgb.g, rgb.b));
  const swatch = picker.swatch();
  const hexInput = picker.hex();
  if (swatch) swatch.style.background = normalized;
  if (hexInput) hexInput.value = normalized;
  updatePickerVisuals(picker);
  if (addRecent && picker.recent?.()) {
    picker.setRecent([
      normalized,
      ...picker.getRecent().filter(c => c !== normalized),
    ].slice(0, MAX_PAINT_RECENT));
    renderPickerRecent(picker);
  }
  if (!skipPickerRouting && picker === paintColorPicker) {
    if (state.backgroundEditActive) {
      previewBackgroundColor(normalized);
    } else if (state.paletteRecolorSource) {
      recolorPaths(state.paletteRecolorSource, normalized);
    }
  }
}

function setPickerColorFromHsl(picker, h, s, l, opts = {}) {
  setPickerColor(picker, hslToHex(h, s, l), opts);
}

function setPickerEnabled(picker, enabled) {
  const hex = picker.hex();
  const hue = picker.hue();
  if (hex) hex.disabled = !enabled;
  if (hue) hue.disabled = !enabled;
  const sl = picker.sl();
  if (sl) sl.classList.toggle("disabled", !enabled);
  picker.recent?.()?.querySelectorAll("button").forEach(btn => { btn.disabled = !enabled; });
}

function setPaintColor(hex, opts) {
  setPickerColor(paintColorPicker, hex, opts);
}

function updateBackgroundSwatchDisplay(hex) {
  const normalized = normalizeColorToHex(hex);
  if (!normalized) return;
  state.backgroundColor = normalized;
  if (btnEditBg) btnEditBg.style.background = normalized;
}

function syncBackgroundFromSvg() {
  const bg = getPrimarySvg()?.querySelector(`#${VECTILE_BG_ID}`);
  if (bg) {
    const hex = getElementFillColor(bg);
    if (hex) updateBackgroundSwatchDisplay(hex);
  } else {
    updateBackgroundSwatchDisplay(state.backgroundColor);
  }
}

function updateQuickEditHint() {
  const el = document.getElementById("quick-edit-hint");
  if (!el) return;
  el.textContent = state.backgroundEditActive
    ? "Adjust the paint color above to set background. Click the swatch again to finish."
    : "Edit on the Vectorized tab canvas.";
}

function finishBackgroundEdit(sync = true) {
  if (!state.backgroundEditActive) return;
  state.backgroundEditActive = false;
  btnEditBg?.classList.remove("recolor-active");
  updateQuickEditHint();
  if (sync) afterSvgEdit();
}

function startBackgroundEdit() {
  if (state.backgroundEditActive) {
    finishBackgroundEdit();
    return;
  }
  finishPaletteRecolor(false);
  pushUndo();
  state.backgroundEditActive = true;
  const bg = getPrimarySvg()?.querySelector(`#${VECTILE_BG_ID}`);
  const current = bg ? getElementFillColor(bg) : state.backgroundColor;
  setPaintColor(current || "#ffffff", { addRecent: false, skipPickerRouting: true });
  btnEditBg?.classList.add("recolor-active");
  updateQuickEditHint();
}

function initPaintColorPicker() {
  initColorPicker(paintColorPicker);
  renderPickerRecent(paintColorPicker);
  updateBackgroundSwatchDisplay(state.backgroundColor);
}

function initColorPicker(picker) {
  const sl = picker.sl();
  const hue = picker.hue();
  if (!sl || !hue) return;

  setPickerColor(picker, picker.getColor(), { addRecent: false });

  hue.addEventListener("input", e => {
    const h = parseFloat(e.target.value);
    const hsl = picker.getHsl();
    hsl.h = h;
    picker.setHsl(hsl);
    updatePickerVisuals(picker);
    setPickerColorFromHsl(picker, h, hsl.s, hsl.l, { addRecent: false });
  });

  const pickSl = (clientX, clientY, addRecent = false) => {
    const rect = sl.getBoundingClientRect();
    const x = clamp(clientX - rect.left, 0, rect.width);
    const y = clamp(clientY - rect.top, 0, rect.height);
    const s = (x / rect.width) * 100;
    const l = (1 - y / rect.height) * 100;
    const hsl = picker.getHsl();
    hsl.s = s;
    hsl.l = l;
    picker.setHsl(hsl);
    updatePickerVisuals(picker);
    setPickerColorFromHsl(picker, hsl.h, s, l, { addRecent });
  };

  let slDragging = false;
  sl.addEventListener("pointerdown", e => {
    if (sl.classList.contains("disabled")) return;
    e.preventDefault();
    slDragging = true;
    sl.setPointerCapture(e.pointerId);
    pickSl(e.clientX, e.clientY, false);
  });
  sl.addEventListener("pointermove", e => {
    if (!slDragging) return;
    pickSl(e.clientX, e.clientY, false);
  });
  sl.addEventListener("pointerup", e => {
    if (slDragging) pickSl(e.clientX, e.clientY, true);
    slDragging = false;
    if (sl.hasPointerCapture(e.pointerId)) sl.releasePointerCapture(e.pointerId);
  });
  sl.addEventListener("pointercancel", () => { slDragging = false; });

  picker.hex()?.addEventListener("change", e => {
    let v = e.target.value.trim();
    if (!v.startsWith("#")) v = `#${v}`;
    const hex = normalizeColorToHex(v);
    if (hex) {
      setPickerColor(picker, hex);
    } else if (picker.hex()) {
      picker.hex().value = picker.getColor();
    }
  });
  picker.hex()?.addEventListener("keydown", e => {
    if (e.key === "Enter") picker.hex().blur();
  });
}

function isEditToolActive() {
  return state.editTools.mode !== "pan";
}

function isClickEditTool() {
  return state.editTools.mode === "clickErase"
    || state.editTools.mode === "clickPaint"
    || state.editTools.mode === "eyedropper";
}

function isEyedropperTool() {
  return state.editTools.mode === "eyedropper";
}

function isBoxEditTool() {
  return state.editTools.mode === "boxErase" || state.editTools.mode === "boxPaint";
}

function isEraseTool() {
  return state.editTools.mode === "clickErase" || state.editTools.mode === "boxErase";
}

function resetEditHistory() {
  state.undoStack = [];
  state.redoStack = [];
  updateEditUndoButtons();
}

function updateEditUndoButtons() {
  if (btnEditUndo) btnEditUndo.disabled = state.undoStack.length === 0;
  if (btnEditRedo) btnEditRedo.disabled = state.redoStack.length === 0;
}

function queryEditToolButtons() {
  return quickEditSection?.querySelectorAll(".edit-tool-btn") || [];
}

function setQuickEditEnabled(enabled) {
  const ctrls = [btnEditBg, editSpeckle, btnRemoveSpeckles];
  ctrls.forEach(el => { if (el) el.disabled = !enabled; });
  setPickerEnabled(paintColorPicker, enabled);
  queryEditToolButtons().forEach(btn => {
    btn.disabled = !enabled;
  });
  if (enabled) {
    requestAnimationFrame(() => updatePickerVisuals(paintColorPicker));
  }
}

function pushUndo() {
  const snap = serializeWorkingSvg();
  if (!snap) return;
  state.undoStack.push(snap);
  if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
  state.redoStack = [];
  updateEditUndoButtons();
}

function restoreSvgSnapshot(svgStr) {
  renderSvg(svgStr);
  state.hiddenColors.clear();
  state.recoloredColors = {};
  buildPalettePanel(extractPaletteFromCurrentSvg());
  if (typeof window.__onSvgRendered === "function") window.__onSvgRendered();
}

function undoEdit() {
  if (!state.undoStack.length) return;
  const current = serializeWorkingSvg();
  if (current) state.redoStack.push(current);
  restoreSvgSnapshot(state.undoStack.pop());
  updateEditUndoButtons();
}

function redoEdit() {
  if (!state.redoStack.length) return;
  const current = serializeWorkingSvg();
  if (current) state.undoStack.push(current);
  restoreSvgSnapshot(state.redoStack.pop());
  updateEditUndoButtons();
}

function afterSvgEdit() {
  syncSplitSvgFromPrimary();
  const palette = extractPaletteFromCurrentSvg();
  buildPalettePanel(palette);
  updateStatusBarFromDom();
  if (typeof window.__onSvgRendered === "function") window.__onSvgRendered();
}

function updateStatusBarFromDom() {
  const svg = getPrimarySvg();
  if (!svg) return;
  const pathCount = svg.querySelectorAll("path").length;
  statusPaths.textContent = `${pathCount} paths`;
  const bytes = new Blob([serializeWorkingSvg()]).size;
  statusSize.textContent = `${(bytes / 1024).toFixed(1)} KB`;
}

function resolveDrawable(el) {
  if (!el) return null;
  const found = el.closest?.(EDIT_DRAWABLE);
  if (!found || found.id === VECTILE_BG_ID) return null;
  return found;
}

function pathsInBox(svg, clientX1, clientY1, clientX2, clientY2) {
  const minX = Math.min(clientX1, clientX2);
  const maxX = Math.max(clientX1, clientX2);
  const minY = Math.min(clientY1, clientY2);
  const maxY = Math.max(clientY1, clientY2);
  return [...svg.querySelectorAll(EDIT_DRAWABLE)].filter(el => {
    if (el.id === VECTILE_BG_ID) return false;
    const r = el.getBoundingClientRect();
    return !(r.right < minX || r.left > maxX || r.bottom < minY || r.top > maxY);
  });
}

function paintElement(el, color) {
  el.setAttribute("fill", color);
  el.style.fill = color;
  const stroke = el.getAttribute("stroke");
  if (stroke && stroke !== "none") {
    el.setAttribute("stroke", color);
    el.style.stroke = color;
  }
}

function updateBackgroundRect(color) {
  const fill = normalizeColorToHex(color);
  if (!fill) return false;
  const svgs = [
    svgContainer.querySelector("svg"),
    splitSvgDiv.querySelector("svg"),
  ].filter(Boolean);
  if (!svgs.length) return false;
  const dims = getSourceSvgDims();
  const w = dims?.w || 1000;
  const h = dims?.h || 1000;
  svgs.forEach(svg => {
    let bg = svg.querySelector(`#${VECTILE_BG_ID}`);
    if (!bg) {
      bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      bg.id = VECTILE_BG_ID;
      bg.setAttribute("x", "0");
      bg.setAttribute("y", "0");
      bg.setAttribute("width", String(w));
      bg.setAttribute("height", String(h));
      svg.insertBefore(bg, svg.firstChild);
    }
    bg.setAttribute("fill", fill);
  });
  return true;
}

function previewBackgroundColor(color) {
  if (!updateBackgroundRect(color)) return;
  updateBackgroundSwatchDisplay(color);
}

function removeSpeckles(thresholdPx) {
  const svg = getPrimarySvg();
  if (!svg) return;
  const dims = getSourceSvgDims();
  if (!dims) return;
  const viewMax = Math.max(dims.w, dims.h);
  const container = panVectorized || svgContainer;
  const cw = container?.clientWidth || viewMax;
  const scale = viewMax / Math.max(cw, 1);
  const threshold = thresholdPx * scale;

  pushUndo();
  let removed = 0;
  svg.querySelectorAll(EDIT_DRAWABLE).forEach(el => {
    if (el.id === VECTILE_BG_ID) return;
    try {
      const bb = el.getBBox();
      if (Math.max(bb.width, bb.height) < threshold) {
        el.remove();
        removed++;
      }
    } catch { /* skip */ }
  });
  if (removed === 0) {
    state.undoStack.pop();
    updateEditUndoButtons();
    return;
  }
  afterSvgEdit();
}

function removeHoverHighlight() {
  getPrimarySvg()?.querySelectorAll(".edit-hover-target").forEach(el => {
    el.classList.remove("edit-hover-target");
  });
}

function setEditToolMode(mode) {
  state.editTools.mode = mode;
  queryEditToolButtons().forEach(btn => {
    btn.classList.toggle("active", btn.dataset.editTool === mode);
  });
  if (panVectorized) {
    panVectorized.classList.toggle("edit-mode-click", isClickEditTool() && !isEyedropperTool());
    panVectorized.classList.toggle("edit-mode-eyedropper", isEyedropperTool());
    panVectorized.classList.toggle("edit-mode-box", isBoxEditTool());
  }
  removeHoverHighlight();
  hideBoxOverlay();
}

function hideBoxOverlay() {
  if (!editBoxOverlay) return;
  editBoxOverlay.classList.add("hidden");
  editBoxOverlay.style.cssText = "";
}

function updateBoxOverlay(clientX1, clientY1, clientX2, clientY2) {
  if (!editBoxOverlay || !panVectorized) return;
  const rect = panVectorized.getBoundingClientRect();
  const left = Math.min(clientX1, clientX2) - rect.left;
  const top = Math.min(clientY1, clientY2) - rect.top;
  const width = Math.abs(clientX2 - clientX1);
  const height = Math.abs(clientY2 - clientY1);
  editBoxOverlay.classList.remove("hidden", "erase", "paint");
  editBoxOverlay.classList.add(isEraseTool() ? "erase" : "paint");
  editBoxOverlay.style.left = `${left}px`;
  editBoxOverlay.style.top = `${top}px`;
  editBoxOverlay.style.width = `${width}px`;
  editBoxOverlay.style.height = `${height}px`;
}

function performClickEdit(target) {
  if (isEyedropperTool()) {
    const el = resolveDrawable(target);
    if (!el) return;
    const color = getElementFillColor(el);
    if (color) setPaintColor(color);
    return;
  }
  const el = resolveDrawable(target);
  if (!el) return;
  pushUndo();
  if (state.editTools.mode === "clickErase") {
    el.remove();
  } else {
    paintElement(el, state.editTools.paintColor);
  }
  afterSvgEdit();
}

function performBoxEdit(clientX1, clientY1, clientX2, clientY2) {
  const svg = getPrimarySvg();
  if (!svg) return;
  const targets = pathsInBox(svg, clientX1, clientY1, clientX2, clientY2);
  if (!targets.length) return;
  pushUndo();
  if (isEraseTool()) {
    targets.forEach(el => el.remove());
  } else {
    targets.forEach(el => paintElement(el, state.editTools.paintColor));
  }
  afterSvgEdit();
}

function initSvgEditTools() {
  queryEditToolButtons().forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      setEditToolMode(btn.dataset.editTool);
    });
  });

  btnEditBg?.addEventListener("click", () => {
    if (btnEditBg.disabled) return;
    startBackgroundEdit();
  });

  btnRemoveSpeckles?.addEventListener("click", () => {
    const threshold = parseInt(editSpeckle?.value || "4", 10);
    removeSpeckles(threshold);
  });

  btnEditUndo?.addEventListener("click", undoEdit);
  btnEditRedo?.addEventListener("click", redoEdit);

  if (!panVectorized) return;

  let boxDragging = false;
  let boxStart = null;

  panVectorized.addEventListener("pointerdown", e => {
    if (!isEditToolActive() || !getPrimarySvg()) return;
    if (e.button !== 0) return;

    if (isClickEditTool()) {
      e.stopPropagation();
      e.preventDefault();
      performClickEdit(e.target);
      return;
    }

    if (isBoxEditTool()) {
      e.stopPropagation();
      e.preventDefault();
      boxDragging = true;
      boxStart = { x: e.clientX, y: e.clientY };
      panVectorized.setPointerCapture(e.pointerId);
      updateBoxOverlay(e.clientX, e.clientY, e.clientX, e.clientY);
    }
  });

  panVectorized.addEventListener("pointermove", e => {
    if (!boxDragging || !boxStart) return;
    updateBoxOverlay(boxStart.x, boxStart.y, e.clientX, e.clientY);
  });

  panVectorized.addEventListener("pointerup", e => {
    if (!boxDragging) return;
    boxDragging = false;
    hideBoxOverlay();
    if (boxStart) {
      if (Math.abs(e.clientX - boxStart.x) >= 4 || Math.abs(e.clientY - boxStart.y) >= 4) {
        performBoxEdit(boxStart.x, boxStart.y, e.clientX, e.clientY);
      }
    }
    boxStart = null;
    if (panVectorized.hasPointerCapture(e.pointerId)) {
      panVectorized.releasePointerCapture(e.pointerId);
    }
  });

  panVectorized.addEventListener("pointercancel", e => {
    boxDragging = false;
    boxStart = null;
    hideBoxOverlay();
    if (panVectorized.hasPointerCapture(e.pointerId)) {
      panVectorized.releasePointerCapture(e.pointerId);
    }
  });

  panVectorized.addEventListener("mousemove", e => {
    if (!isClickEditTool()) {
      removeHoverHighlight();
      return;
    }
    const el = resolveDrawable(e.target);
    removeHoverHighlight();
    if (el) el.classList.add("edit-hover-target");
  });

  panVectorized.addEventListener("mouseleave", removeHoverHighlight);
}

// ── Palette panel ─────────────────────────────────────────────
function paletteFillMatchers(originalColor) {
  const display = state.recoloredColors[originalColor] || originalColor;
  return new Set([
    originalColor,
    originalColor.toUpperCase(),
    display,
    display.toUpperCase(),
  ]);
}

function forEachPathWithPaletteColor(svg, originalColor, fn) {
  const matchers = paletteFillMatchers(originalColor);
  svg.querySelectorAll("[fill]").forEach(el => {
    const fill = el.getAttribute("fill");
    if (fill && matchers.has(fill)) fn(el);
  });
}

function updatePaletteSwatchDisplay(originalColor, displayColor) {
  const card = paletteGrid.querySelector(`[data-color="${originalColor}"]`);
  if (!card) return;
  const sw = card.querySelector(".swatch-color");
  const dot = card.querySelector(".swatch-picker");
  if (sw) sw.style.background = displayColor;
  if (dot) dot.style.background = displayColor;
}

function updatePaletteHint() {
  const el = document.getElementById("palette-hint");
  if (!el) return;
  el.textContent = state.paletteRecolorSource
    ? "Adjust the paint color above to recolor this layer. Click the ring again to finish."
    : "Click swatch to hide. Click ring to recolor with the paint picker above.";
}

function finishPaletteRecolor(sync = true) {
  if (!state.paletteRecolorSource) return;
  state.paletteRecolorSource = null;
  paletteGrid?.querySelectorAll(".recolor-active").forEach(c => {
    c.classList.remove("recolor-active");
  });
  updatePaletteHint();
  if (sync) afterSvgEdit();
}

function startPaletteRecolor(originalColor) {
  if (state.paletteRecolorSource === originalColor) {
    finishPaletteRecolor();
    return;
  }
  finishBackgroundEdit(false);
  if (state.paletteRecolorSource) finishPaletteRecolor(false);
  pushUndo();
  state.paletteRecolorSource = originalColor;
  const display = state.recoloredColors[originalColor] || originalColor;
  setPaintColor(display, { addRecent: false, skipPickerRouting: true });
  paletteGrid.querySelectorAll(".swatch-card").forEach(c => {
    c.classList.toggle("recolor-active", c.dataset.color === originalColor);
  });
  updatePaletteHint();
}

function buildPalettePanel(palette) {
  paletteGrid.innerHTML = "";
  btnResetPalette.disabled = false;
  setQuickEditEnabled(!!getPrimarySvg() || !!state.currentSvg);

  if (!palette || palette.length === 0) {
    palettePlaceholder.style.display = "";
    palettePlaceholder.querySelector("p").textContent = "No colors found in SVG";
    return;
  }
  palettePlaceholder.style.display = "none";

  palette.forEach(({ color, count }) => {
    const displayColor = state.recoloredColors[color] || color;
    const card = document.createElement("div");
    card.className = "swatch-card";
    if (state.hiddenColors.has(color)) card.classList.add("hidden-color");
    card.dataset.color = color;

    const swatch = document.createElement("div");
    swatch.className = "swatch-color";
    swatch.style.background = displayColor;

    const countEl = document.createElement("span");
    countEl.className = "swatch-count";
    countEl.textContent = count;

    const pickerDot = document.createElement("div");
    pickerDot.className = "swatch-picker";
    pickerDot.style.background = displayColor;
    pickerDot.title = "Recolor with paint picker";

    const paintBtn = document.createElement("button");
    paintBtn.type = "button";
    paintBtn.className = "swatch-paint-btn";
    paintBtn.title = "Set as paint color";
    paintBtn.textContent = "\u25cf";
    paintBtn.addEventListener("click", e => {
      e.stopPropagation();
      finishBackgroundEdit(false);
      finishPaletteRecolor(false);
      setPaintColor(displayColor);
    });

    pickerDot.addEventListener("click", e => {
      e.stopPropagation();
      startPaletteRecolor(color);
    });

    card.addEventListener("click", () => {
      finishBackgroundEdit(false);
      finishPaletteRecolor(false);
      pushUndo();
      toggleColorVisibility(color, card);
      afterSvgEdit();
    });
    card.append(paintBtn, swatch, countEl, pickerDot);
    paletteGrid.appendChild(card);
  });

  if (state.paletteRecolorSource) {
    const active = paletteGrid.querySelector(
      `[data-color="${state.paletteRecolorSource}"]`,
    );
    if (active) active.classList.add("recolor-active");
  }
  updatePaletteHint();
}

function toggleColorVisibility(originalColor, card) {
  const svgs = [
    svgContainer.querySelector("svg"),
    splitSvgDiv.querySelector("svg"),
  ].filter(Boolean);

  if (state.hiddenColors.has(originalColor)) {
    state.hiddenColors.delete(originalColor);
    card.classList.remove("hidden-color");
    svgs.forEach(svg => {
      forEachPathWithPaletteColor(svg, originalColor, el => {
        el.style.display = "";
      });
    });
  } else {
    state.hiddenColors.add(originalColor);
    card.classList.add("hidden-color");
    svgs.forEach(svg => {
      forEachPathWithPaletteColor(svg, originalColor, el => {
        el.style.display = "none";
      });
    });
  }
}

function recolorPaths(originalColor, newColor) {
  const normalized = normalizeColorToHex(newColor);
  if (!normalized) return;
  const svgs = [
    svgContainer.querySelector("svg"),
    splitSvgDiv.querySelector("svg"),
  ].filter(Boolean);

  svgs.forEach(svg => {
    forEachPathWithPaletteColor(svg, originalColor, el => {
      el.setAttribute("fill", normalized);
    });
  });

  state.recoloredColors[originalColor] = normalized;
  updatePaletteSwatchDisplay(originalColor, normalized);
}

btnResetPalette.addEventListener("click", () => {
  finishBackgroundEdit(false);
  finishPaletteRecolor(false);
  state.hiddenColors.clear();
  state.recoloredColors = {};
  resetEditHistory();
  setEditToolMode("pan");
  if (state.originalTraceSvg || state.currentSvg) {
    const src = state.originalTraceSvg || state.currentSvg;
    renderSvg(src);
    state.currentSvg = src;
    buildPalettePanel(extractPaletteFromCurrentSvg());
  }
});

function extractPaletteFromCurrentSvg() {
  const svg = svgContainer.querySelector("svg");
  if (!svg) return [];
  const counts = {};
  svg.querySelectorAll("[fill]").forEach(el => {
    const c = el.getAttribute("fill");
    if (c && c.startsWith("#")) counts[c.toLowerCase()] = (counts[c.toLowerCase()] || 0) + 1;
  });
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([color, count]) => ({ color, count }));
}

// ── Tabs ──────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    // Print tab is allowed even before upload (shows its own placeholder).
    // Other tabs only work after a successful upload.
    const tab = btn.dataset.tab;
    if (tab !== "print" && !state.imageId) return;
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.activeTab = tab;
    document.querySelector(".workspace").setAttribute("data-active-tab", tab);
    showPane(tab);
    // When entering Print, ensure the WYSIWYG canvas is up to date
    if (tab === "print") {
      refreshPrintEnabled();
      renderPosterCanvas();
    }
  });
});

function getCurrentTab() {
  const active = document.querySelector(".tab-btn.active");
  return active ? active.dataset.tab : "vectorized";
}

function showPane(tab) {
  const panes = {
    original:   "pane-original",
    vectorized: "pane-vectorized",
    split:      "pane-split",
    print:      "pane-print",
  };
  Object.entries(panes).forEach(([key, id]) => {
    document.getElementById(id).classList.toggle("active", key === tab);
  });
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  state.activeTab = tab;
  document.querySelector(".workspace")?.setAttribute("data-active-tab", tab);
  if (tab === "split" || tab === "vectorized") {
    schedulePreviewFit();
  }
}

// ── Zoom / Pan ────────────────────────────────────────────────
// Each preview pane gets its own independent zoom-pan zone. The split pane
// shares one zone across both halves so they pan/zoom in sync, which is the
// whole point of side-by-side comparison.

const zoomPanZones = []; // {applyTransform, reset} entries, used by renderSvg

function setupZoomPan(container, contentsGetter, { allowPan = () => true } = {}) {
  if (!container) return;

  let scale = 1, tx = 0, ty = 0;
  let dragging = false, startX = 0, startY = 0;

  function applyTransform() {
    const contents = (contentsGetter() || []).filter(Boolean);
    contents.forEach(el => {
      el.style.transformOrigin = "center center";
      el.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    });
  }

  function reset() {
    scale = 1; tx = 0; ty = 0;
    applyTransform();
  }

  container.addEventListener("wheel", e => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    scale = Math.min(Math.max(scale * delta, 0.1), 20);
    applyTransform();
  }, { passive: false });

  container.addEventListener("mousedown", e => {
    if (!allowPan()) return;
    // Don't hijack clicks on UI elements like split labels
    if (e.target.classList.contains("split-label")) return;
    dragging = true;
    startX = e.clientX - tx;
    startY = e.clientY - ty;
    container.style.cursor = "grabbing";
    e.preventDefault();
  });

  window.addEventListener("mousemove", e => {
    if (!dragging) return;
    tx = e.clientX - startX;
    ty = e.clientY - startY;
    applyTransform();
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    container.style.cursor = "";
  });

  container.addEventListener("dblclick", reset);

  zoomPanZones.push({ applyTransform, reset });
}

function reapplyAllZoomPan() {
  zoomPanZones.forEach(z => z.applyTransform());
}

function resetAllZoomPan() {
  zoomPanZones.forEach(z => z.reset());
}

function setupSplitZoomPan(container) {
  if (!container) return;

  let scale = 1, tx = 0, ty = 0;
  let dragging = false, startX = 0, startY = 0;

  function targets() {
    return [
      document.getElementById("split-original"),
      document.getElementById("split-svg"),
    ].filter(Boolean);
  }

  function applyTransform() {
    const t = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    targets().forEach(el => {
      el.style.transformOrigin = "center center";
      el.style.transform = t;
    });
  }

  function reset() {
    scale = 1; tx = 0; ty = 0;
    applyTransform();
  }

  container.addEventListener("wheel", e => {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const mx = e.clientX - (rect.left + rect.width / 2);
    const my = e.clientY - (rect.top + rect.height / 2);
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.min(Math.max(scale * factor, 0.1), 20);
    tx = mx - (mx - tx) * (newScale / scale);
    ty = my - (my - ty) * (newScale / scale);
    scale = newScale;
    applyTransform();
  }, { passive: false });

  container.addEventListener("mousedown", e => {
    if (e.target.classList.contains("split-label")) return;
    dragging = true;
    startX = e.clientX - tx;
    startY = e.clientY - ty;
    container.style.cursor = "grabbing";
    e.preventDefault();
  });

  window.addEventListener("mousemove", e => {
    if (!dragging) return;
    tx = e.clientX - startX;
    ty = e.clientY - startY;
    applyTransform();
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    container.style.cursor = "";
  });

  container.addEventListener("dblclick", reset);

  zoomPanZones.push({ applyTransform, reset });
}

function initZoomPan() {
  // Original tab — the <img> element is fixed; only its src changes
  setupZoomPan(
    document.getElementById("pan-original"),
    () => [document.getElementById("original-img")]
  );

  // Vectorized tab — pan/zoom the SVG element (wrapper stays passive for layout).
  setupZoomPan(
    document.getElementById("pan-vectorized"),
    () => [document.querySelector("#svg-container svg")],
    { allowPan: () => !isEditToolActive() }
  );

  // Print tab — the entire poster canvas (poster + image + grid handles)
  // is one navigable zone. Image / grid manipulation happens inside the SVG
  // via dedicated drag handlers, so the canvas-level pan is just for
  // panning/zooming the camera.
  setupZoomPan(
    document.getElementById("pan-print"),
    () => [document.getElementById("poster-canvas")]
  );

  // Side-by-Side — synced pan/zoom on each image; divider stays fixed in the centre.
  setupSplitZoomPan(document.getElementById("pane-split"));
}

initZoomPan();
initPaintColorPicker();
initSvgEditTools();

splitOrigImg.addEventListener("load", () => {
  schedulePreviewFit();
});
window.addEventListener("resize", () => {
  const tab = getCurrentTab();
  if (tab === "split" || tab === "vectorized") {
    schedulePreviewFit();
  }
});

// ── Download ──────────────────────────────────────────────────
btnDownload.addEventListener("click", () => downloadSvg());

async function downloadSvg() {
  if (!state.currentSvg && !getPrimarySvg()) return;

  setDownloadButtonsBusy(true);
  try {
    let svgStr = serializeSvgForExport();
    if (!svgStr) return;

    // Full-res re-trace only when preview was downscaled and DOM has no structural edits.
    if (state.resizePreview && state.undoStack.length === 0
        && state.hiddenColors.size === 0 && Object.keys(state.recoloredColors).length === 0) {
      const fullRes = await fetchFinalSvg();
      if (fullRes) svgStr = fullRes;
    }

    const blob = new Blob([svgStr], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "vectile-output.svg";
    a.click();
    URL.revokeObjectURL(url);
  } finally {
    setDownloadButtonsBusy(false);
  }
}

async function fetchFinalSvg() {
  beginTracing();
  try {
    const body = {
      image_id: state.imageId,
      engine: state.engine,
      params: state.params,
      quantize_colors: state.quantizeColors,
      resize_preview: false, // full-resolution re-trace for the export
    };
    const res = await fetch("/api/vectorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "Final trace failed" }));
      alert("Could not generate full-resolution SVG: " + (err.detail || "unknown error"));
      return null;
    }
    const data = await res.json();
    return data.svg;
  } finally {
    endTracing();
  }
}

function applyPaletteEdits(svgStr) {
  // Apply hide/recolor edits to a fresh SVG string. Used so a full-resolution
  // re-trace can carry the same palette edits the user made on the preview.
  const hasEdits =
    state.hiddenColors.size > 0 ||
    Object.keys(state.recoloredColors).length > 0;
  if (!hasEdits) return svgStr;

  const doc = new DOMParser().parseFromString(svgStr, "image/svg+xml");
  const root = doc.documentElement;

  // Recolors first, so a subsequent hide-by-original-color still finds nothing
  // when the user already recolored it (we only hide what still has the original fill).
  for (const [original, replacement] of Object.entries(state.recoloredColors)) {
    root.querySelectorAll(`[fill="${original}"], [fill="${original.toUpperCase()}"]`).forEach(el => {
      el.setAttribute("fill", replacement);
    });
  }

  state.hiddenColors.forEach(color => {
    // Match both the original color (in case of no recolor) and any current value
    // the recolor map points at, so a "recolor then hide" sequence still works.
    const candidates = new Set([color, color.toUpperCase()]);
    if (state.recoloredColors[color]) {
      candidates.add(state.recoloredColors[color]);
      candidates.add(state.recoloredColors[color].toUpperCase());
    }
    candidates.forEach(c => {
      root.querySelectorAll(`[fill="${c}"]`).forEach(el => {
        el.setAttribute("style", (el.getAttribute("style") || "") + ";display:none");
      });
    });
  });

  return new XMLSerializer().serializeToString(root);
}

function setDownloadButtonsBusy(busy) {
  if (busy) {
    btnDownload.dataset.label = btnDownload.textContent;
    btnDownload.textContent = "Tracing…";
  } else {
    if (btnDownload.dataset.label) btnDownload.textContent = btnDownload.dataset.label;
  }
  btnDownload.disabled = busy;
}

// ── Reset ─────────────────────────────────────────────────────
btnReset.addEventListener("click", () => {
  const e = state.engines[state.engine];
  if (!e) return;
  const defaults = {};
  e.param_schema.forEach(p => { defaults[p.name] = p.default; });
  buildParamControls(defaults);
  presetSelect.value = "";
  quantizeSlider.value = 0;
  quantizeVal.textContent = "Off";
  state.quantizeColors = 0;
  state.resizePreview = true;
  resizeCheckbox.checked = true;
  scheduleVectorize();
});

// ── Status bar ────────────────────────────────────────────────
function updateStatusBar(data) {
  const svgBytes = new Blob([data.svg]).size;
  const kb = (svgBytes / 1024).toFixed(1);
  const svg = svgContainer.querySelector("svg");
  const pathCount = svg ? svg.querySelectorAll("path").length : 0;
  statusSize.textContent = `SVG: ${kb} KB`;
  statusTime.textContent = `${data.elapsed_ms} ms`;
  statusPaths.textContent = `${pathCount} paths`;
}

// ── Tracing overlay (all preview tabs) ───────────────────────
function updateTracingOverlay() {
  if (!tracingOverlay) return;
  const visible = tracingInFlight > 0 || tracingDebouncePending;
  tracingOverlay.style.display = visible ? "" : "none";
  tracingOverlay.setAttribute("aria-busy", visible ? "true" : "false");
}

function beginTracing() {
  tracingInFlight++;
  updateTracingOverlay();
}

function endTracing() {
  tracingInFlight = Math.max(0, tracingInFlight - 1);
  updateTracingOverlay();
}

/* ════════════════════════════════════════════════════════════════════════
   Print / Poster tab
   ════════════════════════════════════════════════════════════════════════ */

const PRINT = {
  // Sections
  controls:          document.getElementById("print-controls"),
  controlsBody:      document.getElementById("print-controls-body"),
  placeholder:       document.getElementById("print-placeholder"),
  tabPlaceholder:    document.getElementById("print-tab-placeholder"),

  // Paper / mode / poster
  paperSelect:       document.getElementById("print-paper"),
  customRow:         document.getElementById("print-custom-row"),
  customW:           document.getElementById("print-custom-w"),
  customH:           document.getElementById("print-custom-h"),
  orientationRow:    document.getElementById("print-orientation-row"),
  marginSlider:      document.getElementById("print-margin"),
  marginVal:         document.getElementById("print-margin-val"),
  posterModeSelect:  document.getElementById("print-poster-mode"),
  posterSizeSection: document.getElementById("print-poster-size-section"),
  singlePageHint:    document.getElementById("print-single-page-hint"),
  dimRow:            document.getElementById("print-dim-row"),
  posterW:           document.getElementById("print-poster-w"),
  posterH:           document.getElementById("print-poster-h"),
  aspectLock:        document.getElementById("print-aspect-lock"),
  unitsTabs:         document.getElementById("print-units-tabs"),
  unitLabels:        document.querySelectorAll("[data-unit-label]"),
  gridRow:           document.getElementById("print-grid-row"),
  gridCols:          document.getElementById("print-grid-cols"),
  gridRows:          document.getElementById("print-grid-rows"),
  scaleRow:          document.getElementById("print-scale-row"),
  scaleSlider:       document.getElementById("print-scale"),
  scaleVal:          document.getElementById("print-scale-val"),
  overlapSection:    document.getElementById("print-overlap-section"),
  decorationsSection: document.getElementById("print-decorations-section"),
  overlapSlider:     document.getElementById("print-overlap"),
  overlapVal:        document.getElementById("print-overlap-val"),
  modeTabs:          document.getElementById("print-mode-tabs"),
  summary:           document.getElementById("print-summary"),
  btnPdf:            document.getElementById("btn-print-pdf"),

  // Poster canvas (WYSIWYG preview, lives in pane-print)
  posterCanvas:      document.getElementById("poster-canvas"),
  posterBg:          document.getElementById("poster-bg"),
  posterImage:       document.getElementById("poster-image"),
  posterGrid:        document.getElementById("poster-grid"),
  posterHandles:     document.getElementById("poster-handles"),
  panPrint:          document.getElementById("pan-print"),

  // Image placement controls (slim: just fit + rotation; rest is canvas-direct)
  imageFit:          document.getElementById("print-image-fit"),
  imageRotSlider:    document.getElementById("print-image-rot"),
  imageRotVal:       document.getElementById("print-image-rot-val"),
  btnImageReset:     document.getElementById("btn-image-reset"),
  btnToggleGrid:     document.getElementById("btn-toggle-grid"),
};

const SVG_NS = "http://www.w3.org/2000/svg";

// ── Units conversion (mm <-> in) ─────────────────────────────
const MM_PER_IN = 25.4;
function mmToUnit(mm) {
  return state.printSettings.units === "in" ? mm / MM_PER_IN : mm;
}
function unitToMm(v) {
  return state.printSettings.units === "in" ? v * MM_PER_IN : v;
}
function fmtLen(mm, mmDecimals = 0, inDecimals = 2) {
  const v = mmToUnit(mm);
  const d = state.printSettings.units === "in" ? inDecimals : mmDecimals;
  return v.toFixed(d);
}
function unitSuffix() { return state.printSettings.units; }

// ── Source SVG dimensions (from viewBox / width attrs) ───────
function parseSvgLength(val) {
  if (val == null || val === "") return NaN;
  const m = String(val).trim().match(/^([+-]?[\d.]+)\s*(mm|cm|in|pt|px|pc|%)?$/i);
  if (!m) return parseFloat(val);
  const n = parseFloat(m[1]);
  const unit = (m[2] || "px").toLowerCase();
  switch (unit) {
    case "mm": return n;
    case "cm": return n * 10;
    case "in": return n * 25.4;
    case "pt": return n * 25.4 / 72;
    case "pc": return n * 25.4 / 6;
    case "px": return n;
    case "%": return NaN;
    default: return n;
  }
}

function getSourceSvgDims() {
  const svg = svgContainer.querySelector("svg");
  if (!svg) return null;
  const vb = svg.getAttribute("viewBox");
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { w: parts[2], h: parts[3] };
    }
  }
  const w = parseSvgLength(svg.getAttribute("width"));
  const h = parseSvgLength(svg.getAttribute("height"));
  if (w > 0 && h > 0) return { w, h };
  return null;
}

function cloneSvgForPoster(traced) {
  const src = getSourceSvgDims();
  if (!src) return null;

  const nested = document.createElementNS(SVG_NS, "svg");
  const vb = traced.getAttribute("viewBox");
  nested.setAttribute("viewBox", vb || `0 0 ${src.w} ${src.h}`);
  nested.setAttribute("width", String(src.w));
  nested.setAttribute("height", String(src.h));
  nested.setAttribute("overflow", "visible");
  nested.setAttribute("preserveAspectRatio", "none");

  for (const attr of traced.getAttributeNames()) {
    if (attr === "width" || attr === "height" || attr === "viewBox") continue;
    if (attr.startsWith("xmlns") || attr.startsWith("xml:")) {
      nested.setAttribute(attr, traced.getAttribute(attr));
    }
  }

  Array.from(traced.childNodes).forEach(node => {
    nested.appendChild(node.cloneNode(true));
  });
  return nested;
}

let printDebounceTimer = null;

// ── Right-panel tab strip ────────────────────────────────────
document.querySelectorAll(".right-tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".right-tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".right-tab-pane").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    const target = btn.dataset.rtab;
    document.querySelector(`.right-tab-pane[data-rtab-pane="${target}"]`).classList.add("active");

    if (target === "print") refreshPrintEnabled();
  });
});

// ── Bootstrap: load paper sizes ──────────────────────────────
(async () => {
  const sizes = await fetch("/api/print/paper-sizes").then(r => r.json());
  state.paperSizes = sizes;
  rebuildPaperSelectLabels();
  refreshPrintInputs();
  refreshPrintEnabled();
})();

function refreshPrintEnabled() {
  const ready = !!state.imageId && !!state.currentSvg;
  // The print controls are ALWAYS visible — settings are editable even before
  // an image is loaded. We only gate the actual PDF generation.
  if (PRINT.placeholder) PRINT.placeholder.style.display = ready ? "none" : "";
  if (PRINT.btnPdf) PRINT.btnPdf.disabled = !ready;

  // First render after upload: snap poster to source aspect.
  if (ready && state.printSettings.posterAutoFit) {
    autoFitPosterToSource();
  }
  // Sync UI to current state — runs whether or not an image is loaded so the
  // defaults (mode, orientation, units, etc.) are visually preselected.
  refreshPrintInputs();
  if (ready) schedulePrintCalc();
}

function syncCustomPaperFromInputs() {
  if (state.printSettings.paper_name !== "Custom") return;
  state.printSettings.paper_w_mm = unitToMm(parseFloat(PRINT.customW.value) || 0);
  state.printSettings.paper_h_mm = unitToMm(parseFloat(PRINT.customH.value) || 0);
}

function updatePrintModeUi() {
  const tiled = !state.printSettings.single_page;
  PRINT.overlapSection.style.display = tiled ? "" : "none";
  if (PRINT.decorationsSection) PRINT.decorationsSection.style.display = tiled ? "" : "none";
  if (PRINT.posterSizeSection) PRINT.posterSizeSection.style.display = tiled ? "" : "none";
  if (PRINT.singlePageHint) PRINT.singlePageHint.style.display = tiled ? "none" : "";
}

// ── Mode tabs (Tile / Single) ────────────────────────────────
PRINT.modeTabs.querySelectorAll("button").forEach(btn => {
  btn.addEventListener("click", () => {
    PRINT.modeTabs.querySelectorAll("button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.printSettings.single_page = btn.dataset.printMode === "single";
    updatePrintModeUi();
    renderPosterGrid();
    schedulePrintCalc();
  });
});

// ── Orientation tabs ─────────────────────────────────────────
PRINT.orientationRow.querySelectorAll("button").forEach(btn => {
  btn.addEventListener("click", () => {
    PRINT.orientationRow.querySelectorAll("button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.printSettings.orientation = btn.dataset.printOrientation;
    schedulePrintCalc();
  });
});

// ── Paper size selector ──────────────────────────────────────
PRINT.paperSelect.addEventListener("change", () => {
  state.printSettings.paper_name = PRINT.paperSelect.value;
  PRINT.customRow.style.display = PRINT.paperSelect.value === "Custom" ? "" : "none";
  syncCustomPaperFromInputs();
  schedulePrintCalc();
});
function customPaperSelectLabel() {
  const w = state.printSettings.paper_w_mm;
  const h = state.printSettings.paper_h_mm;
  const u = unitSuffix();
  if (w > 0 && h > 0) {
    return `Custom (${fmtLen(w)} \u00d7 ${fmtLen(h)} ${u})`;
  }
  return "Custom (W\u00d7L)";
}

function onCustomPaperInput() {
  syncCustomPaperFromInputs();
  if (state.printSettings.paper_name === "Custom") {
    rebuildPaperSelectLabels();
  }
  schedulePrintCalc();
}
PRINT.customW.addEventListener("input", onCustomPaperInput);
PRINT.customH.addEventListener("input", onCustomPaperInput);
PRINT.customW.addEventListener("change", onCustomPaperInput);
PRINT.customH.addEventListener("change", onCustomPaperInput);

// ── Margin (live update on input drag) ───────────────────────
PRINT.marginSlider.addEventListener("input", () => {
  const mm = parseFloat(PRINT.marginSlider.value);
  state.printSettings.margin_mm = mm;
  PRINT.marginVal.textContent = `${fmtLen(mm, 0, 2)} ${unitSuffix()}`;
  schedulePrintCalc();
});

// ── Overlap (live update on input drag) ──────────────────────
PRINT.overlapSlider.addEventListener("input", () => {
  const mm = parseFloat(PRINT.overlapSlider.value);
  state.printSettings.overlap_mm = mm;
  PRINT.overlapVal.textContent = `${fmtLen(mm, 0, 2)} ${unitSuffix()}`;
  schedulePrintCalc();
});

// ── Poster size mode ─────────────────────────────────────────
PRINT.posterModeSelect.addEventListener("change", () => {
  state.printSettings.poster_mode = PRINT.posterModeSelect.value;
  PRINT.dimRow.style.display = state.printSettings.poster_mode === "dimensions" ? "" : "none";
  PRINT.gridRow.style.display = state.printSettings.poster_mode === "grid" ? "" : "none";
  PRINT.scaleRow.style.display = state.printSettings.poster_mode === "scale" ? "" : "none";
  schedulePrintCalc();
});

PRINT.posterW.addEventListener("change", () => {
  state.printSettings.poster_w_mm = unitToMm(parseFloat(PRINT.posterW.value));
  // Any manual edit means user has taken control — stop auto-fitting on render
  state.printSettings.posterAutoFit = false;
  if (state.printSettings.aspectLocked) {
    const src = getSourceSvgDims();
    if (src) {
      state.printSettings.poster_h_mm = state.printSettings.poster_w_mm * (src.h / src.w);
      PRINT.posterH.value = fmtLen(state.printSettings.poster_h_mm);
    }
  }
  schedulePrintCalc();
});
PRINT.posterH.addEventListener("change", () => {
  state.printSettings.poster_h_mm = unitToMm(parseFloat(PRINT.posterH.value));
  state.printSettings.posterAutoFit = false;
  if (state.printSettings.aspectLocked) {
    const src = getSourceSvgDims();
    if (src) {
      state.printSettings.poster_w_mm = state.printSettings.poster_h_mm * (src.w / src.h);
      PRINT.posterW.value = fmtLen(state.printSettings.poster_w_mm);
    }
  }
  schedulePrintCalc();
});

// ── Aspect-ratio lock toggle ─────────────────────────────────
PRINT.aspectLock.addEventListener("click", () => {
  state.printSettings.aspectLocked = !state.printSettings.aspectLocked;
  PRINT.aspectLock.classList.toggle("locked", state.printSettings.aspectLocked);
  PRINT.aspectLock.setAttribute(
    "title",
    state.printSettings.aspectLocked
      ? "Aspect ratio locked to source image"
      : "Aspect ratio free"
  );
  // If we just locked, snap height to match width using source aspect
  if (state.printSettings.aspectLocked) {
    const src = getSourceSvgDims();
    if (src) {
      state.printSettings.poster_h_mm = state.printSettings.poster_w_mm * (src.h / src.w);
      PRINT.posterH.value = fmtLen(state.printSettings.poster_h_mm);
      schedulePrintCalc();
    }
  }
});

// ── Units toggle (mm / inches) ───────────────────────────────
PRINT.unitsTabs.querySelectorAll("button").forEach(btn => {
  btn.addEventListener("click", () => {
    if (state.printSettings.units === btn.dataset.printUnits) return;
    PRINT.unitsTabs.querySelectorAll("button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.printSettings.units = btn.dataset.printUnits;
    refreshPrintInputs();
  });
});

// Re-render every input value + label using the current unit
function refreshPrintInputs() {
  const u = unitSuffix();
  // Update all "(mm)" labels
  PRINT.unitLabels.forEach(el => { el.textContent = `(${u})`; });

  // Number inputs: poster width/height, custom paper W/H
  PRINT.posterW.value = fmtLen(state.printSettings.poster_w_mm);
  PRINT.posterH.value = fmtLen(state.printSettings.poster_h_mm);
  if (state.printSettings.paper_w_mm > 0) {
    PRINT.customW.value = fmtLen(state.printSettings.paper_w_mm);
  } else {
    PRINT.customW.value = "";
  }
  if (state.printSettings.paper_h_mm > 0) {
    PRINT.customH.value = fmtLen(state.printSettings.paper_h_mm);
  } else {
    PRINT.customH.value = "";
  }

  // Sync the toggle-button visual state with state values
  syncEngineTabSelections();
  syncPlacementInputsFromState();

  // Adjust step/range to be sensible per unit
  if (u === "in") {
    PRINT.posterW.step = "0.5"; PRINT.posterH.step = "0.5";
    PRINT.customW.step = "0.1"; PRINT.customH.step = "0.1";
  } else {
    PRINT.posterW.step = "10"; PRINT.posterH.step = "10";
    PRINT.customW.step = "1"; PRINT.customH.step = "1";
  }

  // Slider outputs (overlap, margin) — slider value stays in mm, output text uses unit
  PRINT.marginVal.textContent = `${fmtLen(state.printSettings.margin_mm, 0, 2)} ${u}`;
  PRINT.overlapVal.textContent = `${fmtLen(state.printSettings.overlap_mm, 0, 2)} ${u}`;

  // Paper select labels also show their unit
  rebuildPaperSelectLabels();

  // Refresh the live tile overlay and summary so they match the new unit context
  updatePrintModeUi();
  if (state.printGrid) renderPrintSummary(state.printGrid);
}

function rebuildPaperSelectLabels() {
  if (!state.paperSizes || state.paperSizes.length === 0) return;
  // Remember selection
  const selected = PRINT.paperSelect.value;
  PRINT.paperSelect.innerHTML = "";
  state.paperSizes.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s.name;
    opt.textContent = `${s.name}  (${fmtLen(s.width_mm)} \u00d7 ${fmtLen(s.height_mm)} ${unitSuffix()})`;
    PRINT.paperSelect.appendChild(opt);
  });
  const customOpt = document.createElement("option");
  customOpt.value = "Custom";
  customOpt.textContent = customPaperSelectLabel();
  PRINT.paperSelect.appendChild(customOpt);
  PRINT.paperSelect.value = selected || state.printSettings.paper_name;
}

// ── Auto-fit poster dimensions to the source SVG aspect ──────
function autoFitPosterToSource(opts = {}) {
  // Pick a sensible target: keep the longest dimension at A2's long edge (594 mm),
  // unless the user has overridden — in which case keep their longest dim.
  const src = getSourceSvgDims();
  if (!src) return;
  const ratio = src.w / src.h;
  const targetLong = opts.forceLong ?? Math.max(
    state.printSettings.poster_w_mm,
    state.printSettings.poster_h_mm,
    594,
  );
  let w, h;
  if (ratio >= 1) { w = targetLong; h = targetLong / ratio; }
  else            { h = targetLong; w = targetLong * ratio; }
  state.printSettings.poster_w_mm = Math.round(w);
  state.printSettings.poster_h_mm = Math.round(h);
  PRINT.posterW.value = fmtLen(state.printSettings.poster_w_mm);
  PRINT.posterH.value = fmtLen(state.printSettings.poster_h_mm);
  // Also pick a sensible orientation for the paper based on the longer dim
  if (ratio > 1.1 && state.printSettings.orientation !== "landscape") {
    state.printSettings.orientation = "landscape";
    PRINT.orientationRow.querySelectorAll("button").forEach(b => {
      b.classList.toggle("active", b.dataset.printOrientation === "landscape");
    });
  } else if (ratio < 0.9 && state.printSettings.orientation !== "portrait") {
    state.printSettings.orientation = "portrait";
    PRINT.orientationRow.querySelectorAll("button").forEach(b => {
      b.classList.toggle("active", b.dataset.printOrientation === "portrait");
    });
  }
}
PRINT.gridCols.addEventListener("change", () => {
  state.printSettings.grid_cols = Math.max(1, parseInt(PRINT.gridCols.value) || 1);
  schedulePrintCalc();
});
PRINT.gridRows.addEventListener("change", () => {
  state.printSettings.grid_rows = Math.max(1, parseInt(PRINT.gridRows.value) || 1);
  schedulePrintCalc();
});
PRINT.scaleSlider.addEventListener("input", () => { PRINT.scaleVal.textContent = PRINT.scaleSlider.value + "%"; });
PRINT.scaleSlider.addEventListener("change", () => {
  state.printSettings.scale_pct = parseFloat(PRINT.scaleSlider.value);
  schedulePrintCalc();
});

// ── Decoration toggles ───────────────────────────────────────
const decoMap = {
  "deco-overlap-shade":      "overlap_shade",
  "deco-page-labels":        "page_labels",
  "deco-registration-marks": "registration_marks",
  "deco-scale-indicator":    "scale_indicator",
  "deco-border-box":         "border_box",
};
Object.entries(decoMap).forEach(([id, key]) => {
  const el = document.getElementById(id);
  el.addEventListener("change", () => {
    state.printSettings.decorations[key] = el.checked;
    renderPosterGrid();
  });
});

function effectiveOverlapMm(settings) {
  const paper = paperWHForCurrentSettings();
  if (!paper) return settings.overlap_mm;
  const printableW = paper.w - 2 * settings.margin_mm;
  const printableH = paper.h - 2 * settings.margin_mm;
  return Math.max(0, Math.min(settings.overlap_mm, Math.min(printableW, printableH) - 1));
}

function posterDimensionsForPlacement() {
  const g = state.printGrid;
  if (g) return { w: g.poster_w_mm, h: g.poster_h_mm };
  return effectivePosterDimensions();
}

// ── Compute poster dimensions from the chosen UI mode ────────
function effectivePosterDimensions() {
  const settings = state.printSettings;

  // Single page: poster canvas = printable area of the chosen paper sheet.
  if (settings.single_page) {
    const paper = paperWHForCurrentSettings();
    if (paper) {
      const m = settings.margin_mm;
      return {
        w: Math.max(1, paper.w - 2 * m),
        h: Math.max(1, paper.h - 2 * m),
      };
    }
  }

  if (settings.poster_mode === "dimensions") {
    return { w: settings.poster_w_mm, h: settings.poster_h_mm };
  }

  // For grid and scale modes we need the source SVG dimensions
  const svg = svgContainer.querySelector("svg");
  if (!svg) return { w: settings.poster_w_mm, h: settings.poster_h_mm };

  const vb = svg.getAttribute("viewBox");
  let viewW = parseSvgLength(svg.getAttribute("width")) || 1000;
  let viewH = parseSvgLength(svg.getAttribute("height")) || 1000;
  if (vb) {
    const parts = vb.split(/\s+|,/).map(Number);
    if (parts.length === 4) {
      viewW = parts[2];
      viewH = parts[3];
    }
  }

  if (settings.poster_mode === "scale") {
    // Treat 100% as one paper-sheet sized (uses paper preset). Easier rule:
    // Scale source SVG units 1:1 with mm, then apply percentage.
    const factor = settings.scale_pct / 100;
    return { w: viewW * factor * 0.265, h: viewH * factor * 0.265 }; // 1px ~ 0.265mm @96dpi heuristic
  }

  if (settings.poster_mode === "grid") {
    // Compute the poster size that exactly fills cols x rows of the chosen paper.
    const paper = paperWHForCurrentSettings();
    if (!paper) return { w: settings.poster_w_mm, h: settings.poster_h_mm };
    const printableW = paper.w - 2 * settings.margin_mm;
    const printableH = paper.h - 2 * settings.margin_mm;
    const overlap = effectiveOverlapMm(settings);
    const stepX = printableW - overlap;
    const stepY = printableH - overlap;
    const cols = settings.grid_cols;
    const rows = settings.grid_rows;
    const w = stepX * cols + overlap;
    const h = stepY * rows + overlap;
    return { w, h };
  }

  return { w: settings.poster_w_mm, h: settings.poster_h_mm };
}

function paperWHForCurrentSettings() {
  // Returns the EFFECTIVE paper width/height in mm, with orientation applied.
  // Matches the server-side _maybe_swap so grid-mode poster math agrees.
  const s = state.printSettings;
  let w, h;
  if (s.paper_name === "Custom") {
    if (!s.paper_w_mm || !s.paper_h_mm) return null;
    w = s.paper_w_mm; h = s.paper_h_mm;
  } else {
    const found = state.paperSizes.find(p => p.name === s.paper_name);
    if (!found) return null;
    w = found.width_mm; h = found.height_mm;
  }
  // Orientation swap (paper presets are defined portrait, so swap for landscape)
  if (s.orientation === "landscape" && h > w) [w, h] = [h, w];
  else if (s.orientation === "portrait" && w > h) [w, h] = [h, w];
  return { w, h };
}

// ── Build the request body for /api/print/calculate and /api/print/tile ─
function buildPrintSettingsPayload() {
  const s = state.printSettings;
  const dim = effectivePosterDimensions();
  return {
    paper_name: s.paper_name,
    paper_w_mm: s.paper_w_mm,
    paper_h_mm: s.paper_h_mm,
    orientation: s.orientation,
    poster_w_mm: Math.round(dim.w * 100) / 100,
    poster_h_mm: Math.round(dim.h * 100) / 100,
    overlap_mm: s.overlap_mm,
    margin_mm: s.margin_mm,
    single_page: s.single_page,
    image_x_mm: s.image_x_mm,
    image_y_mm: s.image_y_mm,
    image_scale: s.image_scale,
    image_rotation_deg: s.image_rotation_deg,
    grid_offset_x_mm: s.grid_offset_x_mm,
    grid_offset_y_mm: s.grid_offset_y_mm,
    trim_guides_to_poster: s.trim_guides_to_poster,
    poster_mode: s.poster_mode,
    grid_cols: s.poster_mode === "grid" ? s.grid_cols : null,
    grid_rows: s.poster_mode === "grid" ? s.grid_rows : null,
    decorations: { ...s.decorations },
  };
}

// ── Debounced calculate call ─────────────────────────────────
function schedulePrintCalc() {
  clearTimeout(printDebounceTimer);
  printDebounceTimer = setTimeout(runPrintCalc, 80);
}

async function runPrintCalc() {
  if (!state.currentSvg || !state.imageId) return;
  const src = getSourceSvgDims();
  const body = {
    settings: buildPrintSettingsPayload(),
    image_id: state.imageId,
  };
  if (src) {
    body.svg_view_w = src.w;
    body.svg_view_h = src.h;
  }
  try {
    const res = await fetch("/api/print/calculate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "Calculation failed" }));
      PRINT.summary.innerHTML = `<span style="color:var(--danger)">${err.detail || "calc failed"}</span>`;
      state.printGrid = null;
      renderPosterCanvas();
      return;
    }
    const data = await res.json();
    state.printGrid = data;
    // Keep placement poster dims in sync with the server grid so image scale/position
    // matches the tile layout (critical for seamless overlap at seams).
    state.printSettings.poster_w_mm = data.poster_w_mm;
    state.printSettings.poster_h_mm = data.poster_h_mm;
    // Derive placement when we don't have one yet, or when fit isn't manual
    // (so the image follows poster-size and paper-orientation changes).
    if (state.printSettings.image_scale == null
        || state.printSettings.image_fit !== "manual") {
      applyAutoFitPlacement();
    }
    renderPrintSummary(data);
    renderPosterCanvas();
  } catch (err) {
    console.error(err);
  }
}

function renderPrintSummary(grid) {
  const u = unitSuffix();
  const altUnit = u === "mm" ? "in" : "mm";
  const altFmt = (mm) => u === "mm" ? (mm / 25.4).toFixed(1) : mm.toFixed(0);
  const lines = [
    `<strong>${grid.total_pages}</strong> page${grid.total_pages === 1 ? "" : "s"} (${grid.cols} \u00d7 ${grid.rows})`,
    `Final: <strong>${fmtLen(grid.poster_w_mm)} \u00d7 ${fmtLen(grid.poster_h_mm)} ${u}</strong>  (${altFmt(grid.poster_w_mm)} \u00d7 ${altFmt(grid.poster_h_mm)} ${altUnit})`,
    `Page: ${fmtLen(grid.paper_w_mm)} \u00d7 ${fmtLen(grid.paper_h_mm)} ${u}  \u2022 Overlap: ${fmtLen(grid.overlap_mm, 0, 2)} ${u}  \u2022 Margin: ${fmtLen(grid.margin_mm, 0, 2)} ${u}`,
  ];
  PRINT.summary.innerHTML = lines.join("<br/>");
}

// ── Image-placement math (mirrors the PDF generator) ─────────
function computeFitPlacement(fitMode) {
  // Returns {x_mm, y_mm, scale} for "contain" or "cover" given current poster + source.
  const src = getSourceSvgDims();
  if (!src) return null;
  const { w: posterW, h: posterH } = posterDimensionsForPlacement();
  const sx = posterW / src.w;
  const sy = posterH / src.h;
  const scale = (fitMode === "cover") ? Math.max(sx, sy) : Math.min(sx, sy);
  const w_mm = src.w * scale;
  const h_mm = src.h * scale;
  return {
    x_mm: (posterW - w_mm) / 2,
    y_mm: (posterH - h_mm) / 2,
    scale,
  };
}

function applyAutoFitPlacement() {
  // Recompute image_x/y/scale from the current fit mode.
  // Skipped when fit is "manual" so the user's custom values stick.
  const s = state.printSettings;
  if (s.image_fit === "manual") return;
  const p = computeFitPlacement(s.image_fit);
  if (!p) return;
  s.image_scale = p.scale;
  s.image_x_mm = p.x_mm;
  s.image_y_mm = p.y_mm;
  syncPlacementInputsFromState();
}

function syncPlacementInputsFromState() {
  const s = state.printSettings;
  PRINT.imageFit.value = s.image_fit;
  PRINT.imageRotSlider.value = ((s.image_rotation_deg % 360) + 360) % 360;
  PRINT.imageRotVal.textContent = `${Math.round(s.image_rotation_deg)}°`;
}

// Force engine-tab buttons (mode / orientation / units) to reflect state.
// Belt-and-suspenders so the HTML's initial active classes never get out of
// sync with state.printSettings — covers programmatic changes from autofit etc.
function syncEngineTabSelections() {
  const s = state.printSettings;
  if (PRINT.modeTabs) {
    PRINT.modeTabs.querySelectorAll("button").forEach(b => {
      b.classList.toggle("active", b.dataset.printMode === (s.single_page ? "single" : "tile"));
    });
  }
  if (PRINT.orientationRow) {
    PRINT.orientationRow.querySelectorAll("button").forEach(b => {
      b.classList.toggle("active", b.dataset.printOrientation === s.orientation);
    });
  }
  if (PRINT.unitsTabs) {
    PRINT.unitsTabs.querySelectorAll("button").forEach(b => {
      b.classList.toggle("active", b.dataset.printUnits === s.units);
    });
  }
  if (PRINT.posterModeSelect) PRINT.posterModeSelect.value = s.poster_mode;
}

// ── WYSIWYG poster canvas ────────────────────────────────────
function renderPosterCanvas() {
  const canvas = PRINT.posterCanvas;
  const grid = state.printGrid;
  const s = state.printSettings;
  const traced = svgContainer.querySelector("svg");
  if (!grid || !traced) return;

  canvas.style.display = "";
  canvas.setAttribute("viewBox", `0 0 ${grid.poster_w_mm} ${grid.poster_h_mm}`);
  PRINT.posterBg.setAttribute("width", grid.poster_w_mm);
  PRINT.posterBg.setAttribute("height", grid.poster_h_mm);

  if (s.image_scale == null) applyAutoFitPlacement();

  // Tile grid (drawn first so the image ends up on top, but the grid still
  // catches drag events on areas the image doesn't cover, via z-order trick:
  // the image group is rendered AFTER the grid in the DOM).
  renderPosterGrid();

  // Image placement — embed as nested SVG so Inkscape defs/use/styles stay intact.
  PRINT.posterImage.innerHTML = "";
  const nested = cloneSvgForPoster(traced);
  if (nested) PRINT.posterImage.appendChild(nested);
  applyImageTransform();

  reapplyAllZoomPan();
}

function overlapStripsForTile(t, grid) {
  const o = grid.overlap_mm;
  if (o <= 0) return [];
  const strips = [];
  if (t.col < grid.cols - 1) {
    strips.push({
      edge: "right",
      x: t.poster_x_mm + t.printable_w_mm - o,
      y: t.poster_y_mm,
      w: o,
      h: t.printable_h_mm,
    });
  }
  if (t.col > 0) {
    strips.push({ edge: "left", x: t.poster_x_mm, y: t.poster_y_mm, w: o, h: t.printable_h_mm });
  }
  if (t.row > 0) {
    strips.push({ edge: "top", x: t.poster_x_mm, y: t.poster_y_mm, w: t.printable_w_mm, h: o });
  }
  if (t.row < grid.rows - 1) {
    strips.push({
      edge: "bottom",
      x: t.poster_x_mm,
      y: t.poster_y_mm + t.printable_h_mm - o,
      w: t.printable_w_mm,
      h: o,
    });
  }
  return strips;
}

const LABEL_STRIP_PRIORITY = ["bottom", "right", "left", "top"];

function pickLabelStrip(strips) {
  for (const edge of LABEL_STRIP_PRIORITY) {
    const found = strips.find(s => s.edge === edge);
    if (found) return found;
  }
  return null;
}

function appendAssemblyGuides(parent, t, grid) {
  const mkLine = (x1, y1, x2, y2, cls) => {
    // White halo underneath so the guide stays visible on dark images.
    const halo = document.createElementNS(SVG_NS, "line");
    halo.setAttribute("class", "tile-guide-halo");
    halo.setAttribute("x1", x1);
    halo.setAttribute("y1", y1);
    halo.setAttribute("x2", x2);
    halo.setAttribute("y2", y2);
    parent.appendChild(halo);
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("class", cls);
    line.setAttribute("x1", x1);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
    parent.appendChild(line);
  };
  const fs = Math.max(2.5, Math.min(grid.overlap_mm * 0.8, 5));
  const mkText = (cx, cy, text, vertical) => {
    const el = document.createElementNS(SVG_NS, "text");
    el.setAttribute("class", "tile-guide-text");
    if (vertical) el.setAttribute("transform", `rotate(90 ${cx} ${cy})`);
    el.setAttribute("x", cx);
    el.setAttribute("y", cy);
    el.setAttribute("text-anchor", "middle");
    el.setAttribute("dominant-baseline", "middle");
    el.setAttribute("font-size", fs);
    el.textContent = text;
    parent.appendChild(el);
  };
  const o = grid.overlap_mm;
  const x = t.poster_x_mm;
  const y = t.poster_y_mm;
  const w = t.printable_w_mm;
  const h = t.printable_h_mm;
  // Covering edges (this page is laid on top): cut the white margin off here.
  if (t.col > 0) {
    mkLine(x, y, x, y + h, "tile-cut-line");
    mkText(x + fs, y + h / 2, "CUT", true);
  }
  if (t.row > 0) {
    mkLine(x, y, x + w, y, "tile-cut-line");
    mkText(x + w / 2, y + fs, "CUT", false);
  }
  // Covered edges (the neighbour glues on top of this strip).
  if (t.col < grid.cols - 1) {
    mkLine(x + w - o, y, x + w - o, y + h, "tile-glue-line");
    mkText(x + w - fs, y + h / 2, "GLUE", true);
  }
  if (t.row < grid.rows - 1) {
    mkLine(x, y + h - o, x + w, y + h - o, "tile-glue-line");
    mkText(x + w / 2, y + h - fs, "GLUE", false);
  }
}

function appendOverlapLabel(parent, strip, text, fontSize) {
  const cx = strip.x + strip.w / 2;
  const cy = strip.y + strip.h / 2;
  const label = document.createElementNS(SVG_NS, "text");
  label.setAttribute("class", "tile-label");
  if (strip.edge === "left" || strip.edge === "right") {
    label.setAttribute("transform", `rotate(90 ${cx} ${cy})`);
  }
  label.setAttribute("x", cx);
  label.setAttribute("y", cy);
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("dominant-baseline", "middle");
  label.setAttribute("font-size", fontSize);
  label.textContent = text;
  parent.appendChild(label);
}

function renderPosterGrid() {
  const grid = state.printGrid;
  const s = state.printSettings;
  if (!grid) return;
  PRINT.posterGrid.innerHTML = "";

  if (s.single_page || grid.overlap_mm <= 0) return;

  const dragZone = document.createElementNS(SVG_NS, "rect");
  dragZone.setAttribute("class", "grid-drag-zone");
  dragZone.setAttribute("x", "0");
  dragZone.setAttribute("y", "0");
  dragZone.setAttribute("width", grid.poster_w_mm);
  dragZone.setAttribute("height", grid.poster_h_mm);
  PRINT.posterGrid.appendChild(dragZone);

  const labelFontSize = Math.max(3, Math.min(grid.overlap_mm * 0.35, 6));

  grid.tiles.forEach(t => {
    const strips = overlapStripsForTile(t, grid);
    if (!strips.length) return;

    if (s.decorations.overlap_shade) {
      strips.forEach(st => {
        const shade = document.createElementNS(SVG_NS, "rect");
        shade.setAttribute("class", ((t.col + t.row) % 2 === 0) ? "tile-shade-even" : "tile-shade-odd");
        shade.setAttribute("x", st.x);
        shade.setAttribute("y", st.y);
        shade.setAttribute("width", st.w);
        shade.setAttribute("height", st.h);
        PRINT.posterGrid.appendChild(shade);
      });
    }

    if (s.decorations.border_box) {
      appendAssemblyGuides(PRINT.posterGrid, t, grid);
    }

    if (s.decorations.page_labels) {
      const lbl = document.createElementNS(SVG_NS, "text");
      lbl.setAttribute("class", "tile-label");
      lbl.setAttribute("x", t.poster_x_mm + labelFontSize * 0.6);
      lbl.setAttribute("y", t.poster_y_mm + labelFontSize * 1.2);
      lbl.setAttribute("font-size", labelFontSize);
      lbl.textContent = t.label;
      PRINT.posterGrid.appendChild(lbl);
    }
  });
}

// ── Image placement controls ─────────────────────────────────
PRINT.imageFit.addEventListener("change", () => {
  state.printSettings.image_fit = PRINT.imageFit.value;
  if (state.printSettings.image_fit !== "manual") {
    applyAutoFitPlacement();
  }
  syncPlacementInputsFromState();
  renderPosterCanvas();
  schedulePrintCalc();
});

function markManualFit() {
  state.printSettings.image_fit = "manual";
  PRINT.imageFit.value = "manual";
}

// ── Rotation slider ──────────────────────────────────────────
PRINT.imageRotSlider.addEventListener("input", () => {
  state.printSettings.image_rotation_deg = parseFloat(PRINT.imageRotSlider.value);
  PRINT.imageRotVal.textContent = `${Math.round(state.printSettings.image_rotation_deg)}°`;
  applyImageTransform();
});

// ── Reset buttons ────────────────────────────────────────────
PRINT.btnImageReset.addEventListener("click", () => {
  state.printSettings.image_fit = "contain";
  state.printSettings.image_rotation_deg = 0;
  applyAutoFitPlacement();
  syncPlacementInputsFromState();
  renderPosterCanvas();
  schedulePrintCalc();
});

// "Hide grid" toggle — purely a preview convenience so the user can see the
// image without the tile grid getting in the way. Doesn't affect the PDF.
PRINT.btnToggleGrid.addEventListener("click", () => {
  state.printGridVisible = !state.printGridVisible;
  PRINT.posterCanvas.classList.toggle("hide-grid", !state.printGridVisible);
  PRINT.btnToggleGrid.textContent = state.printGridVisible ? "Hide grid" : "Show grid";
});

// ── Coordinate helpers ───────────────────────────────────────
function pointerToPosterMm(evt) {
  // Map a screen-space mouse event to poster mm coords by inverting the
  // poster-canvas's CTM.
  const canvas = PRINT.posterCanvas;
  const grid = state.printGrid;
  if (!grid) return null;
  const pt = canvas.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  const ctm = canvas.getScreenCTM();
  if (!ctm) return null;
  const local = pt.matrixTransform(ctm.inverse());
  return { x: local.x, y: local.y };
}

function applyImageTransform() {
  const s = state.printSettings;
  const src = getSourceSvgDims();
  if (!src) return;
  // Rotation is around the image bbox centre.
  const cx = s.image_x_mm + (src.w * (s.image_scale || 1)) / 2;
  const cy = s.image_y_mm + (src.h * (s.image_scale || 1)) / 2;
  PRINT.posterImage.setAttribute(
    "transform",
    `rotate(${s.image_rotation_deg} ${cx} ${cy}) translate(${s.image_x_mm} ${s.image_y_mm}) scale(${s.image_scale || 1})`
  );
  renderRotateHandle();
}

function renderRotateHandle() {
  // A small dot 20mm above the image centre (in image-rotated frame) acts as
  // the rotate grip. Drag it to spin the image.
  const s = state.printSettings;
  const src = getSourceSvgDims();
  const grid = state.printGrid;
  if (!src || !grid) { PRINT.posterHandles.innerHTML = ""; return; }

  const cx = s.image_x_mm + (src.w * (s.image_scale || 1)) / 2;
  const cy = s.image_y_mm + (src.h * (s.image_scale || 1)) / 2;
  const handleDist = Math.max(15, Math.min(grid.poster_w_mm, grid.poster_h_mm) * 0.06);
  const rad = (s.image_rotation_deg - 90) * Math.PI / 180;
  const hx = cx + Math.cos(rad) * handleDist;
  const hy = cy + Math.sin(rad) * handleDist;

  PRINT.posterHandles.innerHTML = "";
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("class", "rotate-line");
  line.setAttribute("x1", cx); line.setAttribute("y1", cy);
  line.setAttribute("x2", hx); line.setAttribute("y2", hy);
  PRINT.posterHandles.appendChild(line);

  const handle = document.createElementNS(SVG_NS, "circle");
  handle.setAttribute("class", "rotate-handle");
  handle.setAttribute("cx", hx);
  handle.setAttribute("cy", hy);
  handle.setAttribute("r", Math.max(2, handleDist * 0.18));
  handle.dataset.role = "rotate-handle";
  PRINT.posterHandles.appendChild(handle);
}

// ── Direct manipulation: every drag/scroll affects the IMAGE only ────────
// Grid is fixed to the canvas size; user-facing interactions only move the
// image. Drag = translate, wheel = scale (anchored at cursor), rotate handle
// = rotate.
(function attachCanvasInteractions() {
  let mode = null; // "image-translate" | "image-rotate"
  let startMm = null;
  let startState = null;
  let startCenterMm = null;

  PRINT.posterCanvas.addEventListener("mousedown", e => {
    if (!state.printGrid) return;
    const target = e.target;
    const role = target?.dataset?.role;
    const startPt = pointerToPosterMm(e);
    if (!startPt) return;

    mode = (role === "rotate-handle") ? "image-rotate" : "image-translate";

    e.stopPropagation();
    e.preventDefault();
    startMm = startPt;
    startState = {
      image_x_mm: state.printSettings.image_x_mm,
      image_y_mm: state.printSettings.image_y_mm,
      image_rotation_deg: state.printSettings.image_rotation_deg,
    };
    const src = getSourceSvgDims();
    if (src) {
      startCenterMm = {
        x: state.printSettings.image_x_mm + (src.w * (state.printSettings.image_scale || 1)) / 2,
        y: state.printSettings.image_y_mm + (src.h * (state.printSettings.image_scale || 1)) / 2,
      };
    }
    PRINT.posterCanvas.style.cursor = (mode === "image-translate") ? "grabbing" : "";
  });

  window.addEventListener("mousemove", e => {
    if (!mode) return;
    const p = pointerToPosterMm(e);
    if (!p) return;
    const s = state.printSettings;

    if (mode === "image-translate") {
      s.image_x_mm = startState.image_x_mm + (p.x - startMm.x);
      s.image_y_mm = startState.image_y_mm + (p.y - startMm.y);
      markManualFit();
      applyImageTransform();
    } else if (mode === "image-rotate" && startCenterMm) {
      const a0 = Math.atan2(startMm.y - startCenterMm.y, startMm.x - startCenterMm.x);
      const a1 = Math.atan2(p.y - startCenterMm.y, p.x - startCenterMm.x);
      let deg = startState.image_rotation_deg + (a1 - a0) * 180 / Math.PI;
      // Snap close to 0/90/180/270 within 3°
      [0, 90, 180, 270, 360].forEach(snap => {
        if (Math.abs(((deg % 360) + 360) % 360 - snap) < 3) deg = snap % 360;
      });
      s.image_rotation_deg = ((deg % 360) + 360) % 360;
      PRINT.imageRotSlider.value = s.image_rotation_deg;
      PRINT.imageRotVal.textContent = `${Math.round(s.image_rotation_deg)}°`;
      applyImageTransform();
    }
  });

  window.addEventListener("mouseup", () => {
    if (!mode) return;
    mode = null;
    PRINT.posterCanvas.style.cursor = "";
    schedulePrintCalc();
  });

  // Wheel anywhere on the poster canvas scales the IMAGE. Anchored at the
  // cursor so the point under the mouse stays put — feels like zoom-into-image.
  PRINT.posterCanvas.addEventListener("wheel", e => {
    if (!state.printGrid) return;
    e.preventDefault();
    e.stopPropagation();
    const s = state.printSettings;
    const src = getSourceSvgDims();
    if (!src || !s.image_scale) return;
    const delta = e.deltaY > 0 ? 0.95 : 1.05;
    const newScale = Math.max(0.001, s.image_scale * delta);
    const p = pointerToPosterMm(e);
    if (p) {
      const fx = (p.x - s.image_x_mm) / (s.image_scale * src.w);
      const fy = (p.y - s.image_y_mm) / (s.image_scale * src.h);
      s.image_x_mm = p.x - fx * newScale * src.w;
      s.image_y_mm = p.y - fy * newScale * src.h;
    }
    s.image_scale = newScale;
    markManualFit();
    applyImageTransform();
    schedulePrintCalc();
  }, { passive: false });
})();

PRINT.btnPdf.addEventListener("click", async () => {
  const svgStr = serializeSvgForExport();
  if (!svgStr) return;

  PRINT.btnPdf.disabled = true;
  const originalText = PRINT.btnPdf.textContent;
  PRINT.btnPdf.textContent = "Generating PDF\u2026";

  try {
    const res = await fetch("/api/print/tile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: buildPrintSettingsPayload(),
        svg: svgStr,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "PDF generation failed" }));
      alert("PDF generation failed: " + (err.detail || "unknown error"));
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "vectile-poster.pdf";
    a.click();
    URL.revokeObjectURL(url);
  } finally {
    PRINT.btnPdf.disabled = false;
    PRINT.btnPdf.textContent = originalText;
  }
});

// Hook into renderSvg so the print panel and overlay stay in sync.
// renderSvg is defined earlier; we attach a postRenderSvg callback that it calls.
window.__onSvgRendered = function () {
  refreshPrintEnabled();
  renderPosterCanvas();
};
