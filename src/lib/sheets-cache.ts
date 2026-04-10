const CACHE_VERSION = "v3";

function cacheKey(email: string): string {
  return `orderhub_engineers_${CACHE_VERSION}_${email}`;
}

interface CacheData {
  engineers: unknown[];
  cachedAt: string;
  loadedMonths?: string[];
}

export function loadCache(email: string): CacheData | null {
  try {
    const raw = localStorage.getItem(cacheKey(email));
    if (!raw) return null;
    return JSON.parse(raw) as CacheData;
  } catch {
    return null;
  }
}

export function saveCache(email: string, engineers: unknown[], loadedMonths?: string[]): void {
  const data: CacheData = { engineers, cachedAt: new Date().toISOString(), loadedMonths };
  localStorage.setItem(cacheKey(email), JSON.stringify(data));
}

export function clearCache(email: string): void {
  localStorage.removeItem(cacheKey(email));
}

export function formatCachedAt(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}
