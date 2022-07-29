import UserAgents from 'user-agents'
import { parse } from 'useragent'

export default function () {
  return new UserAgents(
    ua =>
      ua.platform === 'Win32' &&
      ua.appName === 'Netscape' &&
      ua.vendor === 'Google Inc.' &&
      ua.deviceCategory === 'desktop' &&
      +parse(ua.userAgent).major > 100
  ).toString()
}
