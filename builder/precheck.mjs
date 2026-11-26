import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";

// packages/precheck/src/rules/usage-description.ts와 같은 규칙이다. 이 저장소는 별도의
// public 빌드 저장소라 private 모노레포 패키지를 설치할 수 없어서 그대로 복사해 둔다.
// TODO(beta): 규칙이 늘어나면 packages/precheck를 npm에 배포해서 여기서 의존성으로 설치한다.

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SKIP_DIR = new Set(["node_modules", ".git", "ios", "android", ".expo", "dist", "build"]);

const USAGE_CHECKS = [
  { key: "NSCameraUsageDescription", patterns: [/expo-camera/, /AVCaptureDevice/, /@capacitor\/camera/] },
  { key: "NSPhotoLibraryUsageDescription", patterns: [/expo-image-picker/, /PHPhotoLibrary/] },
  {
    key: "NSLocationWhenInUseUsageDescription",
    patterns: [/expo-location/, /CLLocationManager/, /@capacitor\/geolocation/],
  },
];

async function collectSourceFiles(root) {
  const out = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIR.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (SOURCE_EXT.has(extname(entry.name))) out.push(full);
    }
  }
  await walk(root);
  return out;
}

async function readExpoInfoPlist(root) {
  try {
    const raw = await readFile(join(root, "app.json"), "utf8");
    const json = JSON.parse(raw);
    return json.expo?.ios?.infoPlist ?? {};
  } catch {
    return {};
  }
}

export async function analyzeProject(root, framework) {
  const files = await collectSourceFiles(root);
  const infoPlist = framework === "expo" ? await readExpoInfoPlist(root) : {};
  const sources = await Promise.all(files.map((f) => readFile(f, "utf8").catch(() => "")));
  const code = sources.join("\n");

  return USAGE_CHECKS.filter((c) => c.patterns.some((p) => p.test(code)) && !infoPlist[c.key]).map((c) => ({
    ruleId: "usage-description",
    guideline: "5.1.1",
    severity: "error",
    message: `${c.key} 없이 관련 기능을 사용하고 있습니다. 앱이 실행 중 종료되거나 심사에서 거절될 수 있습니다.`,
    fix: `Info.plist(Expo는 app.json의 ios.infoPlist)에 ${c.key}와 사용 목적 문구를 추가하세요.`,
  }));
}
