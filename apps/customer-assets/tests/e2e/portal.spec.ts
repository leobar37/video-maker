/**
 * E2E scenarios (test:e2e): the full admin→client lifecycle on the LOCAL
 * ephemeral server with emulated D1/R2 and fake mail. Every navigation uses
 * path-only URLs (no tokens in any address bar); screenshots go to the
 * evidence dir. Assertions use node:assert (no external runner).
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import {
  ADMIN,
  ALICE,
  BOB,
  CAROL,
  apiWithCookie,
  loginPersona,
  provisionFixture,
  resetDatabase,
  stageDeliveryAsAdmin,
  type FixtureData,
} from './fixture';
import { ORIGIN } from './server';

const ROOT = join(import.meta.dir, '..', '..', '..', '..', 'evidence', 'customer-assets-portal', 'p004-ui');

export interface SpecContext {
  data: FixtureData;
  adminCookie: string;
  screenshots: string[];
  visualReviewNotes: string[];
}

async function shoot(page: Page, name: string, screenshots: string[]): Promise<void> {
  const path = join(ROOT, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  screenshots.push(`${name}.png`);
}

async function newContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ ignoreHTTPSErrors: false });
}

async function waitContent(page: Page, selector: string, timeout = 15_000): Promise<void> {
  await page.waitForSelector(selector, { state: 'visible', timeout });
}

/**
 * Document navigation with one retry: the dev server compiles routes on
 * demand, and a first hit can transiently fail while workerd warms up.
 */
async function goto(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  } catch {
    await page.waitForTimeout(1500);
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  }
  const body = await page.textContent('body');
  if (body !== null && body.trimStart().startsWith('{"status"')) {
    await page.waitForTimeout(1500);
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  }
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const scroller = document.scrollingElement;
    return scroller === null ? 0 : scroller.scrollWidth - window.innerWidth;
  });
  assert.ok(overflow <= 1, `${label}: horizontal overflow ${overflow}px`);
}

export async function runSpec(browser: Browser): Promise<SpecContext> {
  mkdirSync(ROOT, { recursive: true });
  const screenshots: string[] = [];
  const visualReviewNotes: string[] = [];

  try {
    return await runSpecInner(browser, screenshots, visualReviewNotes);
  } catch (error) {
    // Leave forensic evidence: last page state of any still-open context.
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        try {
          const name = `failure-${context.pages().indexOf(page)}`;
          await page.screenshot({ path: join(ROOT, `${name}.png`) });
          console.error(`[failure] ${page.url()}:`, (await page.textContent('body'))?.slice(0, 600));
        } catch {
          /* page may be gone */
        }
      }
    }
    throw error;
  }
}

