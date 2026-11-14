// Renders src/icons/icon.svg to the PNG sizes the manifest needs.
// Usage: CHROME_PATH=/path/to/chrome node scripts/make-icons.mjs
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const svg = await readFile('src/icons/icon.svg', 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
for (const size of [16, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  await page.screenshot({ path: `src/icons/icon${size}.png`, omitBackground: true });
  await page.close();
}
await browser.close();
console.log('icons written');
