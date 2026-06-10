import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFeedRelease, getDesktopFeedUrl } from "./feed-release";

const FEED_BASE = "http://10.37.16.72:18082/desktop/";

const VALID_FEED_YML = `version: 0.3.16
files:
  - url: multica-desktop-0.3.16-mac-arm64.zip
    sha512: abc==
    size: 214226773
  - url: multica-desktop-0.3.16-mac-arm64.dmg
    sha512: def==
    size: 224275504
path: multica-desktop-0.3.16-mac-arm64.zip
sha512: abc==
releaseDate: '2026-06-09T06:29:14.546Z'
`;

function mockFeedResponse(body: string, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(body, {
      status,
      headers: { "Content-Type": "text/yaml" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("getDesktopFeedUrl", () => {
  it("returns null when DESKTOP_FEED_URL is unset", () => {
    vi.stubEnv("DESKTOP_FEED_URL", "");
    expect(getDesktopFeedUrl()).toBeNull();
  });

  it("normalizes a missing trailing slash", () => {
    vi.stubEnv("DESKTOP_FEED_URL", "http://10.37.16.72:18082/desktop");
    expect(getDesktopFeedUrl()).toBe("http://10.37.16.72:18082/desktop/");
  });
});

describe("fetchFeedRelease", () => {
  it("parses version and resolves mac arm64 dmg/zip to feed URLs", async () => {
    const fetchMock = mockFeedResponse(VALID_FEED_YML);

    const result = await fetchFeedRelease(FEED_BASE);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://10.37.16.72:18082/desktop/latest-mac.yml",
      expect.anything(),
    );
    expect(result.version).toBe("0.3.16");
    expect(result.publishedAt).toBe("2026-06-09T06:29:14.546Z");
    expect(result.htmlUrl).toBeNull();
    expect(result.assets.macArm64Dmg).toBe(
      "http://10.37.16.72:18082/desktop/multica-desktop-0.3.16-mac-arm64.dmg",
    );
    expect(result.assets.macArm64Zip).toBe(
      "http://10.37.16.72:18082/desktop/multica-desktop-0.3.16-mac-arm64.zip",
    );
    // Feed ships mac arm64 only — other platforms stay empty.
    expect(result.assets.winX64Exe).toBeUndefined();
    expect(result.assets.linuxAmd64AppImage).toBeUndefined();
  });

  it("falls back to a version-unavailable shape on a non-200 feed", async () => {
    mockFeedResponse("not found", 404);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchFeedRelease(FEED_BASE);

    expect(result).toEqual({
      version: null,
      publishedAt: null,
      htmlUrl: null,
      assets: {},
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("degrades to version-unavailable when version is missing", async () => {
    mockFeedResponse(`files:\n  - url: multica-desktop-mac-arm64.dmg\n`);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchFeedRelease(FEED_BASE);

    expect(result.version).toBeNull();
    expect(result.assets).toEqual({});
    warnSpy.mockRestore();
  });

  it("degrades to version-unavailable when files is missing", async () => {
    mockFeedResponse(`version: 0.3.16\nreleaseDate: '2026-06-09'\n`);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchFeedRelease(FEED_BASE);

    expect(result.version).toBeNull();
    expect(result.assets).toEqual({});
    warnSpy.mockRestore();
  });

  it("degrades to version-unavailable when files has the wrong type", async () => {
    mockFeedResponse(`version: 0.3.16\nfiles: not-an-array\n`);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchFeedRelease(FEED_BASE);

    expect(result.version).toBeNull();
    expect(result.assets).toEqual({});
    warnSpy.mockRestore();
  });

  it("degrades to version-unavailable on syntactically broken YAML", async () => {
    mockFeedResponse(`version: 0.3.16\nfiles: [\n  - url: "unterminated`);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchFeedRelease(FEED_BASE);

    expect(result.version).toBeNull();
    expect(result.assets).toEqual({});
    warnSpy.mockRestore();
  });
});
