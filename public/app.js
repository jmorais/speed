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
const FIXED_TEST_BYTES = 100 * 1024 * 1024;

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

async function measureDownload(requestedBytes) {
  const startedAt = performance.now();
  const response = await fetch(`/api/download?bytes=${requestedBytes}&r=${Date.now()}`, {
    cache: 'no-store'
  });
  const buffer = await response.arrayBuffer();
  const seconds = (performance.now() - startedAt) / 1000;
  const bytes = Math.max(buffer.byteLength, requestedBytes);
  const mbps = (bytes * 8) / seconds / 1_000_000;

  return {
    mbps,
    seconds,
    bytes
  };
}

async function measureUpload(uploadPayloadBytes, uploadPasses) {
  const payload = createRandomPayload(uploadPayloadBytes);
  let totalBytes = 0;
  const startedAt = performance.now();

  for (let index = 0; index < uploadPasses; index += 1) {
    const response = await fetch(`/api/upload?r=${Date.now()}-${index}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream'
      },
      body: payload
    });
    const data = await response.json();
    totalBytes += data.receivedBytes;
  }

  const seconds = (performance.now() - startedAt) / 1000;
  const mbps = (totalBytes * 8) / seconds / 1_000_000;

  return {
    mbps,
    seconds,
    bytes: totalBytes
  };
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

    const download = await measureDownload(profile.downloadBytes);
    elements.downloadValue.textContent = formatMbps(download.mbps);
    elements.downloadDetail.textContent = `${formatMegabytes(download.bytes)} transferred in ${download.seconds.toFixed(2)}s`;
    updateGauge(
      elements.downloadGaugeFill,
      elements.downloadGaugeNeedle,
      elements.downloadGaugeCeiling,
      download.mbps,
      resolveGaugeCeiling(download.mbps, config.standards)
    );

    const upload = await measureUpload(profile.uploadPayloadBytes, config.uploadPasses);
    elements.uploadValue.textContent = formatMbps(upload.mbps);
    elements.uploadDetail.textContent = `${formatMegabytes(upload.bytes)} transferred in ${upload.seconds.toFixed(2)}s`;
    updateGauge(
      elements.uploadGaugeFill,
      elements.uploadGaugeNeedle,
      elements.uploadGaugeCeiling,
      upload.mbps,
      resolveGaugeCeiling(upload.mbps, config.standards)
    );

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