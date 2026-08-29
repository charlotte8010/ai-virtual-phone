"use client";

import { useEffect, useLayoutEffect } from "react";

const SKIP_SPLASH_ONCE_KEY = "float_skip_splash_once";

/** Mark a World Builder back action before its existing handler navigates to `/`. */
export function WorldBuilderReturnMarker() {
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('[data-float-back="world-builder"]')) return;
      try {
        window.sessionStorage.setItem(SKIP_SPLASH_ONCE_KEY, "1");
      } catch {
        // sessionStorage can be unavailable in privacy-restricted WebViews; normal splash remains the fallback.
      }
    };

    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, []);

  return null;
}

/**
 * The root page normally shows the Float startup animation on every full navigation.
 * Internal returns from World Builder should behave like closing an app instead: wait for
 * the existing splash Enter button to become ready, activate it automatically, and keep
 * the splash visually hidden while hydration finishes.
 */
export function SkipSplashAfterInternalReturn() {
  useLayoutEffect(() => {
    let shouldSkip = false;
    try {
      shouldSkip = window.sessionStorage.getItem(SKIP_SPLASH_ONCE_KEY) === "1";
      if (shouldSkip) window.sessionStorage.removeItem(SKIP_SPLASH_ONCE_KEY);
    } catch {
      shouldSkip = false;
    }
    if (!shouldSkip) return;

    document.documentElement.classList.add("float-skip-splash-once");

    let finished = false;
    let removeClassTimer = 0;
    const tryEnter = () => {
      if (finished) return true;
      const button = document.querySelector<HTMLButtonElement>(".splash-enter-button");
      if (!button || button.disabled) return false;
      finished = true;
      button.click();
      // Keep the splash hidden through the React state transition to DesktopShell.
      removeClassTimer = window.setTimeout(() => {
        document.documentElement.classList.remove("float-skip-splash-once");
      }, 800);
      return true;
    };

    const observer = new MutationObserver(() => {
      tryEnter();
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["disabled", "class"],
    });

    const interval = window.setInterval(tryEnter, 50);
    const timeout = window.setTimeout(() => {
      if (!finished) document.documentElement.classList.remove("float-skip-splash-once");
    }, 10000);
    tryEnter();

    return () => {
      observer.disconnect();
      window.clearInterval(interval);
      window.clearTimeout(timeout);
      if (removeClassTimer) window.clearTimeout(removeClassTimer);
      document.documentElement.classList.remove("float-skip-splash-once");
    };
  }, []);

  return (
    <style>{`
      html.float-skip-splash-once,
      html.float-skip-splash-once body {
        background: #121110 !important;
      }
      html.float-skip-splash-once .splash-root {
        visibility: hidden !important;
      }
    `}</style>
  );
}
