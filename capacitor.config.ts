import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor 安卓壳配置（与 plane-game / tower-defense 同一套云端打包经验）。
 * 流程：node build.js（产出 index.html + www/index.html）→ npx cap sync android → Gradle 打 APK。
 * APK 构建在 GitHub Actions 云端执行（.github/workflows/build-apk.yml），本机无需 Android SDK。
 */
const config: CapacitorConfig = {
  appId: "com.qundaofeixing.holegame",
  appName: "黑洞吞噬大作战",
  webDir: "www",
};

export default config;
