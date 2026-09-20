import { describe, expect, it } from 'vitest';
import { isMobileGameDevice } from '../src/lib/device-support.js';

describe('compatibilidad del dispositivo para jugar', () => {
  it('rechaza móviles aunque estén en orientación horizontal', () => {
    expect(isMobileGameDevice('Mozilla/5.0 (Linux; Android 15) Mobile')).toBe(true);
  });

  it('permite navegadores de escritorio', () => {
    expect(isMobileGameDevice('Mozilla/5.0 (X11; Linux x86_64)')).toBe(false);
  });

  it('no confunde una laptop Mac con una tableta en modo escritorio', () => {
    expect(isMobileGameDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X)', 'MacIntel', 0)).toBe(
      false,
    );
  });

  it('detecta una tableta Apple aunque solicite sitios en modo escritorio', () => {
    expect(isMobileGameDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X)', 'MacIntel', 5)).toBe(true);
  });
});
