const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--no-sandbox']
  });
  const page = await browser.newPage();
  const r = await page.evaluate(async () => {
    const result = { ua: navigator.userAgent };
    try {
      const access = await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
        initDataTypes: ['cenc'],
        audioCapabilities: [{ contentType: 'audio/mp4;codecs="mp4a.40.2"' }],
        videoCapabilities: [{ contentType: 'video/mp4;codecs="avc1.42E01E"' }]
      }]);
      result.widevine = 'OK keySystem=' + access.keySystem;
    } catch (e) {
      result.widevine = 'FAIL: ' + e.message;
    }
    return result;
  });
  console.log(JSON.stringify(r, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
