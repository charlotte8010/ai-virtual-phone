import { AndroidPopupGuard } from "@/components/android-popup-guard";
import { SkipSplashAfterInternalReturn } from "@/components/internal-return-splash-guard";
import { MainApp } from "@/components/main-app";

export default function HomePage() {
  return (
    <>
      <AndroidPopupGuard />
      <SkipSplashAfterInternalReturn />
      <MainApp />
    </>
  );
}
