export type BrowserLocation = Pick<Location, 'hostname' | 'protocol'>;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function alignLoopbackServiceHost(
  configuredUrl: string,
  browserLocation: BrowserLocation,
  browserProtocol: string,
): string {
  const parsed = new URL(configuredUrl);
  const configuredHost = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const browserHost = browserLocation.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (!LOOPBACK_HOSTS.has(configuredHost) || configuredHost === browserHost) {
    return configuredUrl;
  }

  parsed.hostname = browserLocation.hostname;
  parsed.protocol = browserProtocol;
  return parsed.toString();
}
