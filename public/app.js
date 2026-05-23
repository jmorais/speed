const elements = {
  downloadValue: document.getElementById('downloadValue'),
  downloadDetail: document.getElementById('downloadDetail'),
  downloadGaugeFill: document.getElementById('downloadGaugeFill'),
  downloadGaugeNeedle: document.getElementById('downloadGaugeNeedle'),
  downloadGaugeCeiling: document.getElementById('downloadGaugeCeiling'),
  uploadValue: document.getElementById('uploadValue'),
  uploadDetail: document.getElementById('uploadDetail'),
  uploadGaugeFill: document.getElementById('uploadGaugeFill'),
  uploadGaugeNeedle: document.getElementById('uploadGaugeNeedle'),
  uploadGaugeCeiling: document.getElementById('uploadGaugeCeiling'),
  verdictText: document.getElementById('verdictText'),
  summaryStats: document.getElementById('summaryStats'),
  comparisonTable: document.getElementById('comparisonTable'),
  rerunButton: document.getElementById('rerunButton')
};

let configCache = null;

const FIXED_TEST_BYTES = 300 * 1024 * 1024;

// ─── Accuracy constants ───────────────────────────────────────────────────────
// Minimum window size before a sample is taken. Keeps per-window byte counts
// large enough that a few ms of jitter doesn't swing the reading wildly.
const MIN_SAMPLE_INTERVAL_MS = 60;

// Three parallel streams saturate a fast link better than a single TCP flow.
// TCP congestion window limits a solo stream; three flows work around that.
const PARALLEL_STREAMS = 3;

// Ignore the first WARMUP_MS of data from the final result calculation.
// TCP slow-start ramps up throughput during this period, so including it
// in the final average would drag the number down unfairly.
const WARMUP_MS = 1500;

// EMA alpha while the link is still ramping (first 3 s). A higher value means
// the display reacts faster — good during slow-start when throughput changes
// quickly. After that we switch to a lower alpha for a smoother steady-state
// reading.
const SMOOTHING_ALPHA_FAST   = 0.35;
const SMOOTHING_ALPHA_STEADY = 0.15;

// Fraction of samples to drop from each tail before averaging. Trims
// momentary stalls (kernel buffer drain, GC pause) and burst artefacts.
const TRIM_FRACTION = 0.10;
// ─────────────────────────────────────────────────────────────────────────────

