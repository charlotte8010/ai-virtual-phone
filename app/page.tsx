import { AndroidPopupGuard } from "@/components/android-popup-guard";
import { MainApp } from "@/components/main-app";

export default function HomePage() {
  return (
    <>
      <AndroidPopupGuard />
      <MainApp />
    </>
  );
}
