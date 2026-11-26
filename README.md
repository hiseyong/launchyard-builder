# launchyard-builder

[Launchyard](https://github.com/hiseyong/launchyard)의 iOS 빌드 워크플로만 담은 저장소다.
고객 코드·비밀값은 전혀 들어가지 않는다 — 비밀값은 전부 GitHub Actions 시크릿으로만 전달되고,
러너는 각 빌드 시점에 Launchyard API에서 암호문/설치 토큰을 받아와 메모리·임시 파일에서만 쓰고 지운다.

## 왜 public인가

GitHub 호스티드 macOS 러너(`runs-on: macos-latest`)는 **public 저장소에서만 무료**다. 고객 코드가
있는 메인 저장소는 public으로 만들 수 없어서, 빌드 워크플로만 이렇게 따로 뗐다.

셀프 호스티드 Mac이나 Codemagic/Bitrise 같은 전문 모바일 CI는 쓰지 않는다 — 전자는 Mac을 직접
구해 상시 운영해야 해서 어렵고, 후자는 저장소 접근 권한을 앱마다 영구 저장해야 해서 Launchyard가
쓰는 "1시간짜리 GitHub App 설치 토큰" 방식과 안 맞는다.

## 남은 설정 (순서대로)

1. **`GITHUB_DISPATCH_TOKEN` 발급**: GitHub Settings → Developer settings → Fine-grained tokens에서
   **이 저장소 하나에만** `Actions: Read and write` 권한을 준 토큰을 만든다. 고객 저장소용
   GitHub App(읽기 전용)과는 완전히 별개다.
2. **이 저장소의 시크릿 등록** (Settings → Secrets and variables → Actions):
   - `API_BASE` — Launchyard API 주소 (예: `https://launchyard.app`)
   - `RUNNER_SHARED_SECRET` — 러너 전용 API(`/api/runner/*`) 인증용. 새로 생성해서 Launchyard
     쪽 환경 변수에도 같은 값을 넣는다 (`openssl rand -hex 32`).
   - `CREDENTIALS_ENCRYPTION_KEY` — Launchyard가 쓰는 값과 **동일하게** 넣는다(여기서 .p8을
     복호화하기 때문).
3. **Launchyard 쪽 환경 변수**(Vercel): `BUILDER_REPO=hiseyong/launchyard-builder`,
   `BUILDER_WORKFLOW=build-ios.yml`, `GITHUB_DISPATCH_TOKEN`, `RUNNER_SHARED_SECRET`을 등록한다.
4. **내부 테스트 Apple 계정**: ASC에 테스트용 번들 ID의 앱 레코드를 손으로 만든다(API로 불가능).
   Launchyard 대시보드 → Apple 연동에서 Team ID까지 입력해 등록을 마친다.
5. **첫 E2E 확인**: `fixtures/expo-sample`을 연결한 테스트 계정으로 빌드를 한 번 트리거해서,
   클론 → prebuild → 사전 검사 → fastlane 서명·업로드 → TestFlight까지 실제로 도는지 확인한다.

## 알아 둘 것

- `run-build.mjs`는 설치 토큰이 든 git clone URL을 셸 문자열로 조립하지 않고 배열 인자로만
  넘긴다 — Actions 로그에 토큰이 찍히지 않게 하기 위함이다.
- `.p8`은 러너에서만 복호화하고, 성공·실패와 상관없이 `finally`에서 지운다.
- `builder/precheck.mjs`는 메인 저장소 `packages/precheck`의 규칙 1종을 그대로 복사한 것이다
  (이 저장소가 private 패키지를 설치할 수 없어서). 규칙이 늘어나면 `packages/precheck`를 npm에
  배포해서 의존성으로 설치하는 쪽으로 바꾼다.
- 인증서/.p12 재사용은 아직 안 한다 — 매 빌드마다 `get_certificates`가 새로 발급한다. Apple의
  계정당 인증서 발급 수 제한에 걸릴 수 있다는 걸 알고 있고, 다음 단계에서 재사용 저장을 붙인다.
- 이 저장소는 메인 저장소(`hiseyong/launchyard`)의 `builder/`, `.github/workflows/build-ios.yml`과
  동일한 내용으로 유지한다. 바뀌면 양쪽에 같이 반영한다.
