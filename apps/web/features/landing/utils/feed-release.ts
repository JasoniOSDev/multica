import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseWithFallback } from "@multica/core/api/schema";
import type { LatestRelease } from "./github-release";
import type { DownloadAssets } from "./parse-release-assets";

/**
 * Self-hosted / internal-network download source.
 *
 * On the public site, `/download` reads GitHub Releases (see
 * github-release.ts). On an internal deploy (devBox) the box can't
 * reach api.github.com, so instead we read the desktop auto-update
 * feed — the SAME `latest-mac.yml` the Electron updater consumes — and
 * point the download buttons at the feed's own files. One source of
 * truth, no second manifest.
 *
 * `latest-mac.yml` (electron-builder) shape:
 *   version: 0.3.16
 *   files:
 *     - url: multica-desktop-0.3.16-mac-arm64.zip
 *       sha512: ...
 *       size: 214226773
 *     - url: multica-desktop-0.3.16-mac-arm64.dmg
 *       ...
 *   path: ...
 *   releaseDate: '2026-06-09T06:29:14.546Z'
 *
 * `url` is a filename relative to the feed directory; the download URL
 * is `${DESKTOP_FEED_URL}${url}`. The feed only carries the mac arm64
 * artifacts today, so other platforms render as "unavailable" rather
 * than erroring (the shared UI already degrades empty asset slots).
 *
 * Per CLAUDE.md "API Response Compatibility": the YAML is parsed with a
 * zod schema through `parseWithFallback`, so a malformed or
 * field-missing feed degrades to a "version unavailable" view instead
 * of throwing into the page.
 */

const REVALIDATE_SECONDS = 300;

const FEED_MANIFEST_FILE = "latest-mac.yml";

const FeedFileSchema = z.object({
  url: z.string(),
});

const FeedManifestSchema = z.object({
  version: z.string(),
  files: z.array(FeedFileSchema),
  releaseDate: z.string().optional(),
});

type FeedManifest = z.infer<typeof FeedManifestSchema>;

/**
 * Reads the configured internal feed base URL, or null when not set.
 * When null, the page keeps the public GitHub Releases behavior.
 *
 * The trailing slash is normalized on so `new URL(file, base)` resolves
 * against the feed directory rather than dropping its last segment.
 */
export function getDesktopFeedUrl(): string | null {
  const raw = process.env.DESKTOP_FEED_URL?.trim();
  if (!raw) return null;
  return raw.endsWith("/") ? raw : `${raw}/`;
}

/** The href used for "all releases" links when running in feed mode —
 *  the feed directory itself, never the external GitHub page. */
export function feedReleasesHref(feedBaseUrl: string): string {
  return feedBaseUrl;
}

export async function fetchFeedRelease(
  feedBaseUrl: string,
): Promise<LatestRelease> {
  const manifestUrl = new URL(FEED_MANIFEST_FILE, feedBaseUrl).toString();
  try {
    const res = await fetch(manifestUrl, {
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!res.ok) {
      throw new Error(`desktop feed responded ${res.status}`);
    }
    const text = await res.text();

    // YAML parse itself can throw on a syntactically broken document;
    // null-out so parseWithFallback handles it as a contract failure.
    let doc: unknown = null;
    try {
      doc = parseYaml(text);
    } catch (parseErr) {
      console.warn("[download] feed YAML parse failed:", parseErr);
      doc = null;
    }

    const manifest = parseWithFallback<FeedManifest | null>(
      doc,
      FeedManifestSchema,
      null,
      { endpoint: "desktop-feed/latest-mac.yml" },
    );
    if (!manifest) {
      return emptyFeedRelease();
    }

    return {
      version: manifest.version,
      publishedAt: manifest.releaseDate ?? null,
      // No release-notes page on the internal feed.
      htmlUrl: null,
      assets: mapFeedAssets(feedBaseUrl, manifest.files),
    };
  } catch (err) {
    console.warn("[download] fetchFeedRelease failed:", err);
    return emptyFeedRelease();
  }
}

/**
 * Maps feed file entries to the shared DownloadAssets map. The feed
 * ships mac arm64 only, so we resolve the dmg/zip slots and leave every
 * other platform empty (rendered as "unavailable" downstream).
 */
function mapFeedAssets(
  feedBaseUrl: string,
  files: FeedManifest["files"],
): DownloadAssets {
  const out: DownloadAssets = {};
  for (const file of files) {
    const lower = file.url.toLowerCase();
    const href = new URL(file.url, feedBaseUrl).toString();
    if (lower.endsWith(".dmg")) {
      out.macArm64Dmg = href;
    } else if (lower.endsWith(".zip")) {
      out.macArm64Zip = href;
    }
  }
  return out;
}

function emptyFeedRelease(): LatestRelease {
  return {
    version: null,
    publishedAt: null,
    htmlUrl: null,
    assets: {},
  };
}
