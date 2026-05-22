const crypto = require('crypto');
const express = require('express');

const app = express();

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const downloadChunkSize = Number(process.env.DOWNLOAD_CHUNK_SIZE || 64 * 1024);
const downloadChunks = Number(process.env.DOWNLOAD_CHUNKS || 4000);
const uploadLimitMb = Number(process.env.UPLOAD_LIMIT_MB || 512);
const uploadPayloadBytes = Number(process.env.UPLOAD_PAYLOAD_BYTES || 250 * 1024 * 1024);
const uploadPasses = Number(process.env.UPLOAD_PASSES || 1);
const maxDownloadBytes = downloadChunkSize * downloadChunks;

app.use(express.static('public'));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/config', (_req, res) => {
  res.json({
    downloadChunkSize,
    downloadChunks,
    maxDownloadBytes,
    uploadPayloadBytes,
    uploadPasses,
    uploadLimitBytes: uploadLimitMb * 1024 * 1024,
    standards: [
      {
        name: 'Fast Ethernet',
        mbps: 100,
        note: 'Older wired LAN baseline'
      },
      {
        name: 'Wi-Fi 5',
        mbps: 433,
        note: 'Typical single-stream 802.11ac'
      },
      {
        name: 'Gigabit Ethernet',
        mbps: 1000,
        note: 'Common wired home network ceiling'
      },
      {
        name: 'Wi-Fi 6',
        mbps: 1200,
        note: 'Good modern 802.11ax range'
      },
      {
        name: '2.5 Gigabit',
        mbps: 2500,
        note: 'Higher-end NAS and switch setups'
      },
      {
        name: 'Wi-Fi 7',
        mbps: 3600,
        note: 'Emerging high-end wireless class'
      },
      {
        name: '10 Gigabit',
        mbps: 10000,
        note: 'Prosumer or lab-grade wired backbone'
      }
    ]
  });
});

app.get('/api/download', (req, res) => {
  const requestedBytes = Number(req.query.bytes) || 0;
  const requestedChunks = Number(req.query.chunks) || 0;
  const chunkCount = requestedBytes > 0
    ? Math.max(1, Math.min(Math.ceil(requestedBytes / downloadChunkSize), downloadChunks))
    : Math.max(1, Math.min(requestedChunks || downloadChunks, downloadChunks));
  const chunk = crypto.randomBytes(downloadChunkSize);

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline; filename="speed.bin"');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Length', String(chunk.length * chunkCount));

  let written = 0;

  function write() {
    while (written < chunkCount) {
      const canContinue = res.write(chunk);
      written += 1;

      if (!canContinue) {
        res.once('drain', write);
        return;
      }
    }

    res.end();
  }

  write();
});

app.post('/api/upload', (req, res) => {
  let receivedBytes = 0;
  let limitExceeded = false;
  const maxBytes = uploadLimitMb * 1024 * 1024;

  req.on('data', (chunk) => {
    receivedBytes += chunk.length;

    if (receivedBytes > maxBytes) {
      limitExceeded = true;
    }
  });

  req.on('end', () => {
    if (limitExceeded) {
      res.status(413).json({ error: 'Upload payload exceeded server limit.' });
      return;
    }

    res.json({
      receivedBytes,
      receivedAt: Date.now()
    });
  });

  req.on('error', (error) => {
    if (limitExceeded) {
      res.status(413).json({ error: 'Upload payload exceeded server limit.' });
      return;
    }

    res.status(500).json({ error: error.message || 'Upload stream failed.' });
  });
});

app.listen(port, host, () => {
  console.log(`speed-lan-check listening on http://${host}:${port}`);
});