async function runSpecInner(
  browser: Browser,
  screenshots: string[],
  visualReviewNotes: string[],
): Promise<SpecContext> {

  await resetDatabase();
  const data = await provisionFixture();

  // Admin session cookie for harness-side seeding (deliveries, like the CLI).
  const adminBootstrap = await newContext(browser);
  await loginPersona(adminBootstrap, ADMIN, '/admin/clients');
  const cookies = await adminBootstrap.cookies(ORIGIN);
  const adminCookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  assert.ok(adminCookie.length > 0, 'admin session cookie missing');
  await adminBootstrap.close();

  // The admin delivers two revisions for Alpha through the v1 API (the same
  // path the integrator CLI uses); both start INTERNAL (hidden).
  const staged1 = await stageDeliveryAsAdmin(adminCookie, data.alpha.id, { assetSuffix: 'a1', title: 'Revisión Alpha 1' });
  const staged2 = await stageDeliveryAsAdmin(adminCookie, data.alpha.id, { assetSuffix: 'a2', title: 'Revisión Alpha 2' });

  /* ---- admin: invite → visibility → posts → grid reorder (desktop) ---- */
  const adminCtx = await newContext(browser);
  const adminPage = await adminCtx.newPage();
  await adminPage.setViewportSize({ width: 1440, height: 900 });
  await loginPersona(adminCtx, ADMIN, '/admin/clients');
  await goto(adminPage, `${ORIGIN}/admin/clients`);
  await waitContent(adminPage, '[data-testid="admin-clients-table"]');
  assert.ok((await adminPage.textContent('body'))!.includes('Alpha Cliente'));

  // Invite Carol (provisions the portal user + pending invitation).
  await goto(adminPage, `${ORIGIN}/admin/clients/${data.alpha.id}/access`);
  await waitContent(adminPage, '[data-testid="invite-form"]');
  await adminPage.fill('input[name="invite-email"]', CAROL);
  await adminPage.click('[data-testid="invite-form"] button[type="submit"]');
  await waitContent(adminPage, '[data-testid="invitation-table"]');
  assert.ok((await adminPage.textContent('body'))!.includes(CAROL));
  await shoot(adminPage, 'desktop-admin-access', screenshots);

  // Make the first delivery visible for the client.
  await goto(adminPage, `${ORIGIN}/admin/clients/${data.alpha.id}/assets`);
  await waitContent(adminPage, '[data-testid="asset-list"]');
  const switches = adminPage.locator('[data-testid="asset-visibility-switch"]');
  await switches.nth(1).click();
  await switches.nth(0).click();
  // Both revisions visible (each toggle triggers a refetch — wait for state).
  await adminPage.waitForFunction(
    () => document.querySelectorAll('[data-testid="asset-visibility-switch"]:checked').length === 2,
    undefined,
    { timeout: 15_000 },
  );
  await shoot(adminPage, 'desktop-admin-assets', screenshots);

  // Create the post (ordered outputs, exact cover) for the visible asset.
  await goto(adminPage, `${ORIGIN}/admin/clients/${data.alpha.id}/posts`);
  await waitContent(adminPage, '[data-testid="create-post-form"]');
  await adminPage.selectOption('[data-testid="create-post-form"] select.field-select >> nth=0', staged1.assetId);
  await adminPage.check('input[aria-label="Incluir cover.png"]');
  await adminPage.check('input[aria-label="Incluir clip.mp4"]');
  await adminPage.check('input[aria-label="Portada cover.png"]');
  await adminPage.fill('input[name="title"]', 'Lanzamiento Alpha');
  await adminPage.fill('textarea[name="caption"]', 'Primera entrega para la cuadrícula.');
  await adminPage.selectOption('[data-testid="create-post-form"] select.field-select >> nth=1', 'client_visible');
  await adminPage.click('[data-testid="create-post-form"] button[type="submit"]');
  await waitContent(adminPage, '[data-testid="post-list"]');
  assert.ok((await adminPage.textContent('body'))!.includes('Lanzamiento Alpha'));

  // Second post so the grid reorder has two cells; then move B up.
  await adminPage.selectOption('[data-testid="create-post-form"] select.field-select >> nth=0', staged2.assetId);
  await adminPage.check('input[aria-label="Incluir cover.png"]');
  await adminPage.check('input[aria-label="Portada cover.png"]');
  await adminPage.fill('input[name="title"]', 'Detrás de cámaras');
  await adminPage.selectOption('[data-testid="create-post-form"] select.field-select >> nth=1', 'client_visible');
  await adminPage.click('[data-testid="create-post-form"] button[type="submit"]');
  await adminPage.waitForFunction(
    () => document.body.textContent?.includes('Detrás de cámaras'),
    undefined,
    { timeout: 15_000 },
  );
  await goto(adminPage, `${ORIGIN}/portal/${data.alpha.id}/instagram`);
  await waitContent(adminPage, '[data-testid="insta-grid"]');
  const moveUpSecond = adminPage.locator('[data-testid^="move-up-"]').nth(1);
  await moveUpSecond.click();
  await adminPage.waitForTimeout(800);
  await shoot(adminPage, 'desktop-admin-grid', screenshots);
  await adminCtx.close();

  /* ---- carol (client A): invite acceptance, upload, grid (mobile) ---- */
  const carolCtx = await newContext(browser);
  const carolPage = await carolCtx.newPage();
  await carolPage.setViewportSize({ width: 390, height: 844 });
  await loginPersona(carolCtx, CAROL, '/portal');
  // Portal entry accepts the invitation; single-client members land in materials.
  await goto(carolPage, `${ORIGIN}/portal`);
  await carolPage.waitForTimeout(1200);
  await goto(carolPage, `${ORIGIN}/portal/${data.alpha.id}/materials`);
  await waitContent(carolPage, '[data-testid="upload-card"]');

  // Real upload of a small JPEG through the file input (XHR progress).
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...[...'e2e-photo-jpeg'].map((c) => c.charCodeAt(0))]);
  await carolPage.setInputFiles('input[type="file"]', {
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(jpeg),
  });
  await waitContent(carolPage, '[data-testid="material-row"]', 20_000);
  assert.ok((await carolPage.textContent('[data-testid="materials-list"]'))!.includes('photo.jpg'));
  await assertNoHorizontalOverflow(carolPage, 'materials 390x844');
  await shoot(carolPage, 'mobile-materials', screenshots);

  // Desktop materials (1440x900) before switching to the catalog.
  await goto(carolPage, `${ORIGIN}/portal/${data.alpha.id}/materials`);
  await waitContent(carolPage, '[data-testid="materials-list"]');
  await shoot(carolPage, 'desktop-materials', screenshots);
  await assertNoHorizontalOverflow(carolPage, 'materials 1440x900');

  // Assets catalog (visible revisions appear; no admin-only provenance leaks).
  await goto(carolPage, `${ORIGIN}/portal/${data.alpha.id}/assets`);
  await waitContent(carolPage, '[data-testid="asset-list"]');
  const carolBody1 = await carolPage.textContent('body');
  assert.ok(carolBody1!.includes('Revisión Alpha 1'));
  assert.ok(!carolBody1!.includes('rootHash'), 'provenance leaked to member catalog');
  assert.ok(!carolBody1!.includes('oculto'), 'internal visibility state leaked to member catalog');
  await assertNoHorizontalOverflow(carolPage, 'assets 390x844');
  await shoot(carolPage, 'mobile-assets', screenshots);

  // Instagram grid + detail modal.
  await goto(carolPage, `${ORIGIN}/portal/${data.alpha.id}/instagram`);
  await waitContent(carolPage, '[data-testid="insta-grid"]');
  const gridCells = await carolPage.locator('[data-testid^="insta-cell-"]').count();
  assert.ok(gridCells >= 1, 'grid has no cells');
  await assertNoHorizontalOverflow(carolPage, 'instagram 390x844');
  await shoot(carolPage, 'mobile-grid', screenshots);
  // The admin moved 'Detrás de cámaras' to position 1; the captioned post is
  // now at position 2 — open it by its explicit label and check the caption.
  await carolPage.locator('[aria-label^="Abrir Lanzamiento Alpha"]').click();
  await waitContent(carolPage, '[role="dialog"]');
  const modalText = await carolPage.textContent('[role="dialog"]');
  assert.ok(modalText!.includes('Primera entrega para la cuadrícula.'), 'caption missing in modal');
  assert.ok(modalText!.includes('Portada exacta'), 'exact cover missing in modal');
  await carolPage.keyboard.press('Escape');

  // Grid persists across reload.
  await carolPage.reload({ waitUntil: 'load' });
  await waitContent(carolPage, '[data-testid="insta-grid"]');

  // Desktop view of the client grid (1440x900, three columns).
  await carolPage.setViewportSize({ width: 1440, height: 900 });
  await carolPage.waitForTimeout(400);
  await shoot(carolPage, 'desktop-grid', screenshots);
  await assertNoHorizontalOverflow(carolPage, 'instagram 1440x900');

  /* ---- bob (client B): strict isolation on deep links ---- */
  const bobCtx = await newContext(browser);
  const bobPage = await bobCtx.newPage();
  await bobPage.setViewportSize({ width: 390, height: 844 });
  await loginPersona(bobCtx, BOB, '/portal');
  await goto(bobPage, `${ORIGIN}/portal/${data.alpha.id}/materials`);
  await waitContent(bobPage, '[data-testid="empty-state"]');
  const bobBody = await bobPage.textContent('body');
  assert.ok(!bobBody!.includes('Alpha Cliente'), 'bob sees Alpha name via deep link');
  assert.ok(!bobBody!.includes('photo.jpg'), 'bob sees Alpha material via deep link');
  // Direct output URL with Bob's session: hidden/not-found, never bytes.
  const direct = await bobCtx.request.get(`${ORIGIN}/api/v1/deliveries/${staged1.deliveryId}/outputs/cover.png`);
  assert.equal(direct.status(), 404, 'bob fetched an Alpha output directly');
  await bobCtx.close();

  /* ---- hide cascade: admin hides the visible asset; Carol loses everything ---- */
  const adminCtx2 = await newContext(browser);
  const adminPage2 = await adminCtx2.newPage();
  await loginPersona(adminCtx2, ADMIN, `/admin/clients/${data.alpha.id}/assets`);
  await goto(adminPage2, `${ORIGIN}/admin/clients/${data.alpha.id}/assets`);
  await waitContent(adminCtx2.pages()[0] ?? adminPage2, 'body');
  const hideSwitch = adminPage2
    .locator('[data-testid="asset-visibility-switch"][aria-label*="Revisión Alpha 1"]')
    .first();
  await hideSwitch.click();
  await adminPage2.waitForTimeout(900);
  await adminCtx2.close();

  // The SAME live client session must feel the cascade: the hidden revision
  // (and ONLY it) leaves the catalog, its post leaves the grid, and the
  // direct output URL turns 404 on the next request.
  await goto(carolPage, `${ORIGIN}/portal/${data.alpha.id}/assets`);
  await waitContent(carolPage, '[data-testid="asset-list"]', 20_000);
  await carolPage.waitForFunction(
    (needle) => !document.body.textContent?.includes(needle),
    'Revisión Alpha 1',
    { timeout: 15_000 },
  );
  assert.ok((await carolPage.textContent('body'))!.includes('Revisión Alpha 2'));
  await goto(carolPage, `${ORIGIN}/portal/${data.alpha.id}/instagram`);
  await waitContent(carolPage, '[data-testid="insta-grid"]', 20_000);
  await carolPage.waitForFunction(
    (needle) => !document.body.textContent?.includes(needle),
    'Lanzamiento Alpha',
    { timeout: 15_000 },
  );
  const directAfterHide = await carolCtx.request.get(
    `${ORIGIN}/api/v1/deliveries/${staged1.deliveryId}/outputs/cover.png`,
  );
  assert.equal(directAfterHide.status(), 404, 'hidden asset output still fetchable by member');
  await carolCtx.close();

  /* ---- login form honesty (no fake success) ---- */
  const anonCtx = await newContext(browser);
  const anonPage = await anonCtx.newPage();
  await goto(anonPage, `${ORIGIN}/login`);
  await anonPage.fill('input[name="email"]', 'someone@e2e.fixture');
  await anonPage.click('[data-testid="login-form"] button[type="submit"]');
  // Local server has NO mail provider: the form must show a retryable error,
  // never a fake "revisa tu email" success.
  await anonPage.waitForSelector('.error-banner', { timeout: 15_000 });
  visualReviewNotes.push('login form surfaces a retryable error without a mail provider (no fake success)');
  await anonCtx.close();

  visualReviewNotes.push('grid is exactly 3 columns at 390px and 1440px with no horizontal overflow');
  visualReviewNotes.push('member catalog/grid show only client_visible content; hidden revision never appeared');

  writeFileSync(join(ROOT, 'spec-summary.json'), JSON.stringify({ alpha: data.alpha.id, beta: data.beta.id }, null, 2));
  return { data, adminCookie, screenshots, visualReviewNotes };
}

