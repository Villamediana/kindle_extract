// Verifica se Widevine CDM está disponível no Chromium do Playwright
const { chromium } = require('playwright');

async function main() {
  console.log('teste 1: headless padrão (sem flags extras)');
  await test({ headless: true });

  console.log('\nteste 2: headed + Xvfb (presume DISPLAY setado)');
  if (process.env.DISPLAY) await test({ headless: false });
  else console.log('  (sem DISPLAY, pulando)');
}

async function test(opts) {
  const browser = await chromium.launch({
    ...opts,
    args: ['--no-sandbox', '--enable-features=PlatformEncryptedDolbyVision,WidevineCdm']
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const r = await page.evaluate(async () => {
    const result = { ua: navigator.userAgent };
    // Verifica suporte Widevine
    try {
      const config = [{
        initDataTypes: ['cenc'],
        audioCapabilities: [{ contentType: 'audio/mp4;codecs="mp4a.40.2"' }],
        videoCapabilities: [{ contentType: 'video/mp4;codecs="avc1.42E01E"' }]
      }];
      const access = await navigator.requestMediaKeySystemAccess('com.widevine.alpha', config);
      result.widevine = 'OK: ' + access.keySystem;
    } catch (e) {
      result.widevine = 'FAIL: ' + e.message;
    }
    // Verifica suporte ao com.google.widevine
    try {
      const access2 = await navigator.requestMediaKeySystemAccess('com.widevine.alpha.experiment', [{ initDataTypes: ['cenc'], audioCapabilities: [{ contentType: 'audio/mp4;codecs="mp4a.40.2"' }] }]);
      result.widevineExp = 'OK';
    } catch (e) {
      result.widevineExp = 'FAIL: ' + e.message.slice(0, 80);
    }
    // ClearKey (sempre suportado)
    try {
      await navigator.requestMediaKeySystemAccess('org.w3.clearkey', config);
      result.clearkey = 'OK';
    } catch (e) {
      result.clearkey = 'FAIL: ' + e.message.slice(0, 80);
    }
    return result;
  });
  console.log(JSON.stringify(r, null, 2));
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
