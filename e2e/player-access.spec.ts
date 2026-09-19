import { expect, test } from '@playwright/test';

test('un jugador invitado puede entrar y conservar su gamertag', async ({ page }) => {
  const gamertag = `e2e-${Date.now().toString(36).slice(-8)}`;

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Piensa rápido. Programa mejor.' })).toBeVisible();
  await page.getByRole('button', { name: 'Invitado' }).click();
  await page.getByLabel('Gamertag').fill(gamertag);
  await page.getByRole('button', { name: 'Jugar como Invitado' }).click();

  await expect(page.getByText(gamertag, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Crear Sala' })).toBeVisible();
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

  await page.getByRole('button', { name: 'Salir' }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Entrar con mi cuenta' }).click();

  await expect(page.getByText(gamertag, { exact: true })).toBeVisible();
  await expect(page.getByText('Cuenta registrada', { exact: true })).toBeVisible();
});
