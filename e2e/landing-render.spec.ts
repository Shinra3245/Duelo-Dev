import { expect, test } from '@playwright/test';

test('la portada permanece visible mientras se verifica la sesión', async ({ page }) => {
  let releaseResponses!: () => void;
  const responsesReleased = new Promise<void>((resolve) => {
    releaseResponses = resolve;
  });
  let heldRequests = 0;

  await page.route('**/api/v1/auth/me', async (route) => {
    heldRequests++;
    await responsesReleased;
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': route.request().headers().origin ?? '*',
        'access-control-allow-credentials': 'true',
      },
      body: JSON.stringify({
        error: { code: 'UNAUTHENTICATED', message: 'Sesión no iniciada' },
      }),
    });
  });

  await page.route('**/api/v1/rooms/policy', async (route) => {
    heldRequests++;
    await responsesReleased;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': route.request().headers().origin ?? '*',
        'access-control-allow-credentials': 'true',
      },
      body: JSON.stringify({ registered_users_can_create_rooms: true }),
    });
  });

  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('status')).toBeVisible();
    await expect(page.locator('#player-access')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByLabel('Gamertag')).toHaveCount(0);
    await expect.poll(() => heldRequests).toBe(2);
  } finally {
    releaseResponses();
  }

  await expect(page.getByLabel('Gamertag')).toBeVisible();
  await expect(page.locator('#player-access')).toHaveAttribute('aria-busy', 'false');
});
