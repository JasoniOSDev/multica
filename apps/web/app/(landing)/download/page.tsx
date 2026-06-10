import type { Metadata } from "next";
import { fetchLatestRelease } from "@/features/landing/utils/github-release";
import {
  fetchFeedRelease,
  feedReleasesHref,
  getDesktopFeedUrl,
} from "@/features/landing/utils/feed-release";
import { DownloadClient } from "./download-client";

// Vercel ISR: the server fetch inside fetchLatestRelease carries
// `next: { revalidate: 300 }`, which makes GitHub API cost at most
// one request per region per 5 minutes. Page-level revalidate mirrors
// that window so the first paint also refreshes every 5 minutes.
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Download Multica",
  description:
    "Download Multica for macOS, Windows, or Linux — or install the CLI for servers and remote dev boxes.",
  openGraph: {
    title: "Download Multica",
    description:
      "Get the Multica desktop app with a bundled daemon, or install the CLI for servers and remote dev boxes.",
    url: "/download",
  },
  alternates: {
    canonical: "/download",
  },
};

export default async function DownloadPage() {
  // Internal-network deploys set DESKTOP_FEED_URL to read the desktop
  // auto-update feed (latest-mac.yml) instead of GitHub Releases, which
  // the box can't reach. Unset → unchanged public GitHub behavior.
  const feedUrl = getDesktopFeedUrl();
  if (feedUrl) {
    const release = await fetchFeedRelease(feedUrl);
    return (
      <DownloadClient
        release={release}
        allReleasesUrl={feedReleasesHref(feedUrl)}
      />
    );
  }
  const release = await fetchLatestRelease();
  return <DownloadClient release={release} />;
}
