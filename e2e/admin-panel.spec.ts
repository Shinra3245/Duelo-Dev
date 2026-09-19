import { expect, test, type Page } from '@playwright/test';

const adminEmail = process.env.E2E_ADMIN_EMAIL;
const adminPassword = process.env.E2E_ADMIN_PASSWORD;
const adminConfigured = Boolean(adminEmail && adminPassword);
const closeAllEnabled = process.env.E2E_ADMIN_CLOSE_ALL === '1';

test.describe('panel administrativo en navegador', () => {
  test.skip(
    !adminConfigured,
    'Requiere E2E_ADMIN_EMAIL y E2E_ADMIN_PASSWORD; nunca se guardan en el repositorio',
  );
  test.setTimeout(60_000);

  test('crea una sala, la cierra y conserva su historial', async ({ page }) => {
    await loginAsAdmin(page);
    const room = await createRoom(page);
    const roomCard = page.locator('article.admin-room-card').filter({ hasText: room.room_code });

    await expect(roomCard).toBeVisible();
    await expect(roomCard.getByRole('button', { name: 'Cerrar sala' })).toBeVisible();

    const closeResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/v1/admin/rooms/${room.match_id}/close`) &&
        response.request().method() === 'POST',
    );
    page.once('dialog', (dialog) => void dialog.accept());
    await roomCard.getByRole('button', { name: 'Cerrar sala' }).click();
    expect((await closeResponse).ok()).toBeTruthy();

    await expect(roomCard).toContainText('abandoned');
    await expect(roomCard.getByRole('button', { name: 'Cerrar sala' })).toHaveCount(0);
    await page
      .getByRole('combobox', { name: 'Filtrar salas por estado' })
      .selectOption('abandoned');
    await expect(roomCard).toBeVisible();
  });

  test('cierra todas las salas activas cuando se habilita explícitamente', async ({ page }) => {
    test.skip(
      !closeAllEnabled,
      'Requiere E2E_ADMIN_CLOSE_ALL=1 porque modifica todas las salas activas del entorno',
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
    await expect(roomCard).toContainText('abandoned');
  });
});

async function loginAsAdmin(page: Page) {
  await page.goto('/admin');
  await page.getByLabel('Correo').fill(adminEmail!);
  await page.getByLabel('Contraseña').fill(adminPassword!);
  await page.getByRole('button', { name: 'Entrar al panel' }).click();
  await expect(page.getByRole('heading', { name: 'Panel administrativo' })).toBeVisible();
}

async function createRoom(page: Page): Promise<{ match_id: string; room_code: string }> {
  const createResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/admin/rooms/create') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Crear sala' }).click();
  const response = await createResponse;
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { match_id: string; room_code: string };
  await expect(page.getByText(body.room_code, { exact: true })).toBeVisible();
  return body;
}