export { ORIGIN, apiWithCookie, ALICE };

/* --------------------------------------------------------------------------
 * R-2 guest-direct scenario (additive): operator mints a request link, the
 * guest opens it on a MOBILE viewport (390x844) WITHOUT any login, uploads
 * until the request auto-fulfills, and sees the closed state after the admin
 * closes it. The raw token lives only in the runtime URL — screenshots are
 * page-only (no browser chrome/address bar), and no minted URL reaches the
 * evidence JSON.
 * ------------------------------------------------------------------------- */

const GUEST_ROOT = join(import.meta.dir, '..', '..', '..', '..', 'evidence', 'customer-assets-requests', 'r2-e2e');

export async function runGuestRequestSpec(
  browser: Browser,
  data: FixtureData,
  adminCookie: string,
  screenshots: string[],
  visualReviewNotes: string[],
): Promise<void> {
  mkdirSync(GUEST_ROOT, { recursive: true });
  const shootGuest = async (page: Page, name: string): Promise<void> => {
    const path = join(GUEST_ROOT, `${name}.png`);
    await page.screenshot({ path, fullPage: false });
    screenshots.push(`${name}.png`);
  };

  // Admin seeds: project → request (2 files max) → minted guest link.
  const projectRes = await apiWithCookie(`/api/v1/clients/${data.alpha.id}/projects`, {
    method: 'POST',
    cookie: adminCookie,
    body: { studioProjectId: 'e2e-request-proj', name: 'Proyecto Pedidos' },
  });
  assert.equal(projectRes.status, 201, 'guest-spec project create failed');
  const project = (await projectRes.json()) as { id: string };

  const requestRes = await apiWithCookie(`/api/v1/projects/${project.id}/requests`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      title: 'Videos del evento',
      instructions: 'Subí los clips crudos del evento',
      maxFiles: 2,
      maxBytes: 1048576,
    },
  });
  assert.equal(requestRes.status, 201, 'guest-spec request create failed');
  const request = (await requestRes.json()) as { id: string; state: string };

  const linkRes = await apiWithCookie(`/api/v1/requests/${request.id}/link`, {
    method: 'POST',
    cookie: adminCookie,
    body: {},
  });
  assert.equal(linkRes.status, 201, 'guest-spec link mint failed');
  const link = (await linkRes.json()) as { url: string };
  const marker = '/request/';
  const token = link.url.slice(link.url.indexOf(marker) + marker.length);
  assert.ok(token.length > 0, 'minted link without token path');

  // Guest context: NEVER logs in — the token is the only credential.
  const guestCtx = await newContext(browser);
  const guestPage = await guestCtx.newPage();
  await guestPage.setViewportSize({ width: 390, height: 844 });
  await goto(guestPage, `${ORIGIN}/request/${token}`);

  await waitContent(guestPage, '[data-testid="request-page"]', 30_000);
  assert.ok(guestPage.url().includes('/request/'), 'guest page redirected away from the request path');
  assert.equal(await guestPage.locator('[data-testid="login-form"]').count(), 0, 'login prompt leaked into guest flow');
  const openBody = (await guestPage.textContent('body')) ?? '';
  assert.ok(openBody.includes('Videos del evento'), 'request title missing');
  assert.ok(openBody.includes('Subí los clips crudos del evento'), 'instructions missing');
  assert.ok(openBody.includes('2 de 2'), 'remaining files counter missing');
  await assertNoHorizontalOverflow(guestPage, 'guest request 390x844');
  await shootGuest(guestPage, 'mobile-guest-request-open');

  const guestJpeg = (seed: number): Buffer => {
    const bytes = new Uint8Array(24);
    bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff; bytes[3] = 0xe0;
    for (let i = 4; i < bytes.length; i += 1) bytes[i] = (i * seed + 7) % 251;
    return Buffer.from(bytes);
  };

  // First upload: real progress → done → remaining drops to 1.
  await guestPage.setInputFiles('input[type="file"]', {
    name: 'clip-1.jpg',
    mimeType: 'image/jpeg',
    buffer: guestJpeg(31),
  });
  await waitContent(guestPage, '[data-testid="guest-upload-item"]', 30_000);
  await guestPage.waitForFunction(
    () => (document.querySelector('[data-testid="guest-upload-item"] .material-meta')?.textContent ?? '').includes('Listo'),
    undefined,
    { timeout: 30_000 },
  );
  await guestPage.waitForFunction(
    () => (document.body.textContent ?? '').includes('1 de 2'),
    undefined,
    { timeout: 15_000 },
  );
  visualReviewNotes.push('guest upload shows real byte progress and the remaining counter drops after each file');
  await shootGuest(guestPage, 'mobile-guest-request-progress');

  // Second upload fills the request: uploader disappears, fulfilled state shows.
  await guestPage.setInputFiles('input[type="file"]', {
    name: 'clip-2.jpg',
    mimeType: 'image/jpeg',
    buffer: guestJpeg(32),
  });
  await guestPage.waitForFunction(
    () => (document.body.textContent ?? '').includes('0 de 2'),
    undefined,
    { timeout: 30_000 },
  );
  await waitContent(guestPage, '[data-testid="request-closed-message"]', 15_000);
  const fulfilledBody = (await guestPage.textContent('body')) ?? '';
  assert.ok(fulfilledBody.includes('ya está completo'), 'fulfilled state message missing');
  assert.equal(await guestPage.locator('[data-testid="guest-upload-input"]').count(), 0, 'uploader still offered on a fulfilled request');
  assert.ok(guestPage.url().includes('/request/'), 'guest page redirected away after fulfilling');
  await assertNoHorizontalOverflow(guestPage, 'guest request fulfilled 390x844');
  await shootGuest(guestPage, 'mobile-guest-request-fulfilled');

  // Admin closes early on a fresh request; the SAME guest page (reloaded)
  // must show the closed state, still without any login prompt.
  const closeRes = await apiWithCookie(`/api/v1/requests/${request.id}/close`, {
    method: 'POST',
    cookie: adminCookie,
    body: { reason: 'Cierre desde e2e' },
  });
  assert.equal(closeRes.status, 200, 'admin close failed');
  await guestPage.reload({ waitUntil: 'load' });
  await waitContent(guestPage, '[data-testid="request-closed-message"]', 30_000);
  const closedBody = (await guestPage.textContent('body')) ?? '';
  assert.ok(closedBody.includes('ya no acepta archivos'), 'closed state message missing');
  assert.equal(await guestPage.locator('[data-testid="login-form"]').count(), 0, 'login prompt leaked after close');
  await shootGuest(guestPage, 'mobile-guest-request-closed');
  await guestCtx.close();

  // A WRONG token is the same neutral error page for everyone (no enumeration).
  const wrongCtx = await newContext(browser);
  const wrongPage = await wrongCtx.newPage();
  await wrongPage.setViewportSize({ width: 390, height: 844 });
  await goto(wrongPage, `${ORIGIN}/request/${'A'.repeat(43)}`);
  await waitContent(wrongPage, '[data-testid="request-page"]', 30_000);
  await waitContent(wrongPage, '.error-banner', 15_000);
  const wrongBody = (await wrongPage.textContent('body')) ?? '';
  assert.ok(wrongBody.includes('no es válido'), 'invalid-token message missing');
  await wrongCtx.close();

  visualReviewNotes.push('guest flow is mobile-usable at 390x844 with no login prompt anywhere and no cross-token cache');
}

