/**
 * Visual snapshot test for the four campaign-planning admin screens.
 * Runs against the deployed worker at WORKER_URL.
 *
 * Usage:
 *   node scripts/visual-test.mjs
 *
 * Outputs screenshots to: scripts/screenshots/
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'screenshots');

const WORKER_URL = 'https://visibility-marketing.wetechfounders.workers.dev';
const ADMIN_TOKEN = 'tss2T_rXGS5-xEY4E6q6GogNa-sLx8DLvikdTTpjGPk';

const SCREENS = [
  {
    name: '01-campaign-objectives',
    path: '/api/admin/campaign-objectives/screen',
    label: 'Campaign Objectives',
  },
  {
    name: '02-campaign-segments',
    path: '/api/admin/campaign-segments/screen',
    label: 'Segment Selection',
  },
  {
    name: '03-strategic-briefings',
    path: '/api/admin/strategic-briefings/screen',
    label: 'Strategic Briefing',
  },
  {
    name: '04-channel-intent',
    path: '/api/admin/channel-intent/screen',
    label: 'Channel Preference Intent',
  },
];

async function run() {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
  });

  const page = await context.newPage();
  const results = [];

  for (const screen of SCREENS) {
    const url = `${WORKER_URL}${screen.path}`;
    console.log(`\n→ ${screen.label}`);
    console.log(`  GET ${url}`);

    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });

    // Wait for body to be non-empty
    await page.waitForSelector('body', { timeout: 5000 });

    const title = await page.title();
    const h1 = await page.$eval('h1', (el) => el?.textContent?.trim()).catch(() => '(none)');
    const status = page.url().includes('error') ? 'WARN' : 'OK';

    const outFile = path.join(OUT_DIR, `${screen.name}.png`);
    await page.screenshot({ path: outFile, fullPage: true });

    results.push({ screen: screen.label, title, h1, status, file: outFile });
    console.log(`  title: ${title}`);
    console.log(`  h1:    ${h1}`);
    console.log(`  saved: ${outFile}`);
  }

  console.log('\n─── Summary ─────────────────────────────────────────');
  for (const r of results) {
    const icon = r.status === 'OK' ? '✓' : '⚠';
    console.log(`  ${icon}  ${r.screen.padEnd(30)} → ${r.file}`);
  }
  console.log('─────────────────────────────────────────────────────\n');

  await browser.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