function bytesToMiB(bytes) {
  return bytes / (1024 * 1024);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function createRandomPayload(byteLength) {
  const payload = new Uint8Array(byteLength);
  const maxChunkSize = 65_536;
  for (let offset = 0; offset < payload.length; offset += maxChunkSize) {
    const view = payload.subarray(offset, Math.min(offset + maxChunkSize, payload.length));
    crypto.getRandomValues(view);
  }
  return payload;
}

function formatMbps(value) {
  if (!Number.isFinite(value) || value <= 0) return '--';
  if (value >= 1000) return `${(value / 1000).toFixed(2)} Gbps`;
  return `${value.toFixed(1)} Mbps`;
}

function formatMegabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatCeiling(valueMbps) {
  return `${formatMbps(valueMbps)} ceiling`;
}

function resolveGaugeCeiling(valueMbps, standards) {
  const fallbackCeiling = 1000;
  const nextStandard = standards.find((s) => valueMbps <= s.mbps);
  if (nextStandard) return Math.max(nextStandard.mbps, fallbackCeiling);
  return Math.max(Math.ceil(valueMbps / 1000) * 1000, fallbackCeiling);
}

function updateGauge(fillEl, needleEl, ceilingEl, valueMbps, maxMbps) {
  const safeMax  = Math.max(maxMbps, 1);
  const ratio    = clamp(valueMbps / safeMax, 0, 1);
  const dashOff  = 100 - ratio * 100;
  const degrees  = -90 + ratio * 180;
  fillEl.style.strokeDashoffset  = String(dashOff);
  needleEl.style.transform       = `rotate(${degrees}deg)`;
  ceilingEl.textContent          = formatCeiling(safeMax);
}

// Trimmed mean: sort samples, drop the outermost `trimFraction` from each
// tail, then average the remainder. Falls back to a plain mean for tiny
// sample sets where trimming would leave nothing.
function trimmedMean(samples, trimFraction) {
  if (samples.length < 4) {
    return samples.reduce((a, b) => a + b, 0) / samples.length;
  }
  const sorted    = [...samples].sort((a, b) => a - b);
  const cutCount  = Math.max(1, Math.floor(sorted.length * trimFraction));
  const trimmed   = sorted.slice(cutCount, sorted.length - cutCount);
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

function getFixedProfile(config) {
  return {
    downloadBytes:      Math.min(FIXED_TEST_BYTES, config.maxDownloadBytes),
    uploadPayloadBytes: Math.min(FIXED_TEST_BYTES, config.uploadLimitBytes),
    downloadMiB:        bytesToMiB(Math.min(FIXED_TEST_BYTES, config.maxDownloadBytes)),
    uploadMiB:          bytesToMiB(Math.min(FIXED_TEST_BYTES, config.uploadLimitBytes))
  };
}

function getTierLabel(downloadMbps, uploadMbps) {
  const floor = Math.min(downloadMbps, uploadMbps);
  if (floor >= 2500) return 'Excellent local link. This is comfortably above multi-gig home networking.';
  if (floor >= 1000) return 'Strong connection. This is in gigabit-class territory.';
  if (floor >=  400) return 'Good connection. This is above typical Wi-Fi 5 performance.';
  if (floor >=  100) return 'Usable connection. Faster than Fast Ethernet, but not especially high-end.';
  return 'Weak local link. This is below Fast Ethernet and likely a bottleneck.';
}

function renderSummary(downloadMbps, uploadMbps) {
  const floor = Math.min(downloadMbps, uploadMbps);
  const ratio = uploadMbps > 0 ? downloadMbps / uploadMbps : NaN;
  const asymmetry = Number.isFinite(ratio) ? `${ratio.toFixed(2)}:1` : 'n/a';
  elements.summaryStats.innerHTML = [
    { label: 'lower bound',        value: formatMbps(floor) },
    { label: 'symmetry',           value: asymmetry },
    { label: 'dominant bottleneck', value: downloadMbps < uploadMbps ? 'Download path' : 'Upload path' }
  ]
    .map((item) => `
      <article class="summary-item">
        <p class="summary-item-label">${item.label}</p>
        <p class="summary-item-value">${item.value}</p>
      </article>
    `)
    .join('');
}

function renderComparisons(downloadMbps, uploadMbps, standards) {
  elements.comparisonTable.innerHTML = standards
    .map((standard) => {
      const lowerRatio = Math.min(downloadMbps, uploadMbps) / standard.mbps;
      let status = 'fail', label = 'below';
      if (lowerRatio >= 1)   { status = 'pass';    label = 'meets'; }
      else if (lowerRatio >= 0.6) { status = 'partial'; label = 'close'; }
      return `
        <article class="comparison-row">
          <div>
            <p class="comparison-name">${standard.name}</p>
            <p class="comparison-note">${standard.note}</p>
          </div>
          <div>
            <p class="comparison-value">Ref: ${formatMbps(standard.mbps)}</p>
            <p class="comparison-value">Link floor: ${formatMbps(Math.min(downloadMbps, uploadMbps))}</p>
          </div>
          <div class="comparison-result ${status}">${label}</div>
        </article>
      `;
    })
    .join('');
}

async function loadConfig() {
  if (configCache) return configCache;
  const response = await fetch('/api/config', { cache: 'no-store' });
  configCache = await response.json();
  return configCache;
}

// ─── measureDownload ──────────────────────────────────────────────────────────
// Launches PARALLEL_STREAMS concurrent fetch streams that share a single window
// accumulator and sample list. Each stream calls onChunk() as data arrives;
// JS is single-threaded so there is no actual concurrency hazard.
//
// Instant display: adaptive EMA (fast alpha during ramp, slow when steady).
// Final result:    trimmed mean of post-warmup interval samples, falling back
//                  to (total bytes / total seconds) when the test is too short
//                  to collect enough samples (e.g. very slow connections).
async function measureDownload(requestedBytes, standards) {
  const bytesPerStream = Math.ceil(requestedBytes / PARALLEL_STREAMS);
  const startedAt      = performance.now();

  // Shared state written by onChunk(), read by updateDisplay() via rAF.
  let totalReceived  = 0;
  let windowBytes    = 0;
  let windowStartMs  = null;   // lazy start — avoids measuring connection latency
  let smoothedMbps   = 0;
  let displayMbps    = 0;
  let ceilingMbps    = resolveGaugeCeiling(0, standards);
  let rafId          = null;
  const samples      = [];     // post-warmup interval speed readings
  let warmupDone     = false;

  const updateDisplay = () => {
    rafId = null;
    const elapsed = (performance.now() - startedAt) / 1000;
    elements.downloadValue.textContent  = formatMbps(displayMbps);
    elements.downloadDetail.textContent =
      `${formatMegabytes(totalReceived)} transferred in ${elapsed.toFixed(2)}s`;
    updateGauge(
      elements.downloadGaugeFill, elements.downloadGaugeNeedle,
      elements.downloadGaugeCeiling, displayMbps, ceilingMbps
    );
  };

  const onChunk = (byteCount) => {
    totalReceived += byteCount;
    const now     = performance.now();
    const elapsed = now - startedAt;

    // Lazy window start: skip until the first byte arrives so connection
    // setup time is not included in any speed window.
    if (windowStartMs === null) {
      windowStartMs = now;
      windowBytes   = 0;
    }
    windowBytes += byteCount;

    const windowMs = now - windowStartMs;
    if (windowMs >= MIN_SAMPLE_INTERVAL_MS) {
      // Compute interval speed and update the EMA.
      const instMbps = (windowBytes * 8) / (windowMs / 1000) / 1_000_000;
      // Use a faster alpha while the TCP window is still opening (first 3 s).
      const alpha    = elapsed < 3000 ? SMOOTHING_ALPHA_FAST : SMOOTHING_ALPHA_STEADY;
      smoothedMbps   = smoothedMbps === 0
        ? instMbps
        : smoothedMbps * (1 - alpha) + instMbps * alpha;

      // Record post-warmup samples for the final trimmed mean.
      if (elapsed > WARMUP_MS) {
        warmupDone = true;
        samples.push(instMbps);
      }

      // Reset window.
      windowBytes   = 0;
      windowStartMs = now;
      displayMbps   = smoothedMbps;

      const newCeiling = resolveGaugeCeiling(displayMbps, standards);
      if (newCeiling > ceilingMbps) ceilingMbps = newCeiling;
    }

    if (rafId === null) rafId = requestAnimationFrame(updateDisplay);
  };

  // Run all streams in parallel; each independently reads its response body
  // and funnels chunks through the shared onChunk() callback.
  await Promise.all(
    Array.from({ length: PARALLEL_STREAMS }, async (_, i) => {
      const res = await fetch(
        `/api/download?bytes=${bytesPerStream}&r=${Date.now()}-${i}`,
        { cache: 'no-store' }
      );
      if (!res.body) {
        const buf = await res.arrayBuffer();
        onChunk(buf.byteLength);
        return;
      }
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        onChunk(value.byteLength);
      }
    })
  );

  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }

  const seconds = (performance.now() - startedAt) / 1000;

  // Final result: prefer the trimmed mean over the bulk average so that
  // the TCP ramp-up and any trailing stall don't skew the reported figure.
  const finalMbps = samples.length >= 4
    ? trimmedMean(samples, TRIM_FRACTION)
    : (totalReceived * 8) / seconds / 1_000_000;

  elements.downloadValue.textContent  = formatMbps(finalMbps);
  elements.downloadDetail.textContent =
    `${formatMegabytes(totalReceived)} transferred in ${seconds.toFixed(2)}s`;
  updateGauge(
    elements.downloadGaugeFill, elements.downloadGaugeNeedle,
    elements.downloadGaugeCeiling, finalMbps, resolveGaugeCeiling(finalMbps, standards)
  );

  return { mbps: finalMbps, seconds, bytes: totalReceived };
}

