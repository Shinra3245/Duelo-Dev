import { expect, test, type Page } from '@playwright/test';

const adminEmail = process.env.E2E_ADMIN_EMAIL;
const adminPassword = process.env.E2E_ADMIN_PASSWORD;
const adminConfigured = Boolean(adminEmail && adminPassword);
const disposableStackEnabled = process.env.E2E_DISPOSABLE_STACK === '1';
const closeAllEnabled = process.env.E2E_ADMIN_CLOSE_ALL === '1' && disposableStackEnabled;

test.describe('panel administrativo en navegador', () => {
  test.skip(
    !adminConfigured,
    'Requiere E2E_ADMIN_EMAIL y E2E_ADMIN_PASSWORD; nunca se guardan en el repositorio',
  );
  test.setTimeout(60_000);

  test('conserva legibilidad y acceso a los datos en móvil', async ({ page }) => {
    await loginAsAdmin(page);

    const desktop = await page.evaluate(() => {
      const panels = [...document.querySelectorAll('.admin-grid-bottom > .admin-panel')].map(
        (panel) => panel.getBoundingClientRect(),
      );
      return {
        fitsViewport: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        rankingPanelsDoNotOverlap:
          panels.length < 2 ||
          panels[0]!.right <= panels[1]!.left ||
          panels[1]!.right <= panels[0]!.left,
      };
    });
    expect(desktop.fitsViewport).toBe(true);
    expect(desktop.rankingPanelsDoNotOverlap).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('.admin-table-wrap td:not(.admin-table-empty)')];
      const firstCell = cells[0];
      const primaryButton = document.querySelector('.admin-primary')!;
      const luminance = (color: string) => {
        const channels = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number);
        const linear = channels.map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
      };
      const primaryStyles = getComputedStyle(primaryButton);
      const [lighter, darker] = [
        luminance(primaryStyles.color),
        luminance(primaryStyles.backgroundColor),
      ].sort((left, right) => right - left);
      return {
        fitsViewport: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        tablesUseCards:
          getComputedStyle(document.querySelector('.admin-table-wrap tbody')!).display === 'grid',
        everyCellHasLabel: cells.every((cell) => Boolean(cell.getAttribute('data-label'))),
        firstCellLabel: firstCell ? getComputedStyle(firstCell, '::before').content : null,
        primaryContrast: (lighter! + 0.05) / (darker! + 0.05),
      };
    });
    expect(mobile.fitsViewport).toBe(true);
    expect(mobile.tablesUseCards).toBe(true);
    expect(mobile.everyCellHasLabel).toBe(true);
    expect(mobile.primaryContrast).toBeGreaterThanOrEqual(4.5);
    if (mobile.firstCellLabel !== null) expect(mobile.firstCellLabel).not.toBe('none');
    await expect(page.getByRole('button', { name: 'Crear sala' })).toBeVisible();
  });

  test('crea una sala, la cierra y conserva su historial', async ({ page }) => {
    await loginAsAdmin(page);
    const room = await createRoom(page);
    const roomCard = page.locator('article.admin-room-card').filter({ hasText: room.room_code });

    await expect(roomCard).toBeVisible();
    await expect(roomCard.locator('.admin-room-summary')).toContainText(
      `0/${room.config.max_players}`,
    );
    await expect(roomCard).toContainText('Sala vacía');
    await expect(roomCard.getByRole('button', { name: 'Cerrar sala' })).toBeVisible();

    const closeResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/v1/admin/rooms/${room.match_id}/close`) &&
        response.request().method() === 'POST',
    );
    page.once('dialog', (dialog) => void dialog.accept());
    await roomCard.getByRole('button', { name: 'Cerrar sala' }).click();
    expect((await closeResponse).ok()).toBeTruthy();

    await expect(roomCard).toContainText('Cerradas');
    await expect(roomCard.getByRole('button', { name: 'Cerrar sala' })).toHaveCount(0);
    await page
      .getByRole('combobox', { name: 'Filtrar salas por estado' })
      .selectOption('abandoned');
    await expect(roomCard).toBeVisible();
  });

  test('configura una sala de tres jugadores desde el panel', async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByLabel('Modo').selectOption('rondas');
    await page.getByLabel('Duración de Rondas').selectOption('900');
    const room = await createRoom(page, 3);
    expect(room.config.max_players).toBe(3);
    expect(room.config.mode).toBe('rondas');
    expect(room.config.match_duration_s).toBe(900);

    const roomCard = page.locator('article.admin-room-card').filter({ hasText: room.room_code });
    await expect(roomCard).toContainText('Lobby');
    await expect(roomCard.locator('.admin-room-summary')).toContainText('0/3');
    await expect(roomCard).toContainText('Sala vacía');

    const closeResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/v1/admin/rooms/${room.match_id}/close`) &&
        response.request().method() === 'POST',
    );
    page.once('dialog', (dialog) => void dialog.accept());
    await roomCard.getByRole('button', { name: 'Cerrar sala' }).click();
    expect((await closeResponse).ok()).toBeTruthy();
    await expect(roomCard).toContainText('Cerradas');
  });

  test('cierra todas las salas activas cuando se habilita explícitamente', async ({ page }) => {
    test.skip(
      !closeAllEnabled,
      'Requiere E2E_ADMIN_CLOSE_ALL=1 y E2E_DISPOSABLE_STACK=1 con una base de datos y Redis desechables',
    );

    await loginAsAdmin(page);
    const room = await createRoom(page);
    const roomCard = page.locator('article.admin-room-card').filter({ hasText: room.room_code });
    const closeAllButton = page.getByRole('button', { name: /Cerrar todas las salas activas/ });

    await expect(closeAllButton).toBeEnabled();
    const closeAllResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/admin/rooms/close-all') &&
        response.request().method() === 'POST',
    );
    page.once('dialog', (dialog) => void dialog.accept());
    await closeAllButton.click();
    const response = await closeAllResponse;
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as { closed_count: number };
    expect(body.closed_count).toBeGreaterThanOrEqual(1);
    await expect(roomCard).toContainText('Cerradas');
  });
});

async function loginAsAdmin(page: Page) {
  await page.goto('/admin');
  await page.getByLabel('Correo').fill(adminEmail!);
  await page.getByLabel('Contraseña').fill(adminPassword!);
  await page.getByRole('button', { name: 'Entrar al panel' }).click();
  await expect(page.getByRole('heading', { name: 'Panel administrativo' })).toBeVisible();
  await expect(page.locator('.admin-layout')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeEnabled();
}

async function createRoom(
  page: Page,
  maxPlayers = 2,
): Promise<{
  match_id: string;
  room_code: string;
  config: { max_players: number; mode: string; match_duration_s?: number };
}> {
  if (maxPlayers !== 2) {
    await page.getByLabel('Jugadores').selectOption(String(maxPlayers));
  }

  const createResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/admin/rooms/create') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Crear sala' }).click();
  const response = await createResponse;
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    match_id: string;
    room_code: string;
    config: { max_players: number; mode: string; match_duration_s?: number };
  };
  await expect(
    page.locator('article.admin-room-card').filter({ hasText: body.room_code }),
  ).toBeVisible();
  return body;
}
