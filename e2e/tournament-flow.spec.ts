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
      await expect(rival.getByText(hostGamertag, { exact: true })).toBeVisible();

      await host.getByRole('button', { name: 'Marcar como listo' }).click();
      await rival.getByRole('button', { name: 'Marcar como listo' }).click();
      await expect(host.getByText('Listo', { exact: true }).first()).toBeVisible();
      await host.getByRole('button', { name: 'Empezar partida' }).click();

      await expect(host.getByRole('heading', { name: 'Partida en curso' })).toBeVisible();
      await expect(rival.getByRole('heading', { name: 'Partida en curso' })).toBeVisible();
      await expect(host.locator('.duel-room-status')).toHaveText('En curso');

      const desktopColumns = await host
        .locator('.duel-room-live-grid > div')
        .evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
          }),
        );
      expect(desktopColumns).toHaveLength(2);
      expect(
        desktopColumns[0]!.left < desktopColumns[1]!.right &&
          desktopColumns[0]!.right > desktopColumns[1]!.left &&
          desktopColumns[0]!.top < desktopColumns[1]!.bottom &&
          desktopColumns[0]!.bottom > desktopColumns[1]!.top,
      ).toBe(false);

      await host.setViewportSize({ width: 390, height: 844 });
      await expect(host.locator('.duel-standings-mobile')).toBeVisible();
      const mobileStanding = host.locator('.duel-standings-mobile-card').first();
      await expect(mobileStanding.getByText('Puntos', { exact: true })).toBeVisible();
      await expect(mobileStanding.getByText('Casos', { exact: true })).toBeVisible();
      await expect(mobileStanding.getByText('Tiempo', { exact: true })).toBeVisible();
      expect(
        await host.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await host.setViewportSize({ width: 1280, height: 720 });

      const hostRivals = host.locator('section').filter({ hasText: 'Tableros y progreso' });
      const rivalRivals = rival.locator('section').filter({ hasText: 'Tableros y progreso' });
      await expect(hostRivals.getByText(rivalGamertag, { exact: true })).toBeVisible();
      await expect(rivalRivals.getByText(hostGamertag, { exact: true })).toBeVisible();
      await expect(hostRivals.getByText('Conectado', { exact: true })).toBeVisible();
      await expect(rivalRivals.getByText('Conectado', { exact: true })).toBeVisible();
      await expect(
        hostRivals.getByText('Código oculto por permisos.', { exact: true }),
      ).toBeVisible();
      await expect(
        rivalRivals.getByText('Código oculto por permisos.', { exact: true }),
      ).toBeVisible();

      const hostSolution =
        'import sys\nvalores = list(map(int, sys.stdin.read().split()))\nprint(sum(valores[1:]))\n';
      await expect(host.getByLabel('Editor de solución Python')).toBeEnabled();
      await host.getByLabel('Editor de solución Python').fill(hostSolution);
      await expect(
        rivalRivals.getByText('Código oculto por permisos.', { exact: true }),
      ).toBeVisible();

      await host.getByRole('button', { name: 'Revelar mi código' }).click();
      const revealedHostCode = rival.getByLabel(`Código de ${hostGamertag}`);
      await expect(revealedHostCode).toBeVisible();
      await expect(revealedHostCode).toContainText('import sys');
      await expect(revealedHostCode).toContainText('sum(valores[1:])');

      await host.getByRole('button', { name: 'Enviar Solución' }).click();

      await expect(host.getByText('Último veredicto: AC', { exact: true })).toBeVisible({
        timeout: 90_000,
      });
      await expect(host.getByRole('heading', { name: 'Resultados finales' })).toBeVisible({
        timeout: 30_000,
      });
      const disabledButtonContrast = await host
        .getByRole('button', { name: 'Partida finalizada' })
        .evaluate((button) => {
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
          const styles = getComputedStyle(button);
          const [lighter, darker] = [
            luminance(styles.color),
            luminance(styles.backgroundColor),
          ].sort((left, right) => right - left);
          return (lighter! + 0.05) / (darker! + 0.05);
        });
      expect(disabledButtonContrast).toBeGreaterThanOrEqual(4.5);
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
