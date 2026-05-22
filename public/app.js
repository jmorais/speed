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
const FIXED_TEST_BYTES = 250 * 1024 * 1024;

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
  if (!Number.isFinite(value) || value <= 0) {
    return '--';
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)} Gbps`;
  }

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
  const nextStandard = standards.find((standard) => valueMbps <= standard.mbps);

  if (nextStandard) {
    return Math.max(nextStandard.mbps, fallbackCeiling);
  }

  return Math.max(Math.ceil(valueMbps / 1000) * 1000, fallbackCeiling);
}

function updateGauge(fillElement, needleElement, ceilingElement, valueMbps, maxMbps) {
  const safeMax = Math.max(maxMbps, 1);
  const ratio = clamp(valueMbps / safeMax, 0, 1);
  const dashOffset = 100 - ratio * 100;
  const degrees = -90 + ratio * 180;

  fillElement.style.strokeDashoffset = String(dashOffset);
  needleElement.style.transform = `rotate(${degrees}deg)`;
  ceilingElement.textContent = formatCeiling(safeMax);
}

function getFixedProfile(config) {
  return {
    downloadBytes: Math.min(FIXED_TEST_BYTES, config.maxDownloadBytes),
    uploadPayloadBytes: Math.min(FIXED_TEST_BYTES, config.uploadLimitBytes),
    downloadMiB: bytesToMiB(Math.min(FIXED_TEST_BYTES, config.maxDownloadBytes)),
    uploadMiB: bytesToMiB(Math.min(FIXED_TEST_BYTES, config.uploadLimitBytes))
  };
}

function getTierLabel(downloadMbps, uploadMbps) {
  const floor = Math.min(downloadMbps, uploadMbps);

  if (floor >= 2500) {
    return 'Excellent local link. This is comfortably above multi-gig home networking.';
  }

  if (floor >= 1000) {
    return 'Strong connection. This is in gigabit-class territory.';
  }

  if (floor >= 400) {
    return 'Good connection. This is above typical Wi-Fi 5 performance.';
  }

  if (floor >= 100) {
    return 'Usable connection. Faster than Fast Ethernet, but not especially high-end.';
  }

  return 'Weak local link. This is below Fast Ethernet and likely a bottleneck.';
}

function renderSummary(downloadMbps, uploadMbps) {
  const floor = Math.min(downloadMbps, uploadMbps);
  const ratio = uploadMbps > 0 ? downloadMbps / uploadMbps : NaN;
  const asymmetry = Number.isFinite(ratio) ? `${ratio.toFixed(2)}:1` : 'n/a';

  elements.summaryStats.innerHTML = [
    { label: 'lower bound', value: formatMbps(floor) },
    { label: 'symmetry', value: asymmetry },
    { label: 'dominant bottleneck', value: downloadMbps < uploadMbps ? 'Download path' : 'Upload path' }
  ]
    .map(
      (item) => `
        <article class="summary-item">
          <p class="summary-item-label">${item.label}</p>
          <p class="summary-item-value">${item.value}</p>
        </article>
      `
    )
    .join('');
}

function renderComparisons(downloadMbps, uploadMbps, standards) {
  elements.comparisonTable.innerHTML = standards
    .map((standard) => {
      const lowerRatio = Math.min(downloadMbps, uploadMbps) / standard.mbps;
      let status = 'fail';
      let label = 'below';

      if (lowerRatio >= 1) {
        status = 'pass';
        label = 'meets';
      } else if (lowerRatio >= 0.6) {
        status = 'partial';
        label = 'close';
      }

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
  if (configCache) {
    return configCache;
  }

  const response = await fetch('/api/config', { cache: 'no-store' });
  configCache = await response.json();
  return configCache;
}

async function measureDownload(requestedBytes, standards) {
  const response = await fetch(`/api/download?bytes=${requestedBytes}&r=${Date.now()}`, {
    cache: 'no-store'
  });

  if (!response.body) {
    // Fallback to non-streaming path
    const startedAt = performance.now();
    const buffer = await response.arrayBuffer();
    const seconds = (performance.now() - startedAt) / 1000;
    const bytes = Math.max(buffer.byteLength, requestedBytes);
    const mbps = (bytes * 8) / seconds / 1_000_000;

    elements.downloadValue.textContent = formatMbps(mbps);
    elements.downloadDetail.textContent = `${formatMegabytes(bytes)} transferred in ${seconds.toFixed(2)}s`;
    updateGauge(elements.downloadGaugeFill, elements.downloadGaugeNeedle, elements.downloadGaugeCeiling, mbps, resolveGaugeCeiling(mbps, standards));

    return { mbps, seconds, bytes };
  }

  const reader = response.body.getReader();
  let received = 0;
  const startedAt = performance.now();

  // Instantaneous / smoothed sampling (display updates occur via requestAnimationFrame)
  let lastSampleBytes = 0;
  let lastSampleTime = startedAt;
  let smoothedMbps = 0;
  const SMOOTHING_ALPHA = 0.25;
  let rafPending = false;
  let displayMbps = 0;

  const updateDisplay = () => {
    const elapsed = (performance.now() - startedAt) / 1000;
    elements.downloadValue.textContent = formatMbps(displayMbps);
    elements.downloadDetail.textContent = `${formatMegabytes(received)} transferred in ${elapsed.toFixed(2)}s`;
    updateGauge(elements.downloadGaugeFill, elements.downloadGaugeNeedle, elements.downloadGaugeCeiling, displayMbps, resolveGaugeCeiling(displayMbps, standards));
    rafPending = false;
  };

  // read loop
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    received += value.byteLength;
    const now = performance.now();

    const deltaBytes = received - lastSampleBytes;
    const deltaSeconds = Math.max((now - lastSampleTime) / 1000, 1e-6);
    const instMbps = (deltaBytes * 8) / deltaSeconds / 1_000_000;

    if (!Number.isFinite(smoothedMbps) || smoothedMbps === 0) {
      smoothedMbps = instMbps;
    } else {
      smoothedMbps = smoothedMbps * (1 - SMOOTHING_ALPHA) + instMbps * SMOOTHING_ALPHA;
    }

    lastSampleBytes = received;
    lastSampleTime = now;

    displayMbps = smoothedMbps;

    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(updateDisplay);
    }
  }

  const seconds = (performance.now() - startedAt) / 1000;
  const mbps = (received * 8) / seconds / 1_000_000;

  // final update (overall average)
  elements.downloadValue.textContent = formatMbps(mbps);
  elements.downloadDetail.textContent = `${formatMegabytes(received)} transferred in ${seconds.toFixed(2)}s`;
  updateGauge(elements.downloadGaugeFill, elements.downloadGaugeNeedle, elements.downloadGaugeCeiling, mbps, resolveGaugeCeiling(mbps, standards));

  return { mbps, seconds, bytes: received };
}

async function measureUpload(uploadPayloadBytes, uploadPasses, standards) {
  // Prefer streaming upload (no large in-memory buffer) when supported.
  const canStream = typeof ReadableStream === 'function' && typeof fetch === 'function';

  if (canStream) {
    let totalBytes = 0;
    const startedAt = performance.now();

    // Sampling for instantaneous speed
    let lastSampleBytes = 0;
    let lastSampleTime = startedAt;
    let smoothedMbps = 0;
    const SMOOTHING_ALPHA = 0.25;
    let rafPending = false;
    let displayMbps = 0;

    const updateDisplay = () => {
      const elapsed = (performance.now() - startedAt) / 1000;
      elements.uploadValue.textContent = formatMbps(displayMbps);
      elements.uploadDetail.textContent = `${formatMegabytes(totalBytes)} uploaded in ${elapsed.toFixed(2)}s`;
      updateGauge(elements.uploadGaugeFill, elements.uploadGaugeNeedle, elements.uploadGaugeCeiling, displayMbps, resolveGaugeCeiling(displayMbps, standards));
      rafPending = false;
    };

    for (let pass = 0; pass < uploadPasses; pass += 1) {
      let sentForPass = 0;
      const chunkSize = 64 * 1024;

      const stream = new ReadableStream({
        start(controller) {
          function push() {
            if (sentForPass >= uploadPayloadBytes) {
              controller.close();
              return;
            }

            const size = Math.min(chunkSize, uploadPayloadBytes - sentForPass);
            const chunk = new Uint8Array(size);
            crypto.getRandomValues(chunk);
            controller.enqueue(chunk);
            sentForPass += size;
            totalBytes += size;

            const now = performance.now();
            const deltaBytes = totalBytes - lastSampleBytes;
            const deltaSeconds = Math.max((now - lastSampleTime) / 1000, 1e-6);
            const instMbps = (deltaBytes * 8) / deltaSeconds / 1_000_000;

            if (!Number.isFinite(smoothedMbps) || smoothedMbps === 0) {
              smoothedMbps = instMbps;
            } else {
              smoothedMbps = smoothedMbps * (1 - SMOOTHING_ALPHA) + instMbps * SMOOTHING_ALPHA;
            }

            lastSampleBytes = totalBytes;
            lastSampleTime = now;
            displayMbps = smoothedMbps;

            if (!rafPending) {
              rafPending = true;
              requestAnimationFrame(updateDisplay);
            }

            // Yield occasionally so the browser can render and the network can drain.
            if (controller.desiredSize > 0) {
              // Slight async gap to keep UI responsive on large uploads
              setTimeout(push, 0);
            } else {
              setTimeout(push, 0);
            }
          }

          push();
        }
      });

      const res = await fetch(`/api/upload?r=${Date.now()}-${pass}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: stream
      });

      if (!res.ok) {
        throw new Error('Upload failed: ' + res.status);
      }

      const data = await res.json();
      // server returns receivedBytes for the pass
      totalBytes = Math.max(totalBytes, data.receivedBytes || totalBytes);
    }

    const seconds = (performance.now() - startedAt) / 1000;
    const mbps = (totalBytes * 8) / seconds / 1_000_000;

    elements.uploadValue.textContent = formatMbps(mbps);
    elements.uploadDetail.textContent = `${formatMegabytes(totalBytes)} transferred in ${seconds.toFixed(2)}s`;
    updateGauge(elements.uploadGaugeFill, elements.uploadGaugeNeedle, elements.uploadGaugeCeiling, mbps, resolveGaugeCeiling(mbps, standards));

    return { mbps, seconds, bytes: totalBytes };
  }

  // Fallback: build in-memory payload and use XHR for progress events (older browsers)
  const payload = createRandomPayload(uploadPayloadBytes);
  let totalBytes = 0;
  const startedAt = performance.now();

  for (let pass = 0; pass < uploadPasses; pass += 1) {
    // eslint-disable-next-line no-undef
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/upload?r=${Date.now()}-${pass}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');

      xhr.upload.onprogress = (evt) => {
        const now = performance.now();
        const elapsed = (now - startedAt) / 1000;
        const bytesSoFar = totalBytes + (evt.loaded || 0);
        const mbps = (bytesSoFar * 8) / elapsed / 1_000_000;

        elements.uploadValue.textContent = formatMbps(mbps);
        elements.uploadDetail.textContent = `${formatMegabytes(bytesSoFar)} uploaded in ${elapsed.toFixed(2)}s`;
        updateGauge(elements.uploadGaugeFill, elements.uploadGaugeNeedle, elements.uploadGaugeCeiling, mbps, resolveGaugeCeiling(mbps, standards));
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            totalBytes += data.receivedBytes || 0;
            resolve();
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error('Upload failed: ' + xhr.status));
        }
      };

      xhr.onerror = () => reject(new Error('Upload network error'));
      xhr.send(payload);
    });
  }

  const seconds = (performance.now() - startedAt) / 1000;
  const mbps = (totalBytes * 8) / seconds / 1_000_000;

  elements.uploadValue.textContent = formatMbps(mbps);
  elements.uploadDetail.textContent = `${formatMegabytes(totalBytes)} transferred in ${seconds.toFixed(2)}s`;
  updateGauge(elements.uploadGaugeFill, elements.uploadGaugeNeedle, elements.uploadGaugeCeiling, mbps, resolveGaugeCeiling(mbps, standards));

  return { mbps, seconds, bytes: totalBytes };
}

