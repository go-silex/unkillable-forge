import favicon from '../../site/favicon.ico'
import appleTouchIcon from '../../site/apple-touch-icon.png'
import faviconPng from '../../site/images/favicon.png'
import robots from '../../site/robots.txt'
import type { FixedShellAssets } from '../../domains/delivery/shell'

export const unkillableShellAssets: FixedShellAssets = {
  '/favicon.ico': { body: favicon, contentType: 'image/x-icon' },
  '/apple-touch-icon.png': { body: appleTouchIcon, contentType: 'image/png' },
  '/images/favicon.png': { body: faviconPng, contentType: 'image/png' },
  '/robots.txt': { body: robots, contentType: 'text/plain; charset=utf-8' },
}
