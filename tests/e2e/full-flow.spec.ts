import { expect, test } from '@playwright/test';

/**
 * Full flow from the spec: niche → campaign → search → find → dedupe → website discovery →
 * analyse → qualify → audit → outreach → CRM. Runs against fixture sites + mock providers.
 */
test('niche → search → qualified leads → audit → outreach → CRM', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // 1. first-run setup
  await page.goto('/');
  await page.getByLabel('Your name').fill('Anna');
  await page.getByLabel('E-mail').fill('owner@studio.test');
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();

  // 2. search from a natural-language command
  await page.goto('/search');
  await page.getByPlaceholder(/Describe it/).fill('Find 20 стоматологии in Warsaw for website redesign');
  await page.getByRole('button', { name: 'Fill form' }).click();
  await page.getByRole('button', { name: /FIND BEST LEADS/ }).click();
  await page.waitForURL(/\/jobs\//);

  // 3. job runs through all stages (discovery, merge, website discovery, live analysis, qualification)
  await expect(page.locator('h1')).toContainText('completed', { timeout: 180_000 });
  const results = page.getByRole('table').first();
  await expect(results).toContainText('Smile Dental Stomatologia');
  await expect(results).toContainText('Nova Dental Clinic');
  // duplicates merged: Smile appears once even though two sources returned it
  await expect(results.getByRole('link', { name: 'Smile Dental Stomatologia' })).toHaveCount(1);

  // 4. lead detail: decision intelligence + evidence
  await results.getByRole('link', { name: 'Smile Dental Stomatologia' }).click();
  await expect(page.locator('h1')).toContainText('Smile Dental Stomatologia');
  await expect(page.getByText('Why this lead').first()).toBeVisible();
  await expect(page.getByText(/viewport/i).first()).toBeVisible();

  // 5. audit (template, built from recorded evidence)
  await page.getByRole('button', { name: 'Generate (template)' }).click();
  await expect(page.getByRole('button', { name: 'HTML', exact: true })).toBeVisible();

  // 6. outreach draft — nothing is sent automatically
  await page.locator('#outreach').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Generate draft' }).click();
  const body = page.getByLabel('Message body');
  await expect(body).not.toHaveValue('');
  await expect(page.getByText('Nothing is sent automatically.')).toBeVisible();
  const text = await body.inputValue();
  expect(text).not.toMatch(/guarantee|100%|you are losing/i);

  // 7. the user sends it themselves, then marks it
  await page.getByRole('button', { name: 'I sent it — mark contacted' }).click();
  await expect(page.getByRole('button', { name: /^Sent / })).toBeVisible();
  await expect(page.getByLabel('CRM stage')).toHaveValue('contacted');

  // 8. CRM board shows the lead as contacted
  await page.goto('/crm');
  const column = page.locator('section, div').filter({ has: page.getByText('Contacted', { exact: true }) }).filter({ hasText: 'Smile Dental Stomatologia' });
  await expect(column.first()).toBeVisible();

  // 9. Today and Dashboard render real data without errors
  await page.goto('/today');
  await expect(page.locator('h1')).toBeVisible();
  await page.goto('/dashboard');
  await expect(page.locator('h1')).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('phone layout: no panel runs off the screen', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('E-mail').fill('owner@studio.test');
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('h1')).toBeVisible();
  const leadId = await page.evaluate(async () => (await (await fetch('/api/leads?pageSize=1')).json()).rows[0].id as string);
  for (const path of ['/today', '/leads', `/leads/${leadId}`, '/crm', '/dashboard', '/search', '/campaigns', '/learning', '/business', '/settings']) {
    await page.goto(path);
    await expect(page.locator('h1').first()).toBeVisible();
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      return Array.from(document.querySelectorAll('section')).map((s) => ({ right: Math.round(s.getBoundingClientRect().right), text: (s.querySelector('h2')?.textContent ?? '').slice(0, 40) })).filter((s) => s.right > w + 1);
    });
    expect(overflow, `${path} panels overflow the 390px viewport`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${path} scrolls horizontally`).toBe(true);
  }
  await context.close();
});
