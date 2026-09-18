import { expect, test, type Page } from '@playwright/test';

const tournamentEnabled = process.env.E2E_TOURNAMENT === '1';

test.describe('flujo de torneo en navegador', () => {
  test.skip(
    !tournamentEnabled,
    'Requiere E2E_TOURNAMENT=1, servicios LAN activos y el worker aislado del juez',
  );
  test.setTimeout(120_000);

  test('dos jugadores llegan del lobby a un veredicto AC', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const rivalContext = await browser.newContext();
    const host = await hostContext.newPage();
    const rival = await rivalContext.newPage();
    const hostGamertag = `host-${Date.now().toString(36).slice(-7)}`;
    const rivalGamertag = `rival-${Date.now().toString(36).slice(-7)}`;

    try {
      await enterAsGuest(host, hostGamertag);
      await host.getByRole('button', { name: 'Puntos' }).click();
      await expect(host.getByRole('heading', { name: 'Lobby' })).toBeVisible();

      const roomCode = (await host.locator('header h1').textContent())?.trim();
      expect(roomCode).toMatch(/^[A-Z0-9]{6}$/);

      await enterAsGuest(rival, rivalGamertag);
      await rival.getByLabel('Código de sala').fill(roomCode!);
      await rival.getByRole('button', { name: 'Unirse' }).click();
      await expect(rival.getByRole('heading', { name: 'Lobby' })).toBeVisible();
      await expect(host.getByText(rivalGamertag, { exact: true })).toBeVisible();

      await host.getByRole('button', { name: 'Marcar como listo' }).click();
      await rival.getByRole('button', { name: 'Marcar como listo' }).click();
      await expect(host.getByText('Listo', { exact: true }).first()).toBeVisible();
      await host.getByRole('button', { name: 'Empezar partida' }).click();

      await expect(host.getByRole('heading', { name: 'Partida en curso' })).toBeVisible();
      await expect(host.getByLabel('Editor de solución Python')).toBeEnabled();
      await host
        .getByLabel('Editor de solución Python')
        .fill(
          'import sys\nvalores = list(map(int, sys.stdin.read().split()))\nprint(sum(valores[1:]))\n',
        );
      await host.getByRole('button', { name: 'Enviar Solución' }).click();

      await expect(host.getByText('Último veredicto: AC', { exact: true })).toBeVisible({
        timeout: 90_000,
      });
      await expect(host.getByRole('heading', { name: 'Resultados finales' })).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await rivalContext.close();
      await hostContext.close();
    }
  });
});

async function enterAsGuest(page: Page, gamertag: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Invitado', exact: true }).click();
  await page.getByLabel('Gamertag').fill(gamertag);
  await page.getByRole('button', { name: 'Jugar como Invitado' }).click();
  await expect(page.getByText(gamertag, { exact: true })).toBeVisible();
}
