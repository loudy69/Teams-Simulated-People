// Renders clips/watermark.png (transparent banner) using Edge, since ffmpeg drawtext is unavailable here.
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const b = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });
  const p = await b.newPage({ viewport: { width: 640, height: 360 } });
  await p.setContent(`<body style="margin:0;background:transparent;width:640px;height:360px;position:relative;font-family:Segoe UI,Arial,sans-serif">
    <div style="position:absolute;left:0;right:0;bottom:0;height:40px;background:rgba(0,0,0,.65);color:#fff;
      font-weight:700;font-size:20px;letter-spacing:0.5px;text-align:center;line-height:40px">Teams Demo - these are not real people</div></body>`);
  await p.screenshot({ path: path.join(__dirname, '..', 'clips', 'watermark.png'), omitBackground: true });
  await b.close();
})();
