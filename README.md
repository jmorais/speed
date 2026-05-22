# LAN Speed Check

Minimal browser-to-server speed test for LAN use on Synology NAS or Ubuntu.

It measures:

- Download speed from server to browser
- Upload speed from browser to server
- Relative performance against common network classes such as Fast Ethernet, Wi-Fi 5, Wi-Fi 6, Wi-Fi 7, and Gigabit Ethernet

## Stack

- Node.js + Express server
- Static HTML/CSS/JS frontend
- Docker-ready with a single container

## Local run

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Docker run

```bash
docker build -t speed-lan-check .
docker run --rm -p 3000:3000 speed-lan-check
```

Open `http://SERVER_IP:3000` from a browser on the device you want to test.

## Docker Compose

```bash
docker compose up --build -d
```

## Synology notes

- Use `linux/amd64` or `linux/arm64` when prebuilding the image, depending on your NAS CPU.
- If you use Container Manager, map port `3000` from the container to a host port.
- Access the page from phones, laptops, or desktops on your network to test their link to the NAS.

## Environment variables

- `PORT`: HTTP port, default `3000`
-- `DOWNLOAD_CHUNK_SIZE`: bytes per server chunk, default `65536`
-- `DOWNLOAD_CHUNKS`: number of chunks streamed to the browser, default `4000` (to support 250 MiB)
-- `UPLOAD_PAYLOAD_BYTES`: bytes sent per upload pass, default `262144000` (250 MiB)
-- `UPLOAD_PASSES`: number of upload passes, default `1`
-- `UPLOAD_LIMIT_MB`: maximum accepted upload size in MB, default `512`

## Notes on measurement

- This measures browser-to-server throughput, not internet speed.
- Results vary by browser, device CPU, Wi-Fi conditions, reverse proxies, and NAS hardware.
- The comparison table is intentionally directional. It tells you whether the observed link is below, close to, or meeting common network classes.