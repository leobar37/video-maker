const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const resp = await page.goto('https://customers-assets.theelena.me/login', { waitUntil: 'networkidle', timeout: 45000 });
  console.log('HTTP:', resp.status());
  await page.waitForTimeout(1200); // let fonts/hydration settle

  const visibleText = await page.evaluate(() => document.body.innerText.trim());
  console.log('--- visibleText ---');
  console.log(visibleText);

  const email = await page.locator('input[type="email"], input[name*="mail" i], input[name*="user" i]').count();
  const submit = await page.locator('button[type="submit"], button:has-text("Entrar"), button:has-text("Iniciar")').count();
  const anyInput = await page.locator('input').count();
  const styles = await page.evaluate(() => {
    const card = document.querySelector('form')?.closest('div[class], form[class]') || document.querySelector('main, body > div');
    const cs = card ? getComputedStyle(card) : null;
    const body = getComputedStyle(document.body);
    const sheets = document.styleSheets.length;
    let cssRules = 0;
    try { for (const s of document.styleSheets) cssRules += s.cssRules ? s.cssRules.length : 0; } catch (e) {}
    return {
      sheets, cssRules,
      bodyBg: body.backgroundColor,
      bodyFont: body.fontFamily,
      cardDisplay: cs?.display,
      cardPad: cs?.padding,
      cardRadius: cs?.borderRadius,
      cardBg: cs?.backgroundColor,
      cardShadow: cs?.boxShadow?.slice(0, 60),
      hasStylesheetLink: !!document.querySelector('link[rel="stylesheet"]'),
    };
  });
  console.log('--- checks ---');
  console.log(JSON.stringify({ emailInput: email, submitBtn: submit, anyInput, ...styles }, null, 2));

  await page.screenshot({ path: 'evidence/customer-assets-portal/p006-live/login-check.png', fullPage: false });
  console.log('screenshot saved');
  await browser.close();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
