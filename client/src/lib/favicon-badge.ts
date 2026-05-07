let originalHref: string | null = null;
let badgedDataUrl: string | null = null;
let lastBadgedSourceHref: string | null = null;
let isBadged = false;

const FAVICON_ID = "dynamic-favicon";

function getLink(): HTMLLinkElement | null {
  const el = document.getElementById(FAVICON_ID) as HTMLLinkElement | null;
  if (el) return el;
  return document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
}

async function buildBadgedDataUrl(sourceHref: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const size = Math.max(img.width, img.height, 32);
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            resolve(null);
            return;
          }
          ctx.drawImage(img, 0, 0, size, size);
          const r = Math.max(6, Math.round(size * 0.28));
          const cx = size - r - 1;
          const cy = r + 1;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fillStyle = "#ef4444";
          ctx.fill();
          ctx.lineWidth = Math.max(1, Math.round(size * 0.04));
          ctx.strokeStyle = "#ffffff";
          ctx.stroke();
          resolve(canvas.toDataURL("image/png"));
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = sourceHref;
    } catch {
      resolve(null);
    }
  });
}

export async function setFaviconBadge(active: boolean): Promise<void> {
  const link = getLink();
  if (!link) return;

  if (originalHref === null) {
    originalHref = link.getAttribute("href") || "/favicon.png";
  }

  if (!active) {
    if (isBadged && originalHref) {
      link.setAttribute("href", originalHref);
      isBadged = false;
    }
    return;
  }

  if (isBadged) return;

  if (!badgedDataUrl || lastBadgedSourceHref !== originalHref) {
    const built = await buildBadgedDataUrl(originalHref);
    if (!built) return;
    badgedDataUrl = built;
    lastBadgedSourceHref = originalHref;
  }

  link.setAttribute("href", badgedDataUrl);
  isBadged = true;
}