// ─── measureUpload ────────────────────────────────────────────────────────────
// Replaces serial passes with PARALLEL_STREAMS concurrent XHR uploads.
// Each XHR tracks its own `loaded` bytes; onProgress() sums them across all
// streams to get aggregate throughput, then samples it with the same adaptive
// EMA + warmup + trimmed-mean logic used for download.
async function measureUpload(uploadPayloadBytes, uploadPasses, standards) {
  // Payload is shared (read-only send) across all XHRs.
  const payload      = createRandomPayload(uploadPayloadBytes);
  const numStreams    = Math.max(PARALLEL_STREAMS, Math.min(uploadPasses, 4));
  const startedAt    = performance.now();

  // Per-stream progress counters (bytes sent so far per XHR).
  const streamLoaded = new Array(numStreams).fill(0);

  let totalConfirmedBytes = 0;   // bytes acknowledged by the server
  let ceilingMbps         = resolveGaugeCeiling(0, standards);

  // Shared window / EMA state (same pattern as download).
  let windowStartBytes = null;   // null = lazy start
  let windowStartMs    = null;
  let smoothedMbps     = 0;
  let displayMbps      = 0;
  let rafId            = null;
  const samples        = [];

  const updateDisplay = () => {
    rafId = null;
    const elapsed       = (performance.now() - startedAt) / 1000;
    const totalUploaded = streamLoaded.reduce((a, b) => a + b, 0);
    elements.uploadValue.textContent  = formatMbps(displayMbps);
    elements.uploadDetail.textContent =
      `${formatMegabytes(totalUploaded)} uploaded in ${elapsed.toFixed(2)}s`;
    updateGauge(
      elements.uploadGaugeFill, elements.uploadGaugeNeedle,
      elements.uploadGaugeCeiling, displayMbps, ceilingMbps
    );
  };

  // Called by each XHR's upload.onprogress; `loaded` is that stream's bytes.
  const onProgress = (streamIdx, loaded) => {
    streamLoaded[streamIdx] = loaded;
    const now           = performance.now();
    const elapsed       = now - startedAt;
    const totalUploaded = streamLoaded.reduce((a, b) => a + b, 0);

    // Lazy window start.
    if (windowStartMs === null) {
      windowStartMs    = now;
      windowStartBytes = totalUploaded;
    }

    const windowMs = now - windowStartMs;
    if (windowMs >= MIN_SAMPLE_INTERVAL_MS) {
      const windowByteDelta = totalUploaded - windowStartBytes;
      const instMbps        = (windowByteDelta * 8) / (windowMs / 1000) / 1_000_000;
      const alpha           = elapsed < 3000 ? SMOOTHING_ALPHA_FAST : SMOOTHING_ALPHA_STEADY;
      smoothedMbps          = smoothedMbps === 0
        ? instMbps
        : smoothedMbps * (1 - alpha) + instMbps * alpha;

      if (elapsed > WARMUP_MS) samples.push(instMbps);

      // Reset window.
      windowStartMs    = now;
      windowStartBytes = totalUploaded;
      displayMbps      = smoothedMbps;

      const newCeiling = resolveGaugeCeiling(displayMbps, standards);
      if (newCeiling > ceilingMbps) ceilingMbps = newCeiling;
    }

    if (rafId === null) rafId = requestAnimationFrame(updateDisplay);
  };

  await Promise.all(
    Array.from({ length: numStreams }, (_, i) =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/upload?r=${Date.now()}-${i}`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');

        xhr.upload.onprogress = (evt) => {
          if (evt.lengthComputable) onProgress(i, evt.loaded);
        };

        xhr.onload = () => {
          // Cancel any pending rAF from this stream before the caller
          // writes the final values so they are not overwritten.
          if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const data = JSON.parse(xhr.responseText);
              totalConfirmedBytes += data.receivedBytes || uploadPayloadBytes;
              resolve();
            } catch (e) { reject(e); }
          } else {
            reject(new Error('Upload failed: ' + xhr.status));
          }
        };

        xhr.onerror = () => reject(new Error('Upload network error'));
        xhr.send(payload);
      })
    )
  );

  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }

  const seconds = (performance.now() - startedAt) / 1000;

  const finalMbps = samples.length >= 4
    ? trimmedMean(samples, TRIM_FRACTION)
    : (totalConfirmedBytes * 8) / seconds / 1_000_000;

  elements.uploadValue.textContent  = formatMbps(finalMbps);
  elements.uploadDetail.textContent =
    `${formatMegabytes(totalConfirmedBytes)} transferred in ${seconds.toFixed(2)}s`;
  updateGauge(
    elements.uploadGaugeFill, elements.uploadGaugeNeedle,
    elements.uploadGaugeCeiling, finalMbps, resolveGaugeCeiling(finalMbps, standards)
  );

  return { mbps: finalMbps, seconds, bytes: totalConfirmedBytes };
}

// ─── runBenchmark ─────────────────────────────────────────────────────────────
async function runBenchmark() {
  elements.rerunButton.disabled = true;
  elements.verdictText.textContent    = 'Running benchmark…';
  elements.summaryStats.innerHTML     = '';
  elements.comparisonTable.innerHTML  = '';
  elements.downloadValue.textContent  = '--';
  elements.uploadValue.textContent    = '--';
  elements.downloadDetail.textContent = 'Waiting for measurement';
  elements.uploadDetail.textContent   = 'Waiting for measurement';

  try {
    const config  = await loadConfig();
    const profile = getFixedProfile(config);

    const idleGaugeCeiling = resolveGaugeCeiling(0, config.standards);
    updateGauge(elements.downloadGaugeFill, elements.downloadGaugeNeedle,
      elements.downloadGaugeCeiling, 0, idleGaugeCeiling);
    updateGauge(elements.uploadGaugeFill, elements.uploadGaugeNeedle,
      elements.uploadGaugeCeiling, 0, idleGaugeCeiling);

    const download = await measureDownload(profile.downloadBytes, config.standards);
    elements.downloadValue.textContent  = formatMbps(download.mbps);
    elements.downloadDetail.textContent =
      `${formatMegabytes(download.bytes)} transferred in ${download.seconds.toFixed(2)}s`;

    const upload = await measureUpload(
      profile.uploadPayloadBytes, config.uploadPasses, config.standards
    );
    elements.uploadValue.textContent  = formatMbps(upload.mbps);
    elements.uploadDetail.textContent =
      `${formatMegabytes(upload.bytes)} transferred in ${upload.seconds.toFixed(2)}s`;

    elements.verdictText.textContent = getTierLabel(download.mbps, upload.mbps);
    renderSummary(download.mbps, upload.mbps);
    renderComparisons(download.mbps, upload.mbps, config.standards);
  } catch (error) {
    console.error(error);
    elements.verdictText.textContent =
      'Unable to complete the speed test. Check server logs and browser console.';
  } finally {
    elements.rerunButton.disabled = false;
  }
}

elements.rerunButton.addEventListener('click', () => { runBenchmark(); });
window.addEventListener('load', () => { runBenchmark(); });