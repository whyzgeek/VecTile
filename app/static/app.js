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
const btnBakePalette  = document.getElementById("btn-bake-palette");

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
  // Each new upload re-enables poster auto-fit so the print panel starts in the
  // right orientation for this image. User edits later will disable it again.
  state.printSettings.posterAutoFit = true;

  // For raster uploads we can use the original file for the "Original" preview;
  // for PDFs the file isn't a viewable image, so we re-fetch a rendered raster.
  if (data.kind === "svg" && data.svg) {
    state.currentSvg = data.svg;
    renderSvg(data.svg);
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
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runVectorize, DEBOUNCE_MS);
}

async function runVectorize() {
  if (!state.imageId) return;

  if (abortController) abortController.abort();
  abortController = new AbortController();

  showTracingOverlay(true);

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
      showTracingOverlay(false);
      return;
    }

    const data = await res.json();
    state.currentSvg = data.svg;
    state.hiddenColors.clear();
    state.recoloredColors = {};

    renderSvg(data.svg);
    buildPalettePanel(data.palette);
    updateStatusBar(data);
    btnDownload.disabled = false;
  } catch (err) {
    if (err.name !== "AbortError") console.error(err);
  } finally {
    showTracingOverlay(false);
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

function fitSplitMediaToHalves() {
  fitMediaInZone(
    document.getElementById("split-original"),
    document.querySelector("#split-half-left .split-pan-zone"),
  );
  // SVG viewBox units are not pixels — explicit sizing overshoots and clips.
  const wrap = document.getElementById("split-svg");
  const svg = wrap?.querySelector("svg");
  if (svg) {
    svg.style.removeProperty("width");
    svg.style.removeProperty("height");
    svg.style.removeProperty("max-width");
    svg.style.removeProperty("max-height");
  }
  if (wrap) {
    wrap.style.removeProperty("width");
    wrap.style.removeProperty("height");
  }
}

function renderSvg(svgStr) {
  svgContainer.innerHTML = svgStr;
  splitSvgDiv.innerHTML = svgStr;
  fitSplitMediaToHalves();
  // The zoom-pan zones are bound at startup with content getters, so the new
  // SVG element is picked up automatically. Re-apply the current transform
  // so the new content matches the user's existing zoom/pan position.
  reapplyAllZoomPan();
  showPane(getCurrentTab());
  if (typeof window.__onSvgRendered === "function") window.__onSvgRendered();
}

// ── Palette panel ─────────────────────────────────────────────
function buildPalettePanel(palette) {
  paletteGrid.innerHTML = "";
  palettePlaceholder.style.display = "none";
  btnResetPalette.disabled = false;
  btnBakePalette.disabled = false;

  if (!palette || palette.length === 0) {
    palettePlaceholder.style.display = "";
    palettePlaceholder.querySelector("p").textContent = "No colors found in SVG";
    return;
  }

  palette.forEach(({ color, count }) => {
    const card = document.createElement("div");
    card.className = "swatch-card";
    card.dataset.color = color;

    const swatch = document.createElement("div");
    swatch.className = "swatch-color";
    swatch.style.background = color;

    const countEl = document.createElement("span");
    countEl.className = "swatch-count";
    countEl.textContent = count;

    // Hidden color picker input
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.className = "swatch-input";
    colorInput.value = color;

    // Visible color picker dot
    const pickerDot = document.createElement("div");
    pickerDot.className = "swatch-picker";
    pickerDot.style.background = color;
    pickerDot.title = "Recolor";

    pickerDot.addEventListener("click", e => {
      e.stopPropagation();
      colorInput.click();
    });

    colorInput.addEventListener("input", e => {
      const newColor = e.target.value;
      recolorPaths(color, newColor);
      swatch.style.background = newColor;
      pickerDot.style.background = newColor;
      state.recoloredColors[color] = newColor;
    });

    card.addEventListener("click", () => toggleColorVisibility(color, card));
    card.append(swatch, countEl, pickerDot, colorInput);
    paletteGrid.appendChild(card);
  });
}

function toggleColorVisibility(color, card) {
  const svgs = [
    svgContainer.querySelector("svg"),
    splitSvgDiv.querySelector("svg"),
  ].filter(Boolean);

  if (state.hiddenColors.has(color)) {
    state.hiddenColors.delete(color);
    card.classList.remove("hidden-color");
    svgs.forEach(svg => {
      svg.querySelectorAll(`[fill="${color}"], [fill="${color.toUpperCase()}"]`).forEach(el => {
        el.style.display = "";
      });
    });
  } else {
    state.hiddenColors.add(color);
    card.classList.add("hidden-color");
    svgs.forEach(svg => {
      svg.querySelectorAll(`[fill="${color}"], [fill="${color.toUpperCase()}"]`).forEach(el => {
        el.style.display = "none";
      });
    });
  }
}

function recolorPaths(oldColor, newColor) {
  const svgs = [
    svgContainer.querySelector("svg"),
    splitSvgDiv.querySelector("svg"),
  ].filter(Boolean);

  svgs.forEach(svg => {
    svg.querySelectorAll(`[fill="${oldColor}"], [fill="${oldColor.toUpperCase()}"]`).forEach(el => {
      el.setAttribute("fill", newColor);
    });
  });

  // Update swatch card tracking color
  const card = paletteGrid.querySelector(`[data-color="${oldColor}"]`);
  if (card) card.dataset.color = newColor;
}

btnResetPalette.addEventListener("click", () => {
  state.hiddenColors.clear();
  state.recoloredColors = {};
  if (state.currentSvg) {
    renderSvg(state.currentSvg);
    const palette = extractPaletteFromCurrentSvg();
    buildPalettePanel(palette);
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
  if (tab === "split") {
    // Refit after the pane becomes visible — earlier calls saw 0×0 layout.
    requestAnimationFrame(() => {
      fitSplitMediaToHalves();
      reapplyAllZoomPan();
    });
  }
}

// ── Zoom / Pan ────────────────────────────────────────────────
// Each preview pane gets its own independent zoom-pan zone. The split pane
// shares one zone across both halves so they pan/zoom in sync, which is the
// whole point of side-by-side comparison.

const zoomPanZones = []; // {applyTransform, reset} entries, used by renderSvg

function setupZoomPan(container, contentsGetter) {
  if (!container) return;

  let scale = 1, tx = 0, ty = 0;
  let dragging = false, startX = 0, startY = 0;

  function applyTransform() {
    const contents = (contentsGetter() || []).filter(Boolean);
    contents.forEach(el => {
      el.style.transformOrigin = "center center";
      el.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
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

  // Vectorized tab — just the SVG inside #svg-container.
  setupZoomPan(
    document.getElementById("pan-vectorized"),
    () => [document.querySelector("#svg-container svg")]
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

splitOrigImg.addEventListener("load", () => {
  fitSplitMediaToHalves();
  reapplyAllZoomPan();
});
window.addEventListener("resize", () => {
  if (getCurrentTab() === "split") {
    fitSplitMediaToHalves();
    reapplyAllZoomPan();
  }
});

// ── Download ──────────────────────────────────────────────────
btnDownload.addEventListener("click", () => downloadSvg(false));
btnBakePalette.addEventListener("click", () => downloadSvg(true));

async function downloadSvg(bake) {
  if (!state.currentSvg) return;

  setDownloadButtonsBusy(true);
  try {
    // If preview was downscaled, re-trace at full resolution for the download.
    let svgStr;
    if (state.resizePreview) {
      svgStr = await fetchFinalSvg();
      if (!svgStr) return; // error already reported
    } else {
      svgStr = state.currentSvg;
    }

    if (bake) {
      svgStr = applyPaletteEdits(svgStr);
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
    btnBakePalette.dataset.label = btnBakePalette.textContent;
    btnDownload.textContent = "Tracing…";
    btnBakePalette.textContent = "Tracing…";
  } else {
    if (btnDownload.dataset.label) btnDownload.textContent = btnDownload.dataset.label;
    if (btnBakePalette.dataset.label) btnBakePalette.textContent = btnBakePalette.dataset.label;
  }
  btnDownload.disabled = busy;
  btnBakePalette.disabled = busy;
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

// ── Overlay ───────────────────────────────────────────────────
function showTracingOverlay(show) {
  tracingOverlay.style.display = show ? "" : "none";
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

// ── Mode tabs (Tile / Single) ────────────────────────────────
PRINT.modeTabs.querySelectorAll("button").forEach(btn => {
  btn.addEventListener("click", () => {
    PRINT.modeTabs.querySelectorAll("button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.printSettings.single_page = btn.dataset.printMode === "single";
    const tiled = !state.printSettings.single_page;
    PRINT.overlapSection.style.display = tiled ? "" : "none";
    if (PRINT.decorationsSection) PRINT.decorationsSection.style.display = tiled ? "" : "none";
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
  schedulePrintCalc();
});
PRINT.customW.addEventListener("change", () => {
  state.printSettings.paper_w_mm = unitToMm(parseFloat(PRINT.customW.value));
  schedulePrintCalc();
});
PRINT.customH.addEventListener("change", () => {
  state.printSettings.paper_h_mm = unitToMm(parseFloat(PRINT.customH.value));
  schedulePrintCalc();
});

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
  if (state.printSettings.paper_w_mm) PRINT.customW.value = fmtLen(state.printSettings.paper_w_mm);
  if (state.printSettings.paper_h_mm) PRINT.customH.value = fmtLen(state.printSettings.paper_h_mm);

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
  customOpt.textContent = "Custom\u2026";
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
  const svg = svgContainer.querySelector("svg");
  if (!svg) return;
  const svgStr = new XMLSerializer().serializeToString(svg);

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
  // Always rebuild the poster canvas after a fresh trace — palette edits in
  // the Vectorized tab are reflected here as well, since we clone the trace.
  renderPosterCanvas();
};
