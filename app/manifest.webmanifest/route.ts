import { NextRequest, NextResponse } from "next/server";

import baseManifest from "../../public/manifest.json";
import { readPwaDisplayPreference } from "@/lib/pwa-display-mode";

export const runtime = "nodejs";

// Installed PWA defaults to true manifest fullscreen. This avoids the browser
// Fullscreen API entirely, so Chrome does not show the unavoidable "exit
// fullscreen" security toast. Users who explicitly choose to show the system
// status bar still get standalone/minimal-ui through the preference cookie.
// Manifest display mode is most reliably applied after (re)install.
export function GET(request: NextRequest) {
  const ua = request.headers.get("user-agent") || "";
  const isEdge = /Edg/i.test(ua);
  const preference = readPwaDisplayPreference(request.headers.get("cookie") || "");

  const manifest = preference === "standalone"
    ? {
        ...baseManifest,
        display: isEdge ? "minimal-ui" : "standalone",
        display_override: isEdge ? ["minimal-ui", "standalone"] : ["standalone", "minimal-ui"],
        ...(isEdge ? { theme_color: "#f8f7f2" } : {}),
      }
    : {
        ...baseManifest,
        display: "fullscreen",
        display_override: ["fullscreen", "standalone"],
      };

  return new NextResponse(JSON.stringify(manifest), {
    headers: {
      "content-type": "application/manifest+json; charset=utf-8",
      "vary": "user-agent, cookie",
      "cache-control": "no-store",
    },
  });
}
