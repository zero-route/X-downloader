import { proxyPath } from "@/lib/sign";

const DEFAULT_HOST = "best-twitter-scraper-free-1000-calls.p.rapidapi.com";

type Json = Record<string, unknown>;

export type Target = { id: string; username: string | null };

export type Quality = {
  label: string;
  height: number;
  bitrate: number | null;
  approxBytes: number | null;
  src: string;
  download: string;
};

export type Item = {
  type: "video" | "photo";
  gif: boolean;
  src: string;
  download: string;
  direct: string | null;
  thumb: string | null;
  thumbDirect: string | null;
  qualities: Quality[];
  durationMs: number | null;
  width: number | null;
  height: number | null;
};

export type XData = {
  id: string;
  url: string;
  profileUrl: string | null;
  mediaType: "video" | "photo" | "mixed";
  text: string | null;
  timestamp: number | null;
  edited: boolean;
  sensitive: boolean;
  author: {
    username: string | null;
    name: string | null;
    verified: boolean;
    followers: number | null;
    avatar: string | null;
    avatarDirect: string | null;
  };
  stats: {
    likes: number | null;
    retweets: number | null;
    replies: number | null;
    quotes: number | null;
    bookmarks: number | null;
    views: number | null;
  };
  items: Item[];
};

export class ProviderError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function obj(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (
    typeof value === "string" &&
    value.trim() !== "" &&
    Number.isFinite(Number(value))
  ) {
    return Number(value);
  }

  return null;
}

function httpUrl(value: unknown): string | null {
  const text = str(value);

  return text && /^https?:\/\//i.test(text) ? text : null;
}

export function parseTarget(raw: string): Target | null {
  const value = raw.trim();

  if (!value) return null;

  let parsed: URL;

  try {
    parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase().replace(/^(www|mobile|m)\./, "");

  if (host !== "x.com" && host !== "twitter.com") return null;

  const parts = parsed.pathname.split("/").filter(Boolean);

  const index = parts.findIndex(
    (part) => part === "status" || part === "statuses"
  );

  if (index === -1) return null;

  const id = parts[index + 1] ?? "";

  if (!/^\d{5,25}$/.test(id)) return null;

  const before = parts[index - 1] ?? "";

  const username =
    index >= 1 && !["i", "web"].includes(before) && /^\w{1,30}$/.test(before)
      ? before
      : null;

  return { id, username };
}

function getHost() {
  return process.env.RAPIDAPI_HOST?.trim() || DEFAULT_HOST;
}

async function callProvider(
  tweetUrl: string
): Promise<{ json: Json | null; status: number | null }> {
  const key = process.env.RAPIDAPI_KEY;

  if (!key) {
    throw new ProviderError(
      "RAPIDAPI_KEY belum dikonfigurasi di environment Vercel.",
      500
    );
  }

  const host = getHost();

  const endpoint = `https://${host}/tweets/details?tweet=${encodeURIComponent(
    tweetUrl
  )}`;

  const startedAt = Date.now();
  const deadline = 48_000;
  let status: number | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const remaining = deadline - (Date.now() - startedAt);

    if (remaining < 4000) break;

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        cache: "no-store",
        headers: {
          "X-Rapidapi-Key": key,
          "X-Rapidapi-Host": host,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(Math.min(24_000, remaining)),
      });

      status = response.status;

      const text = await response.text();

      let body: Json | null = null;

      try {
        body = obj(JSON.parse(text));
      } catch {
        body = null;
      }

      const valid = response.ok && body !== null && extractTweet(body) !== null;

      console.log(
        `[x] attempt=${attempt} http=${response.status} valid=${valid}${
          valid ? "" : ` body=${text.slice(0, 200).replace(/\s+/g, " ")}`
        }`
      );

      if (valid) return { json: body, status };

      if ([400, 401, 403, 404, 422].includes(response.status)) break;
    } catch (error) {
      status = null;

      console.log(
        `[x] attempt=${attempt} error=${
          error instanceof Error ? error.message : "unknown"
        }`
      );
    }

    if (attempt < 3) await sleep(1000 * attempt);
  }

  return { json: null, status };
}

