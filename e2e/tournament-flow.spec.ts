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

      await expect(host.getByRole('heading', { name: 'Prepárate para programar' })).toBeVisible();
      await expect(rival.getByRole('heading', { name: 'Prepárate para programar' })).toBeVisible();
      await expect(host.locator('.duel-problem-content')).toBeVisible();
      await expect(rival.locator('.duel-problem-content')).toBeVisible();
      await expect(host.locator('.duel-room-status')).toHaveText('En curso');
      const countdownStart = await host
        .locator('.duel-instructions-countdown strong')
        .textContent();
      expect(countdownStart).toMatch(/^00:([0-2]\d|30)$/);

      await expect(host.getByLabel('Editor de solución Python')).toBeEnabled({ timeout: 45_000 });
      await expect(rival.getByLabel('Editor de solución Python')).toBeEnabled({ timeout: 45_000 });
      const hostBoards = host.locator('.duel-code-board-grid .duel-code-board');
      const rivalBoards = rival.locator('.duel-code-board-grid .duel-code-board');
      await expect(hostBoards).toHaveCount(2);
      await expect(rivalBoards).toHaveCount(2);
      await expect(hostBoards.nth(0).locator('.duel-code-player-name')).toContainText(hostGamertag);
      await expect(hostBoards.nth(1).locator('.duel-code-player-name')).toContainText(
        rivalGamertag,
      );
      await expect(rivalBoards.nth(0).locator('.duel-code-player-name')).toContainText(
        rivalGamertag,
      );
      await expect(rivalBoards.nth(1).locator('.duel-code-player-name')).toContainText(
        hostGamertag,
      );

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

      await host.getByRole('button', { name: 'Abrir el reto' }).click();
      const challengeDialog = host.getByRole('dialog', { name: 'Reto actual' });
      await expect(challengeDialog).toBeVisible();
      const timeBeforeChallenge = await host
        .locator('.duel-toolbar-metric strong')
        .first()
        .textContent();
      await host.waitForTimeout(1_200);
      const timeWhileChallengeOpen = await host
        .locator('.duel-toolbar-metric strong')
        .first()
        .textContent();
      expect(timeWhileChallengeOpen).not.toBe(timeBeforeChallenge);
      await host.getByRole('button', { name: 'Cerrar el reto' }).click();
      await expect(challengeDialog).toBeHidden();

      const hostSolution =
        'import sys\nvalores = list(map(int, sys.stdin.read().split()))\nprint(sum(valores[1:]))\n';
      await expect(host.getByLabel('Editor de solución Python')).toBeEnabled();
      await host.getByLabel('Editor de solución Python').fill(hostSolution);
      const blurredHostCode = rival.locator('.duel-rival-code-board .duel-rival-code');
      await expect(blurredHostCode).toContainText('import sys');
      await expect(blurredHostCode).toHaveClass(/duel-code-blurred/);

      await host.getByRole('button', { name: 'Mostrar mi código' }).click();
      const revealedHostCode = rival.locator('.duel-rival-code-board .duel-rival-code');
      await expect(revealedHostCode).toBeVisible();
      await expect(revealedHostCode).toContainText('import sys');
      await expect(revealedHostCode).toContainText('sum(valores[1:])');
      await expect(revealedHostCode).not.toHaveClass(/duel-code-blurred/);

      await host.getByRole('button', { name: 'Enviar solución' }).click();

      await expect(host.getByText('Último veredicto: AC', { exact: true })).toBeVisible({
        timeout: 90_000,
      });
      await expect(host.getByRole('heading', { name: 'Tabla final' })).toBeVisible({
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
