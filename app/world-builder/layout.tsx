import type { ReactNode } from "react";
import type { Viewport } from "next";

import { AndroidFullscreen } from "@/components/android-fullscreen";
import { WorldBuilderReturnMarker } from "@/components/internal-return-splash-guard";

export const viewport: Viewport = {
  themeColor: "#121110",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function WorldBuilderLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: `
html,
body {
  background: #121110 !important;
  color-scheme: dark;
}

@media (max-width: 600px) and (pointer: coarse) {
  .wb-layout {
    width: 100% !important;
    height: 100dvh !important;
  }

  .wb-topbar {
    height: 52px !important;
    gap: 5px !important;
    padding: 6px 8px !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    scrollbar-width: none;
    overscroll-behavior-x: contain;
  }

  .wb-topbar::-webkit-scrollbar,
  .wb-categories::-webkit-scrollbar,
  .wb-model-list::-webkit-scrollbar {
    display: none;
  }

  .wb-topbar-btn {
    min-height: 40px;
    padding: 6px 10px !important;
    font-size: calc(12px * var(--app-text-scale, 1)) !important;
  }

  .wb-topbar-back {
    position: sticky;
    left: 0;
    z-index: 3;
    background: rgba(36, 34, 32, 0.96) !important;
    box-shadow: 8px 0 14px rgba(18, 17, 16, 0.42);
  }

  .wb-bottom-bar {
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }

  .wb-categories {
    padding-inline: 10px !important;
    scrollbar-width: none;
  }

  .wb-categories button {
    padding: 7px 12px !important;
  }

  .wb-model-list {
    padding: 8px 10px 10px !important;
    scrollbar-width: none;
  }

  .wb-model-thumb {
    width: 64px !important;
    height: 64px !important;
  }
}
`,
        }}
      />
      <AndroidFullscreen />
      <WorldBuilderReturnMarker />
      {children}
    </>
  );
}
