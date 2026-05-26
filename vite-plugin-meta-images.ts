import type { Plugin } from 'vite';

/**
 * Vite plugin that rewrites og:image and twitter:image meta tags to an
 * absolute URL on the current Replit deployment / dev domain, pointing at
 * /api/public/og-image (which streams the canonical OG image from object
 * storage). The image binary lives outside the repo, so the workspace
 * screenshot pipeline cannot dirty it with binary diffs.
 *
 * If no Replit domain is available (e.g. an external build), the static
 * fallback URL already in index.html is left untouched.
 */
export function metaImagesPlugin(): Plugin {
  return {
    name: 'vite-plugin-meta-images',
    transformIndexHtml(html) {
      const baseUrl = getDeploymentUrl();
      if (!baseUrl) {
        return html;
      }

      const imageUrl = `${baseUrl}/api/public/og-image`;

      html = html.replace(
        /<meta\s+property="og:image"\s+content="[^"]*"\s*\/>/g,
        `<meta property="og:image" content="${imageUrl}" />`,
      );

      html = html.replace(
        /<meta\s+name="twitter:image"\s+content="[^"]*"\s*\/>/g,
        `<meta name="twitter:image" content="${imageUrl}" />`,
      );

      return html;
    },
  };
}

function getDeploymentUrl(): string | null {
  if (process.env.REPLIT_INTERNAL_APP_DOMAIN) {
    return `https://${process.env.REPLIT_INTERNAL_APP_DOMAIN}`;
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  }
  return null;
}
