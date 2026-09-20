const MOBILE_USER_AGENT = /android|iphone|ipad|ipod|mobile|windows phone/i;

export function isMobileGameDevice(userAgent: string, platform = '', maxTouchPoints = 0): boolean {
  const iPadInDesktopMode = platform === 'MacIntel' && maxTouchPoints > 1;
  return MOBILE_USER_AGENT.test(userAgent) || iPadInDesktopMode;
}
