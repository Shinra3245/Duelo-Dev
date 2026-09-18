import { API_BASE_URL } from './api';

/**
 * Cierra una sesión guest al abandonar completamente la página.
 * La navegación interna de Next no dispara pagehide, por lo que no interrumpe
 * el paso de la portada al lobby. El endpoint es tolerante a sesiones expiradas.
 */
export function registerGuestSessionCleanup(): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const handlePageHide = () => {
    const url = `${API_BASE_URL}/auth/logout`;
    const body = new Blob([], { type: 'text/plain' });

    if (typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(url, body);
      return;
    }

    void fetch(url, {
      method: 'POST',
      body,
      credentials: 'include',
      keepalive: true,
    }).catch(() => undefined);
  };

  window.addEventListener('pagehide', handlePageHide);
  return () => window.removeEventListener('pagehide', handlePageHide);
}
