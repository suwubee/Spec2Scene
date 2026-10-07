import {chromium} from 'playwright';

export async function browser(options = {}) {
  return chromium.launch({headless: true, args: ['--no-sandbox', ...(process.env.SCENE_SOFTWARE_GL === '1' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [])],
    ...(process.env.SCENE_CHROMIUM ? {executablePath: process.env.SCENE_CHROMIUM} : {}), ...options});
}

export function auditPage(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`); });
  page.on('requestfailed', request => errors.push(`Network ${request.url()}: ${request.failure()?.errorText}`));
  return () => { if (errors.length) throw new Error(errors.join('\n')); };
}

export async function prepare(page, url) {
  await page.goto(url, {waitUntil: 'networkidle'});
  await page.evaluate(() => document.fonts.ready);
}

export async function sceneReady(page) {
  await page.waitForFunction(() => window.__scene?.ready === true && typeof window.__scene.seek === 'function');
}
