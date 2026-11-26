import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDecipheriv } from "node:crypto";
import { analyzeProject } from "./precheck.mjs";

const execFileAsync = promisify(execFile);
const BUILDER_DIR = dirname(fileURLToPath(import.meta.url));

const BUILD_ID = requireEnv("BUILD_ID");
const API_BASE = requireEnv("API_BASE");
const RUNNER_SHARED_SECRET = requireEnv("RUNNER_SHARED_SECRET");
const CREDENTIALS_ENCRYPTION_KEY = requireEnv("CREDENTIALS_ENCRYPTION_KEY");
const RUNNER_TEMP = process.env.RUNNER_TEMP ?? "/tmp";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}이 설정되지 않았습니다.`);
  return value;
}

// packages/shared/src/crypto.ts와 같은 AES-256-GCM 복호화다.
function decrypt(blob) {
  const [ivB64, tagB64, dataB64] = blob.split(".");
  const key = Buffer.from(CREDENTIALS_ENCRYPTION_KEY, "base64");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${RUNNER_SHARED_SECRET}`, "Content-Type": "application/json", ...options.headers },
  });
  if (!res.ok) throw new Error(`API ${path} 호출 실패: ${res.status}`);
  return res.json();
}

async function postStatus(status, extra = {}) {
  await api(`/api/runner/builds/${BUILD_ID}/status`, { method: "POST", body: JSON.stringify({ status, ...extra }) });
}

async function postLog(line) {
  console.log(line);
  await api(`/api/runner/builds/${BUILD_ID}/log`, { method: "POST", body: JSON.stringify({ line }) }).catch(() => {});
}

async function main() {
  const jobDir = join(RUNNER_TEMP, "job");
  const keychain = join(RUNNER_TEMP, "build.keychain-db");
  const p8Path = join(RUNNER_TEMP, "AuthKey.p8");

  try {
    // 이 호출이 빌드를 queued -> building으로 원자적으로 전환한다.
    const build = await api(`/api/runner/builds/${BUILD_ID}`);
    await postLog("[러너] 작업을 넘겨받았습니다. 저장소를 클론합니다.");

    await mkdir(jobDir, { recursive: true });
    // 설치 토큰이 들어간 URL이 로그에 찍히지 않도록 명령 문자열을 echo하지 않는다(배열 인자로만 전달).
    const cloneUrl = `https://x-access-token:${build.installationToken}@github.com/${build.repoFullName}.git`;
    await execFileAsync("git", ["clone", "--depth", "1", cloneUrl, jobDir]);

    await postLog("[러너] 저장소 클론 완료. 의존성을 설치합니다.");
    await execFileAsync("npm", ["ci"], { cwd: jobDir });

    if (build.framework === "expo") {
      await execFileAsync("npx", ["expo", "prebuild", "--platform", "ios", "--clean", "--non-interactive"], {
        cwd: jobDir,
      });
    } else if (build.framework === "capacitor") {
      await execFileAsync("npm", ["run", "build"], { cwd: jobDir });
      await execFileAsync("npx", ["cap", "sync", "ios"], { cwd: jobDir });
    }
    await postStatus("building");
    await postLog("[러너] 네이티브 프로젝트를 준비했습니다.");

    // 리젝 사전 검사. 실제 클론된 소스를 분석할 수 있는 건 여기(러너)뿐이다.
    const findings = await analyzeProject(jobDir, build.framework);
    await api(`/api/runner/builds/${BUILD_ID}/precheck`, { method: "POST", body: JSON.stringify({ results: findings }) });
    if (findings.length > 0) await postLog(`[사전 검사] ${findings.length}개 항목을 발견했습니다.`);

    await writeFile(p8Path, decrypt(build.p8Encrypted), { mode: 0o600 });

    const iosDir = join(jobDir, "ios");
    const entries = await readdir(iosDir);
    const xcodeproj = entries.find((e) => e.endsWith(".xcodeproj"));
    const xcworkspace = entries.find((e) => e.endsWith(".xcworkspace"));
    if (!xcodeproj) throw new Error("ios/*.xcodeproj를 찾을 수 없습니다.");
    const scheme = xcodeproj.replace(/\.xcodeproj$/, "");

    await postStatus("uploading");
    await postLog("[러너] fastlane으로 서명·아카이브·업로드를 시작합니다.");

    await execFileAsync(
      "bundle",
      [
        "exec",
        "fastlane",
        "ios",
        "beta",
        `key_id:${build.keyId}`,
        `issuer_id:${build.issuerId}`,
        `key_filepath:${p8Path}`,
        `team_id:${build.teamId}`,
        `bundle_id:${build.bundleId}`,
        `xcodeproj:${join(iosDir, xcodeproj)}`,
        `workspace:${xcworkspace ? join(iosDir, xcworkspace) : ""}`,
        `scheme:${scheme}`,
      ],
      { cwd: BUILDER_DIR },
    );

    await postStatus("processing");
    await postLog("[App Store Connect] 빌드 처리를 기다립니다.");

    const buildNumber = await readBuildNumber();
    await postStatus("succeeded", buildNumber ? { buildNumber } : {});
    await postLog("[App Store Connect] 처리 완료. TestFlight에서 사용할 수 있습니다.");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await postLog(`[러너] 빌드 실패: ${message}`);
    await postStatus("failed", { error: message }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {});
    await rm(p8Path, { force: true }).catch(() => {});
    await execFileAsync("security", ["delete-keychain", keychain]).catch(() => {});
  }
}

async function readBuildNumber() {
  try {
    const raw = await readFile(join(RUNNER_TEMP, "build_number.txt"), "utf8");
    return Number(raw.trim());
  } catch {
    return undefined;
  }
}

main();
