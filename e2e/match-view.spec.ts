import { expect, test, type Page } from '@playwright/test';

const adminEmail = process.env.E2E_ADMIN_EMAIL;
const adminPassword = process.env.E2E_ADMIN_PASSWORD;
const gameViewEnabled = process.env.E2E_GAME_VIEW === '1';

test.describe('vista de partida sincronizada', () => {
  test.skip(
    !gameViewEnabled || !adminEmail || !adminPassword,
    'Requiere E2E_GAME_VIEW=1, credenciales admin válidas y una base de pruebas aislada',
  );
  test.setTimeout(90_000);

  test('sincroniza instrucciones, tableros relativos al jugador y código rival desenfocado', async ({
    browser,
  }) => {
    const hostContext = await browser.newContext();
    const rivalContext = await browser.newContext();
    const thirdContext = await browser.newContext();
    const host = await hostContext.newPage();
    const rival = await rivalContext.newPage();
    const third = await thirdContext.newPage();
    const suffix = Date.now().toString(36).slice(-7);
    const rivalGamertag = `rival-${suffix}`;
    const thirdGamertag = `third-${suffix}`;

    try {
      await host.goto('/admin');
      await host.getByLabel('Correo').fill(adminEmail!);
      await host.getByLabel('Contraseña').fill(adminPassword!);
      await host.getByRole('button', { name: 'Entrar al panel' }).click();
      await expect(host.locator('.admin-layout')).toBeVisible();

      await host.getByLabel('Jugadores').selectOption('3');
      const createResponse = host.waitForResponse(
        (response) =>
          response.url().endsWith('/api/v1/admin/rooms/create') &&
          response.request().method() === 'POST',
      );
      await host.getByRole('button', { name: 'Crear sala' }).click();
      const room = (await (await createResponse).json()) as { room_code: string };
      await host.goto(`/room/${room.room_code}`);
      await expect(host.getByRole('heading', { name: 'Lobby' })).toBeVisible();

      await enterAndJoin(rival, rivalGamertag, room.room_code);
      await enterAndJoin(third, thirdGamertag, room.room_code);
      await expect(host.getByText(rivalGamertag, { exact: true })).toBeVisible();
      await expect(host.getByText(thirdGamertag, { exact: true })).toBeVisible();

      await host.getByRole('button', { name: 'Marcar como listo' }).click();
      await rival.getByRole('button', { name: 'Marcar como listo' }).click();
      await third.getByRole('button', { name: 'Marcar como listo' }).click();
      await host.getByRole('button', { name: 'Empezar partida' }).click();

      const instructionHeading = { name: 'Prepárate para programar' };
      await expect(host.getByRole('heading', instructionHeading)).toBeVisible();
      await expect(rival.getByRole('heading', instructionHeading)).toBeVisible();
      await expect(third.getByRole('heading', instructionHeading)).toBeVisible();
      const sharedProblemTitles = await Promise.all(
        [host, rival, third].map((page) => page.locator('.duel-problem-content h3').textContent()),
      );
      expect(new Set(sharedProblemTitles).size).toBe(1);
      const sharedDifficulties = await Promise.all(
        [host, rival, third].map((page) => page.locator('.duel-problem-category').textContent()),
      );
      expect(new Set(sharedDifficulties).size).toBe(1);
      expect(sharedDifficulties[0]).toMatch(/^Dificultad: (Inicial|Fácil|Medio)$/);
      const instructionPanel = await host.locator('.duel-instructions-card').evaluate((card) => {
        const problem = card.querySelector('.duel-problem-content');
        return {
          viewportHeight: window.innerHeight,
          cardTop: card.getBoundingClientRect().top,
          cardBottom: card.getBoundingClientRect().bottom,
          contentHeight: card.scrollHeight,
          visibleHeight: card.clientHeight,
          problemContentHeight: problem?.scrollHeight ?? 0,
          problemVisibleHeight: problem?.clientHeight ?? 0,
        };
      });
      expect(instructionPanel.cardTop).toBeGreaterThanOrEqual(0);
      expect(instructionPanel.cardBottom).toBeLessThanOrEqual(instructionPanel.viewportHeight);
      expect(instructionPanel.contentHeight).toBeLessThanOrEqual(instructionPanel.visibleHeight);
      expect(instructionPanel.problemContentHeight).toBeLessThanOrEqual(
        instructionPanel.problemVisibleHeight,
      );

      const countdownValues = await Promise.all(
        [host, rival, third].map(async (page) =>
          Number(
            (await page.locator('.duel-instructions-countdown strong').textContent())?.slice(3),
          ),
        ),
      );
      expect(countdownValues.every((value) => value > 0 && value <= 30)).toBe(true);
      expect(Math.max(...countdownValues) - Math.min(...countdownValues)).toBeLessThanOrEqual(1);

      await Promise.all(
        [host, rival, third].map((page) =>
          expect(page.getByLabel('Editor de solución Python')).toBeEnabled({ timeout: 42_000 }),
        ),
      );

      const hostEditor = host.getByLabel('Editor de solución Python');
      await hostEditor.focus();
      await hostEditor.press('(');
      await expect(hostEditor).toHaveValue('()');
      await hostEditor.press('x');
      await expect(hostEditor).toHaveValue('(x)');
      await hostEditor.press('Control+A');
      await hostEditor.press('[');
      await expect(hostEditor).toHaveValue('[(x)]');
      await hostEditor.press('Control+V');
      await expect(hostEditor).toHaveValue('[(x)]');
      const blockedEditorEvents = await hostEditor.evaluate((editor) =>
        ['copy', 'cut', 'paste', 'contextmenu', 'dragover', 'drop'].map((type) => {
          const event =
            type.startsWith('drag') || type === 'drop'
              ? new DragEvent(type, { bubbles: true, cancelable: true })
              : type === 'contextmenu'
                ? new MouseEvent(type, { bubbles: true, cancelable: true })
                : new ClipboardEvent(type, { bubbles: true, cancelable: true });
          return editor.dispatchEvent(event);
        }),
      );
      expect(blockedEditorEvents).toEqual([false, false, false, false, false, false]);

      const hostBoards = host.locator('.duel-code-board-grid .duel-code-board');
      const rivalBoards = rival.locator('.duel-code-board-grid .duel-code-board');
      const thirdBoards = third.locator('.duel-code-board-grid .duel-code-board');
      await expect(hostBoards).toHaveCount(3);
      await expect(rivalBoards).toHaveCount(3);
      await expect(thirdBoards).toHaveCount(3);
      await expect(rivalBoards.nth(0).locator('.duel-code-player-name')).toContainText(
        rivalGamertag,
      );
      await expect(thirdBoards.nth(0).locator('.duel-code-player-name')).toContainText(
        thirdGamertag,
      );

      const desktopLayout = await host.evaluate(() => ({
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        boards: [...document.querySelectorAll('.duel-code-board-grid .duel-code-board')].map(
          (board) => {
            const { left, right, top, bottom, width } = board.getBoundingClientRect();
            return { left, right, top, bottom, width };
          },
        ),
      }));
      expect(desktopLayout.boards[0]!.left < desktopLayout.boards[1]!.left).toBe(true);
      expect(desktopLayout.boards[1]!.left < desktopLayout.boards[2]!.left).toBe(true);
      expect(desktopLayout.boards[2]!.width).toBeLessThan(desktopLayout.boards[0]!.width);
      expect(
        desktopLayout.boards.every((board) => board.right <= desktopLayout.viewportWidth),
      ).toBe(true);
      expect(desktopLayout.boards.every((board) => board.top >= 0)).toBe(true);
      expect(
        desktopLayout.boards.every((board) => board.bottom <= desktopLayout.viewportHeight),
      ).toBe(true);

      const fixedGameViewport = await host.evaluate(() => ({
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        locked: document.documentElement.classList.contains('duel-game-viewport'),
      }));
      expect(fixedGameViewport.locked).toBe(true);
      expect(fixedGameViewport.documentWidth).toBeLessThanOrEqual(fixedGameViewport.viewportWidth);
      expect(fixedGameViewport.documentHeight).toBeLessThanOrEqual(
        fixedGameViewport.viewportHeight,
      );
      expect(
        await host.evaluate(() => {
          const unload = new Event('beforeunload', { cancelable: true });
          return !window.dispatchEvent(unload);
        }),
      ).toBe(true);

      await host.getByRole('button', { name: 'Abrir el reto' }).click();
      const challenge = host.getByRole('dialog', { name: 'Reto actual' });
      await expect(challenge).toBeVisible();
      const clockBefore = await host.locator('.duel-toolbar-metric strong').first().textContent();
      await host.waitForTimeout(1_200);
      const clockAfter = await host.locator('.duel-toolbar-metric strong').first().textContent();
      expect(clockAfter).not.toBe(clockBefore);
      await host.getByRole('button', { name: 'Cerrar el reto' }).click();

      const liveCode = `print('live-${suffix}')`;
      await rival.getByLabel('Editor de solución Python').fill(liveCode);
      const blurredCodeOnThird = thirdBoards
        .filter({ hasText: rivalGamertag })
        .locator('.duel-rival-code');
      await expect(blurredCodeOnThird).toContainText(liveCode);
      await expect(blurredCodeOnThird).toHaveClass(/duel-code-blurred/);

      await rival.getByRole('button', { name: 'Mostrar mi código' }).click();
      await expect(blurredCodeOnThird).not.toHaveClass(/duel-code-blurred/);

      await third.setViewportSize({ width: 390, height: 844 });
      await third.evaluate(() =>
        Object.defineProperty(navigator, 'userAgent', {
          configurable: true,
          get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile',
        }),
      );
      await third.evaluate(() => window.dispatchEvent(new Event('resize')));
      await expect(
        third.getByRole('heading', { name: 'Esta partida requiere una computadora' }),
      ).toBeVisible();
      await expect(
        third.getByText(/abre esta sala desde una computadora de escritorio o laptop/i),
      ).toBeVisible();
      expect(
        await third.evaluate(() =>
          document.documentElement.classList.contains('duel-game-viewport'),
        ),
      ).toBe(false);
    } finally {
      await thirdContext.close();
      await rivalContext.close();
      await hostContext.close();
    }
  });
});

async function enterAndJoin(page: Page, gamertag: string, roomCode: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Invitado', exact: true }).click();
  await page.getByLabel('Gamertag').fill(gamertag);
  await page.getByRole('button', { name: 'Jugar como Invitado' }).click();
  await page.getByLabel('Código de sala').fill(roomCode);
  await page.getByRole('button', { name: 'Unirse' }).click();
  await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
}
