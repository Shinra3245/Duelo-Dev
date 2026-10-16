import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  LANGUAGES,
  LANGUAGE_LABELS,
  type Language,
  type MatchSummaryResponse,
  type ProblemPublicResponse,
  type RoomCreatedResponse,
} from '@duelodev/shared';
import { PILOT_PROBLEMS } from '../api/src/seeds/pilot-problems';
import { deterministicProblemId } from '../api/src/seeds/seeder';
import { editorLabel } from '../web/src/lib/code-language';

const tournamentEnabled =
  process.env.E2E_TOURNAMENT === '1' && process.env.E2E_DISPOSABLE_STACK === '1';

test.describe('flujo de torneo en navegador', () => {
  test.skip(
    !tournamentEnabled,
    'Requiere E2E_TOURNAMENT=1, E2E_DISPOSABLE_STACK=1, DB/Redis y worker aislados',
  );
  test.setTimeout(180_000);

  for (const language of LANGUAGES) {
    test(`dos jugadores completan ${language} del lobby a AC y resumen durable`, async ({
      browser,
    }) => {
      const hostContext = await browser.newContext();
      const rivalContext = await browser.newContext();
      const host = await hostContext.newPage();
      const rival = await rivalContext.newPage();
      const hostGamertag = `host-${Date.now().toString(36).slice(-7)}`;
      const rivalGamertag = `rival-${Date.now().toString(36).slice(-7)}`;

      try {
        await enterAsRegistered(host, hostGamertag);
        await host.getByLabel('Lenguaje de la sala').selectOption(language);
        const createResponse = host.waitForResponse(
          (response) =>
            response.url().endsWith('/api/v1/rooms') && response.request().method() === 'POST',
        );
        await host.getByRole('button', { name: 'Puntos' }).click();
        const room = (await (await createResponse).json()) as RoomCreatedResponse;
        await expect(host.getByRole('heading', { name: 'Lobby' })).toBeVisible();

        const roomCode = (await host.locator('header h1').textContent())?.trim();
        expect(roomCode).toMatch(/^[A-Z0-9]{6}$/);

        await enterAsGuest(rival, rivalGamertag);
        await rival.getByLabel('Código de sala').fill(roomCode!);
        await rival.getByRole('button', { name: 'Unirse' }).click();
        await expect(rival.getByRole('heading', { name: 'Lobby' })).toBeVisible();
        await expect(host.getByText(rivalGamertag, { exact: true })).toBeVisible();
        await expect(rival.getByText(hostGamertag, { exact: true })).toBeVisible();
        await expect(host.locator('.duel-room-language')).toHaveText(LANGUAGE_LABELS[language]);
        await expect(rival.locator('.duel-room-language')).toHaveText(LANGUAGE_LABELS[language]);

        await host.getByRole('button', { name: 'Marcar como listo' }).click();
        await rival.getByRole('button', { name: 'Marcar como listo' }).click();
        await expect(host.getByText('Listo', { exact: true }).first()).toBeVisible();
        const problemResponse = host.waitForResponse(
          (response) => /\/api\/v1\/problems\/[^/]+\/public$/.test(response.url()) && response.ok(),
        );
        await host.getByRole('button', { name: 'Empezar partida' }).click();

        await expect(host.getByRole('heading', { name: 'Prepárate para programar' })).toBeVisible();
        await expect(
          rival.getByRole('heading', { name: 'Prepárate para programar' }),
        ).toBeVisible();
        await expect(host.locator('.duel-problem-content')).toBeVisible();
        await expect(rival.locator('.duel-problem-content')).toBeVisible();
        await expect(host.locator('.duel-room-status')).toHaveText('En curso');
        const countdownStart = await host
          .locator('.duel-instructions-countdown strong')
          .textContent();
        expect(countdownStart).toMatch(/^00:([0-2]\d|30)$/);
        const problem = (await (await problemResponse).json()) as ProblemPublicResponse;
        const definition = PILOT_PROBLEMS.find(
          (seed) => deterministicProblemId(seed.slug, seed.version) === problem.problem_id,
        );
        expect(definition, 'El reto real debe tener una referencia versionada').toBeDefined();
        const hostSolution = referenceSolution(language, definition!.slug);

        await expect(host.getByLabel(editorLabel(language))).toBeEnabled({ timeout: 45_000 });
        await expect(rival.getByLabel(editorLabel(language))).toBeEnabled({ timeout: 45_000 });
        const hostBoards = host.locator('.duel-code-board-grid .duel-code-board');
        const rivalBoards = rival.locator('.duel-code-board-grid .duel-code-board');
        await expect(hostBoards).toHaveCount(2);
        await expect(rivalBoards).toHaveCount(2);
        await expect(hostBoards.nth(0).locator('.duel-code-player-name')).toContainText(
          hostGamertag,
        );
        await expect(hostBoards.nth(1).locator('.duel-code-player-name')).toContainText(
          rivalGamertag,
        );
        await expect(rivalBoards.nth(0).locator('.duel-code-player-name')).toContainText(
          rivalGamertag,
        );
        await expect(rivalBoards.nth(1).locator('.duel-code-player-name')).toContainText(
          hostGamertag,
        );

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

        await expect(host.getByLabel(editorLabel(language))).toBeEnabled();
        await host.getByLabel(editorLabel(language)).fill(hostSolution);
        const blurredHostCode = rival.locator('.duel-rival-code-board .duel-rival-code');
        await expect(blurredHostCode).toContainText('Código no compartido');
        await expect(blurredHostCode).not.toContainText(hostSolution);
        await expect(blurredHostCode).toHaveClass(/duel-code-blurred/);

        await host.getByRole('button', { name: 'Mostrar mi código' }).click();
        const revealedHostCode = rival.locator('.duel-rival-code-board .duel-rival-code');
        await expect(revealedHostCode).toBeVisible();
        await expect(revealedHostCode).toContainText(hostSolution);
        await expect(revealedHostCode).not.toHaveClass(/duel-code-blurred/);

        const summaryResponse = host.waitForResponse(
          (response) =>
            response.url().endsWith(`/api/v1/matches/${room.match_id}/summary`) && response.ok(),
          { timeout: 120_000 },
        );
        await host.getByRole('button', { name: 'Enviar solución' }).click();

        await expect(host.getByText('Último veredicto: AC', { exact: true })).toBeVisible({
          timeout: 90_000,
        });
        await expect(host.getByRole('heading', { name: 'Tabla final' })).toBeVisible({
          timeout: 30_000,
        });
        const summary = (await (await summaryResponse).json()) as MatchSummaryResponse;
        expect(summary.status).toBe('finished');
        expect(
          summary.snapshots.some(
            (snapshot) => snapshot.language === language && snapshot.source_code === hostSolution,
          ),
        ).toBe(true);
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
  }
});

function referenceSolution(language: Language, slug: string): string {
  const filenames = { python: 'solution.py', cpp: 'main.cpp', java: 'Main.java' };
  const template = readFileSync(
    new URL(`../problems/reference-solutions/${filenames[language]}`, import.meta.url),
    'utf8',
  );
  const source = template.replace('__PROBLEM_SLUG__', slug);
  return language === 'cpp' ? `#define REF_${slug.replaceAll('-', '_')} 1\n${source}` : source;
}

async function enterAsGuest(page: Page, gamertag: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Invitado', exact: true }).click();
  await page.getByLabel('Gamertag').fill(gamertag);
  await page.getByRole('button', { name: 'Jugar como Invitado' }).click();
  await expect(page.getByText(gamertag, { exact: true })).toBeVisible();
}

async function enterAsRegistered(page: Page, gamertag: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Registrarse', exact: true }).click();
  await page.getByLabel('Correo electrónico').fill(`${gamertag}@example.test`);
  await page.getByLabel('Gamertag').fill(gamertag);
  await page.getByLabel('Contraseña').fill(`E2E-${gamertag}-Only-2026!`);
  await page.getByRole('button', { name: 'Crear cuenta y entrar' }).click();
  await expect(page.getByText(gamertag, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Puntos', exact: true })).toBeVisible();
}