async function runBenchmark() {
  elements.rerunButton.disabled = true;
  elements.verdictText.textContent = 'Running benchmark…';
  elements.summaryStats.innerHTML = '';
  elements.comparisonTable.innerHTML = '';
  elements.downloadValue.textContent = '--';
  elements.uploadValue.textContent = '--';
  elements.downloadDetail.textContent = 'Waiting for measurement';
  elements.uploadDetail.textContent = 'Waiting for measurement';

  try {
    const config = await loadConfig();
    const profile = getFixedProfile(config);
    const idleGaugeCeiling = resolveGaugeCeiling(0, config.standards);

    updateGauge(elements.downloadGaugeFill, elements.downloadGaugeNeedle, elements.downloadGaugeCeiling, 0, idleGaugeCeiling);
    updateGauge(elements.uploadGaugeFill, elements.uploadGaugeNeedle, elements.uploadGaugeCeiling, 0, idleGaugeCeiling);

    const download = await measureDownload(profile.downloadBytes, config.standards);

    // download UI already updated during streaming, ensure final values are set
    elements.downloadValue.textContent = formatMbps(download.mbps);
    elements.downloadDetail.textContent = `${formatMegabytes(download.bytes)} transferred in ${download.seconds.toFixed(2)}s`;

    const upload = await measureUpload(profile.uploadPayloadBytes, config.uploadPasses, config.standards);

    // upload UI already updated during streaming, ensure final values are set
    elements.uploadValue.textContent = formatMbps(upload.mbps);
    elements.uploadDetail.textContent = `${formatMegabytes(upload.bytes)} transferred in ${upload.seconds.toFixed(2)}s`;

    elements.verdictText.textContent = getTierLabel(download.mbps, upload.mbps);
    renderSummary(download.mbps, upload.mbps);
    renderComparisons(download.mbps, upload.mbps, config.standards);
  } catch (error) {
    console.error(error);
    elements.verdictText.textContent = 'Unable to complete the speed test. Check server logs and browser console.';
  } finally {
    elements.rerunButton.disabled = false;
  }
}

elements.rerunButton.addEventListener('click', () => {
  runBenchmark();
});

window.addEventListener('load', () => {
  runBenchmark();
});