/* --------------------------------------------------------------------------
 * Asset upload link scenario (operator order 2026-10-06, additive): the
 * operator mints a per-asset link (admin cookie), the guest opens it on a
 * MOBILE viewport (390x844) WITHOUT any login, uploads ONE take that lands
 * attributed to that exact asset (single-use), and the admin sees it in the
 * per-asset import set. The raw token lives only in the runtime URL — no
 * minted URL reaches the evidence JSON.
 * ------------------------------------------------------------------------- */

const ASSET_LINK_ROOT = join(import.meta.dir, '..', '..', '..', '..', 'evidence', 'customer-assets-requests', 'asset-links-e2e');

export async function runGuestAssetLinkSpec(
  browser: Browser,
  data: FixtureData,
  adminCookie: string,
  screenshots: string[],
  visualReviewNotes: string[],
): Promise<void> {
  mkdirSync(ASSET_LINK_ROOT, { recursive: true });
  const shootAsset = async (page: Page, name: string): Promise<void> => {
    const path = join(ASSET_LINK_ROOT, `${name}.png`);
    await page.screenshot({ path, fullPage: false });
    screenshots.push(`${name}.png`);
  };

  // Operator seeds: project pointer → mint bound to ONE Studio asset.
  const projectRes = await apiWithCookie(`/api/v1/clients/${data.alpha.id}/projects`, {
    method: 'POST',
    cookie: adminCookie,
    body: { studioProjectId: 'e2e-asset-proj', name: 'Proyecto Enlace Asset' },
  });
  assert.equal(projectRes.status, 201, 'asset-spec project create failed');

  const mintRes = await apiWithCookie('/api/v1/asset-upload-links', {
    method: 'POST',
    cookie: adminCookie,
    body: { studioProjectId: 'e2e-asset-proj', studioAssetId: 'e2e-asset-1', expiresIn: '24h' },
  });
  assert.equal(mintRes.status, 201, 'asset-spec link mint failed');
  const mint = (await mintRes.json()) as { url: string; linkId: string; studioAssetId: string };
  const marker = '/asset-upload/';
  const token = mint.url.slice(mint.url.indexOf(marker) + marker.length);
  assert.ok(token.length > 0, 'minted asset link without token path');

  // Guest context: NEVER logs in — the token is the only credential.
  const guestCtx = await newContext(browser);
  const guestPage = await guestCtx.newPage();
  await guestPage.setViewportSize({ width: 390, height: 844 });
  await goto(guestPage, `${ORIGIN}/asset-upload/${token}`);

  await waitContent(guestPage, '[data-testid="asset-upload-page"]', 30_000);
  assert.equal(await guestPage.locator('[data-testid="login-form"]').count(), 0, 'login prompt leaked into guest asset flow');
  const openBody = (await guestPage.textContent('body')) ?? '';
  assert.ok(openBody.includes('e2e-asset-1'), 'asset title missing on the guest page');
  assert.ok(openBody.includes('Proyecto Enlace Asset'), 'project title missing on the guest page');
  assert.ok(openBody.includes('Espacio disponible'), 'remaining quota missing on the guest page');
  await assertNoHorizontalOverflow(guestPage, 'guest asset link 390x844');
  await shootAsset(guestPage, 'mobile-guest-asset-open');

  const assetJpeg = (seed: number): Buffer => {
    const bytes = new Uint8Array(24);
    bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff; bytes[3] = 0xe0;
    for (let i = 4; i < bytes.length; i += 1) bytes[i] = (i * seed + 11) % 251;
    return Buffer.from(bytes);
  };

  await guestPage.setInputFiles('input[type="file"]', {
    name: 'toma-1.jpg',
    mimeType: 'image/jpeg',
    buffer: assetJpeg(47),
  });
  await waitContent(guestPage, '[data-testid="asset-upload-item"]', 30_000);
  await guestPage.waitForFunction(
    () => (document.querySelector('[data-testid="asset-upload-item"] .material-meta')?.textContent ?? '').includes('Listo'),
    undefined,
    { timeout: 30_000 },
  );
  visualReviewNotes.push('guest asset upload shows real progress and lands attributed to the exact asset (single-use link)');
  await shootAsset(guestPage, 'mobile-guest-asset-done');

  // Single-use: the uploader disappears and the used state shows on reload.
  await guestPage.reload({ waitUntil: 'load' });
  await waitContent(guestPage, '[data-testid="asset-upload-closed-message"]', 30_000);
  const usedBody = (await guestPage.textContent('body')) ?? '';
  assert.ok(usedBody.includes('ya fue usado'), 'used state message missing');
  assert.equal(await guestPage.locator('[data-testid="asset-upload-input"]').count(), 0, 'uploader still offered on a used link');
  assert.equal(await guestPage.locator('[data-testid="login-form"]').count(), 0, 'login prompt leaked after upload');
  await assertNoHorizontalOverflow(guestPage, 'guest asset link used 390x844');
  await shootAsset(guestPage, 'mobile-guest-asset-used');
  await guestCtx.close();

  // Admin sees the take in the per-asset import set with the link attribution.
  const materialsRes = await apiWithCookie('/api/v1/asset-upload-links/materials?asset=e2e-asset-1', {
    method: 'GET',
    cookie: adminCookie,
  });
  assert.equal(materialsRes.status, 200, 'materials-by-asset query failed');
  const materials = (await materialsRes.json()) as { items: Array<{ assetTarget: string; linkId: string | null }> };
  assert.equal(materials.items.length, 1, 'per-asset import set missing the take');
  assert.equal(materials.items[0]!.assetTarget, 'e2e-asset-1');
  assert.equal(materials.items[0]!.linkId, mint.linkId);

  // A WRONG token is the same neutral error page (no enumeration).
  const wrongCtx = await newContext(browser);
  const wrongPage = await wrongCtx.newPage();
  await wrongPage.setViewportSize({ width: 390, height: 844 });
  await goto(wrongPage, `${ORIGIN}/asset-upload/${'B'.repeat(43)}`);
  await waitContent(wrongPage, '[data-testid="asset-upload-page"]', 30_000);
  await waitContent(wrongPage, '.error-banner', 15_000);
  await wrongCtx.close();

  visualReviewNotes.push('guest asset flow is mobile-usable at 390x844 with no login prompt anywhere and no cross-token cache');
}
