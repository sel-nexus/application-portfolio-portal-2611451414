/** Capture representative interface structure and styling for source-level review. */
import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('capture source-level interface evidence', async ({ page }, info) => {
  const observations: string[] = [];
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  /** Save accessible structure, computed tokens and rendered markup without changing inventory. */
  async function capture(name: string) {
    observations.push(`\n## ${name}\n${await page.locator('body').ariaSnapshot()}\n`);
    observations.push(JSON.stringify(await page.evaluate(() => {
      const style = getComputedStyle(document.body);
      const card = document.querySelector('.card');
      return { font: style.fontFamily, background: style.backgroundColor,
        width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
        cardShadow: card ? getComputedStyle(card).boxShadow : null,
        heading: document.querySelector('h1')?.textContent };
    })));
    observations.push(await page.content());
    await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
  }
  await capture('signin-desktop');
  await page.getByLabel('Email', { exact: true }).fill('executive@portfolio.local');
  await page.getByLabel('Password', { exact: true }).fill('PortalDemo123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Total Applications', exact: true })).toBeVisible();
  await capture('dashboard-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture('dashboard-mobile');
  await page.getByRole('link', { name: 'Applications', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await capture('applications-mobile');
  await writeFile('preflight-evidence.txt', observations.join('\n'), 'utf-8');
});