function extractTweet(body: Json): Json | null {
  const direct = obj(body.tweet);

  if (direct && str(direct.id)) return direct;

  const nested = obj(obj(body.data)?.tweet);

  if (nested && str(nested.id)) return nested;

  return str(body.id) && "stats" in body ? body : null;
}

function originalPhoto(url: string): string {
  try {
    const parsed = new URL(url);

    if (parsed.hostname !== "pbs.twimg.com" || !parsed.pathname.startsWith("/media/")) {
      return url;
    }

    const match = parsed.pathname.match(/^(.*?)(?:\.([a-z0-9]+))?$/i);
    const base = match?.[1] ?? parsed.pathname;
    const format =
      match?.[2]?.toLowerCase() || parsed.searchParams.get("format") || "jpg";

    return `https://pbs.twimg.com${base}?format=${format}&name=orig`;
  } catch {
    return url;
  }
}

function pickPhotoUrl(media: Json): string | null {
  for (const key of ["image", "url", "media_url_https", "media_url", "src"]) {
    const found = httpUrl(media[key]);

    if (found) return found;
  }

  const link = httpUrl(media.link);

  return link && /twimg\.com/.test(link) ? link : null;
}

function sizeFromUrl(url: string): { width: number; height: number } | null {
  const match = url.match(/\/(\d{2,5})x(\d{2,5})\//);

  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

function buildQualities(
  media: Json,
  durationMs: number | null,
  baseName: string
): Quality[] {
  const found = new Map<string, Quality>();

  for (const entry of arr(media.video_variants)) {
    const variant = obj(entry);
    const link = httpUrl(variant?.link);
    const type = str(variant?.content_type) ?? "";

    if (!variant || !link) continue;

    if (type && !/mp4/i.test(type)) continue;

    if (!type && !/\.mp4(\?|$)/i.test(link)) continue;

    const size = sizeFromUrl(link);
    const height = size ? Math.min(size.width, size.height) : 0;
    const bitrate = num(variant.bitrate);
    const label = height > 0 ? `${height}p` : "Asli";

    const current = found.get(label);

    if (current && (current.bitrate ?? 0) >= (bitrate ?? 0)) continue;

    found.set(label, {
      label,
      height,
      bitrate,
      approxBytes:
        bitrate !== null && durationMs !== null
          ? Math.round((bitrate * durationMs) / 8000)
          : null,
      src: proxyPath(link),
      download: proxyPath(link, {
        name: `${baseName}_${label}`,
        download: true,
      }),
    });
  }

  const list = [...found.values()].sort(
    (a, b) => b.height - a.height || (b.bitrate ?? 0) - (a.bitrate ?? 0)
  );

  if (list.length === 0) {
    const fallback = httpUrl(media.video_link);

    if (fallback) {
      list.push({
        label: "Asli",
        height: 0,
        bitrate: null,
        approxBytes: null,
        src: proxyPath(fallback),
        download: proxyPath(fallback, { name: baseName, download: true }),
      });
    }
  }

  return list;
}

function buildItems(mediaList: unknown[], baseName: string): Item[] {
  const items: Item[] = [];

  mediaList.forEach((entry, index) => {
    const media = obj(entry);

    if (!media) return;

    const type = (str(media.type) ?? "").toLowerCase();
    const name = `${baseName}_${index + 1}`;
    const thumbDirect = httpUrl(media.image);
    const width = num(media.width);
    const height = num(media.height);

    if (type === "photo" || type === "image") {
      const display = pickPhotoUrl(media);

      if (!display) return;

      items.push({
        type: "photo",
        gif: false,
        src: proxyPath(display),
        download: proxyPath(originalPhoto(display), {
          name,
          download: true,
        }),
        direct: display,
        thumb: null,
        thumbDirect: null,
        qualities: [],
        durationMs: null,
        width,
        height,
      });

      return;
    }

    if (type === "video" || type.includes("gif")) {
      const durationMs = num(media.duration_ms);
      const qualities = buildQualities(media, durationMs, name);

      if (qualities.length === 0) return;

      const preview =
        qualities.find((quality) => quality.height > 0 && quality.height <= 720) ??
        qualities[qualities.length - 1];

      items.push({
        type: "video",
        gif: type.includes("gif"),
        src: preview.src,
        download: qualities[0].download,
        direct: null,
        thumb: thumbDirect ? proxyPath(thumbDirect) : null,
        thumbDirect,
        qualities,
        durationMs,
        width,
        height,
      });
    }
  });

  return items;
}

function stat(stats: Json | null, key: string) {
  const value = num(stats?.[key]);

  return value !== null && value >= 0 ? value : null;
}

export async function fetchTweet(target: Target): Promise<XData> {
  const tweetUrl = `https://x.com/${target.username ?? "i"}/status/${target.id}`;

  const { json, status } = await callProvider(tweetUrl);

  if (!json) {
    if (status === 401 || status === 403) {
      throw new ProviderError(
        "Akses ke penyedia API ditolak. Periksa RAPIDAPI_KEY dan langganan ke API tweet.",
        502
      );
    }

    if (status === 429) {
      throw new ProviderError(
        "Kuota API sedang habis atau terlalu banyak permintaan. Coba lagi beberapa saat.",
        429
      );
    }

    if (status === 404 || status === 422 || status === 400) {
      throw new ProviderError(
        "Tweet tidak ditemukan. Pastikan tautan benar dan akunnya tidak privat.",
        404
      );
    }

    throw new ProviderError(
      "Gagal mengambil data tweet. Coba lagi beberapa saat.",
      502
    );
  }

  const tweet = extractTweet(json) as Json;

  const retweeted = tweet.is_retweet === true ? obj(tweet.retweeted_tweet) : null;
  const base = retweeted && str(retweeted.id) ? retweeted : tweet;

  const author = obj(base.author);
  const username = str(author?.username) ?? target.username;
  const baseName = `${username ?? "x"}_${str(base.id) ?? target.id}`;

  let mediaList = arr(base.media);

  if (mediaList.length === 0) {
    const quoted = obj(base.quoted_tweet);

    if (quoted) mediaList = arr(quoted.media);
  }

  const items = buildItems(mediaList, baseName);

  if (items.length === 0) {
    throw new ProviderError(
      "Tweet ini tidak berisi video atau foto yang bisa diunduh.",
      422
    );
  }

  const types = new Set(items.map((item) => item.type));

  const avatar = httpUrl(author?.profile_image);
  const stats = obj(base.stats);
  const created = str(base.created_at);
  const parsedDate = created ? Date.parse(created) : NaN;

  return {
    id: str(base.id) ?? target.id,
    url: str(base.link) ?? tweetUrl,
    profileUrl: username ? `https://x.com/${username}` : null,
    mediaType: types.size > 1 ? "mixed" : items[0].type,
    text: str(base.text),
    timestamp: Number.isFinite(parsedDate) ? Math.floor(parsedDate / 1000) : null,
    edited: base.is_edited === true,
    sensitive: base.is_possibly_sensitive === true,
    author: {
      username,
      name: str(author?.name),
      verified: author?.is_blue_verified === true || author?.is_verified === true,
      followers: num(author?.followers_count),
      avatar: avatar ? proxyPath(avatar) : null,
      avatarDirect: avatar,
    },
    stats: {
      likes: stat(stats, "likes"),
      retweets: stat(stats, "retweets"),
      replies: stat(stats, "replies"),
      quotes: stat(stats, "quotes"),
      bookmarks: stat(stats, "bookmarks"),
      views: stat(stats, "views"),
    },
    items,
  };
}
