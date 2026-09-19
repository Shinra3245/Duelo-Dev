import { expect, test } from '@playwright/test';

test('el acceso mantiene contraste, etiquetas y controles usables en móvil', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Entrar al torneo' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });

  const layout = await page.evaluate(() => {
    const card = document.querySelector('.player-access-card')!;
    const bounds = card.getBoundingClientRect();
    const controls = [...card.querySelectorAll('input, button')].map((control) => {
      const rect = control.getBoundingClientRect();
      return { left: rect.left, right: rect.right, height: rect.height };
    });
    const submit = getComputedStyle(card.querySelector('.player-access-submit')!);
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
    const [lighter, darker] = [luminance(submit.color), luminance(submit.backgroundColor)].sort(
      (left, right) => right - left,
    );
    return {
      fitsViewport: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      controlsFitCard: controls.every(
        (control) =>
          control.left >= bounds.left && control.right <= bounds.right && control.height >= 44,
      ),
      submitContrast: (lighter! + 0.05) / (darker! + 0.05),
    };
  });

  expect(layout.fitsViewport).toBe(true);
  expect(layout.controlsFitCard).toBe(true);
  expect(layout.submitContrast).toBeGreaterThanOrEqual(4.5);
  await expect(page.getByLabel('Correo electrónico')).toBeVisible();
  await expect(page.getByLabel('Gamertag')).toBeVisible();
  await expect(page.getByLabel('Contraseña')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Registrarse' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('button', { name: 'Invitado' }).click();
  await expect(page.getByLabel('Correo electrónico')).toHaveCount(0);
  await expect(page.getByLabel('Contraseña')).toHaveCount(0);
  await expect(page.getByLabel('Gamertag')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invitado', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('un jugador invitado puede entrar y conservar su gamertag', async ({ page }) => {
  const gamertag = `e2e-${Date.now().toString(36).slice(-8)}`;

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Piensa rápido. Programa mejor.' })).toBeVisible();
  await page.getByRole('button', { name: 'Invitado' }).click();
  await page.getByLabel('Gamertag').fill(gamertag);
  await page.getByRole('button', { name: 'Jugar como Invitado' }).click();

  await expect(page.getByText(gamertag, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Crear Sala' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Unirse a sala' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Puntos', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Código de sala' })).toBeVisible();

  await page.getByRole('button', { name: 'Salir' }).click();
  await expect(page.getByRole('button', { name: 'Invitado', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Invitado', exact: true }).click();
  await page.getByLabel('Gamertag').fill(gamertag);
  await page.getByRole('button', { name: 'Jugar como Invitado' }).click();
  await expect(page.getByText(gamertag, { exact: true })).toBeVisible();
});

test('el panel administrativo mantiene el acceso privado', async ({ page }) => {
  await page.goto('/admin');

  await expect(page.getByRole('heading', { name: 'Panel administrativo' })).toBeVisible();
  await expect(page.getByText('Acceso restringido.')).toBeVisible();
  await expect(page.getByLabel('Correo')).toBeVisible();
  await expect(page.getByLabel('Contraseña')).toBeVisible();
});

test('un jugador registrado puede salir y volver a entrar desde la landing', async ({ page }) => {
  const suffix = Date.now().toString(36).slice(-8);
  const email = `e2e-${suffix}@example.test`;
  const gamertag = `reg-${suffix}`;
  const password = `E2e-${suffix}-Password!`;

  await page.goto('/');
  await page.getByRole('button', { name: 'Registrarse', exact: true }).click();
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Gamertag').fill(gamertag);
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Crear cuenta y entrar' }).click();

  await expect(page.getByText(gamertag, { exact: true })).toBeVisible();
  await expect(page.getByText('Cuenta registrada', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Crear Sala' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Puntos', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rondas', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Salir' }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Entrar con mi cuenta' }).click();

  await expect(page.getByText(gamertag, { exact: true })).toBeVisible();
  await expect(page.getByText('Cuenta registrada', { exact: true })).toBeVisible();
});
