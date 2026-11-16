# PDF 압축

> PDF가 아닌 파일(한글 HWP·HWPX, 사진)도 넣으면 PDF로 바꾼 뒤 압축해요.
>
> 스캔 PDF를 검색되게 만들기(OCR + Claude 검사 + 자동 압축)는 [`/ocr/`](https://evenstar1031.github.io/pdf-compress/ocr/) 페이지에서 해요. 처리는 비공개 저장소 `pdf-ocr-verify`의 GitHub Actions가 맡아요.

iLovePDF의 "PDF 압축"과 같은 일을 하는 도구예요. 엔진도 같은 계열(Ghostscript)이라 결과도 비슷하게 나와요.

- **업로드 없음** — 압축이 내 기기 안에서 일어나요. 서버로 파일이 안 나가요.
- **용량 제한 없음 · 여러 파일 한 번에** — 파일 수/크기 제한을 두지 않았어요. (기기 메모리만큼은 한계가 있어요. 아래 참고)
- **3단계 압축** — 강하게(72dpi) / 권장(150dpi) / 약하게(300dpi)
- 글자는 그대로 남아서 **검색·복사가 계속 돼요.** 이미지만 줄어들어요.
- 압축해도 거의 안 줄어드는 파일은 원본을 그대로 돌려줘요.
- **PDF가 아닌 파일은 PDF로 바꾼 뒤 압축해요.**
  - **한글(HWP·HWPX)**: [rhwp](https://github.com/edwardkim/rhwp)(MIT)로 쪽마다 그린 뒤 [MuPDF](https://mupdf.com/)(AGPL)로 PDF를 만들어요. 표·선·그림은 그대로, 글자는 검색·복사되는 진짜 글자로 들어가요. 글꼴은 고딕 = Noto Sans KR, 바탕 = 나눔명조(둘 다 OFL)로 바뀌어요.
  - **사진(JPG·PNG·HEIC·WEBP·GIF·BMP·TIFF)**: 한 장이 한 쪽. 사진 비율 그대로, 긴 변을 A4 긴 변에 맞춰요. 사진의 회전 정보도 반영해요.
  - 워드·파워포인트·엑셀은 브라우저 안에서 정확히 그릴 방법이 없어서 받지 않아요. 그 앱에서 *PDF로 내보내기* 한 뒤 넣어 주세요.
  - 결과 이름은 `원래이름_압축.pdf` (이름 그대로 저장을 켜면 `원래이름.pdf`).

| 어디서 | 무엇으로 |
|---|---|
| 아이패드 | GitHub Pages에 올린 웹페이지 (Safari) |
| 윈도우 노트북 | 같은 웹페이지 (Edge/Chrome) **또는** `windows/PDF-Compress.bat` |
| GitHub | 이 저장소 자체가 웹페이지로 호스팅됨 |

---

## 1. GitHub Pages에 올리기 (처음 한 번)

1. github.com → 오른쪽 위 **+** → **New repository**
   - 이름: 예) `pdf-compress`
   - **Public** 선택 (무료 계정은 Public이어야 Pages가 돼요)
   - Create repository
2. 만들어진 화면에서 **uploading an existing file** 클릭
3. 압축 푼 폴더 **안의 내용물 전부**(`index.html`, `app.js`, `worker.js`, `engine` 폴더, `windows` 폴더 등)를 끌어다 놓기 → **Commit changes**
   - `engine/gs.wasm`이 15MB라서 올라가는 데 조금 걸려요 (웹 업로드 한도 25MB 안이라 괜찮아요)
4. 저장소 **Settings → Pages**
   - Source: **Deploy from a branch**
   - Branch: **main** / **/(root)** → Save
5. 1~2분 뒤 위쪽에 주소가 떠요: `https://내아이디.github.io/pdf-compress/`

> `index.html`을 더블클릭해서 바로 열면 동작하지 않아요(브라우저 보안 규칙 때문에). 꼭 위 주소로 열어 주세요.

## 2. 아이패드에서

1. Safari로 위 주소 열기 → 공유 버튼 → **홈 화면에 추가** 하면 앱처럼 쓸 수 있어요
2. **PDF를 끌어다 놓거나 눌러서 선택** → 파일 앱에서 여러 개 선택
   (스플릿 뷰로 파일 앱을 옆에 띄우고 끌어다 놔도 돼요)
3. 압축 수준 고르고 **압축 시작**
4. 받는 방법
   - **받기** → 파일 앱의 "다운로드" 폴더에 저장
   - **공유** → "파일에 저장"이나 굿노트 등으로 바로 보내기
   - 여러 개면 **모두 ZIP으로 받기** 또는 **모두 공유**

처리하는 동안엔 이 화면을 띄워 두세요. 다른 앱으로 오래 넘어가면 Safari가 작업을 멈출 수 있어요. (브라우저가 지원하면 처리 중엔 화면이 자동으로 꺼지지 않게 해 뒀어요)

## 3. 윈도우 노트북에서

**방법 A — 웹 (설치 없음)**: Edge/Chrome으로 같은 주소 열기. 폴더째 끌어다 놔도 안의 PDF를 다 찾아요. 컴퓨터에선 여러 파일을 동시에 처리해서 더 빨라요.

**방법 B — 스크립트 (아주 큰 파일·많은 파일용, 더 빠름)**

1. Ghostscript 설치 (처음 한 번): <https://ghostscript.com/releases/gsdnld.html> → *Ghostscript AGPL Release* 줄의 **64 bit Windows** 설치 파일 → 기본 설정 그대로 설치
   (설치 안 된 상태로 실행하면 이 페이지를 자동으로 열어 줘요)
2. `windows` 폴더를 원하는 곳에 두고, **`PDF-Compress.bat` 위로 PDF 파일들이나 폴더를 끌어다 놓기**
   - 더블클릭하면 파일 고르는 창이 떠요 (Ctrl/Shift로 여러 개)
3. 1/2/3 중 압축 수준 입력 (그냥 Enter = 권장)
4. 결과는 원본과 같은 폴더에 `이름_압축.pdf`로 생겨요. 원본은 안 건드려요.
   - 폴더를 다시 끌어다 놔도 이미 만든 `_압축` 파일은 건너뛰어요.

명령줄 옵션 (선택):
```
powershell -ExecutionPolicy Bypass -File compress-pdf.ps1 -Level extreme|recommended|low [-KeepName] [-OutDir 폴더] 파일또는폴더...
```
`-KeepName`을 주면 이름은 그대로 두고 원본 옆 `압축됨` 폴더에 저장해요.

> "Windows의 PC 보호" 창이 뜨면 **추가 정보 → 실행**. 받은 ZIP을 풀기 전에 ZIP 파일 우클릭 → 속성 → **차단 해제**를 체크해 두면 안 떠요.

## 압축 수준

| 수준 | 이미지 해상도 | 언제 |
|---|---|---|
| 강하게 | 72dpi | 최대한 작게. 사진·스캔 글씨는 흐려질 수 있음 |
| **권장** | 150dpi | 아이패드·노트북 화면으로 보기에 충분. 대부분 이걸로 |
| 약하게 | 300dpi | 인쇄할 자료. 이미지가 원래 300dpi 이하면 거의 안 줄어듦 |

테스트(사진 많은 강의 슬라이드 24쪽, 55MB): 강하게 1.5MB · 권장 2.3MB · 약하게 42.6MB

## 용량에 대해 솔직하게

- 파일 크기·개수 제한은 코드에 없어요.
- 다만 웹 버전은 파일을 기기 메모리에 올려서 처리해요. 컴퓨터에선 수백 MB~1GB대도 무난하고(273MB 파일 테스트 OK), 아이패드는 기종 메모리에 따라 수백 MB 정도가 현실적인 한 번에 처리 크기예요. 아이패드에선 한 번에 한 파일씩 순서대로 처리해서 메모리를 아껴요.
- 그보다 큰 파일은 윈도우 스크립트(방법 B)를 쓰면 메모리 걱정이 거의 없어요.

## 잘 안 될 때

- **"압축 엔진을 불러오지 못했어요"** — Pages 반영 전일 수 있어요. 몇 분 뒤 새로고침. `engine/gs.wasm`이 올라갔는지 확인.
- **암호 걸린 PDF** — 여는 암호가 있는 PDF는 압축할 수 없어요. 암호를 푼 뒤 넣어 주세요.
- **한글 문서가 안 열림** — 암호·배포용으로 잠긴 문서는 한글에서 잠금을 푼 뒤 넣어 주세요. 옛 수식 편집기로 만든 수식은 글자가 빠질 수 있어요.
- **한글 문서가 처음에 느림** — 한글 엔진(약 27MB)과 글꼴(필요한 것만, 최대 약 18MB)을 처음 한 번 받아요.
- **"원본에 오류가 있어…" 경고** — 원래 PDF가 살짝 깨져 있던 경우예요. 결과를 한 번 열어서 확인해 주세요.
- **"이미 최적화돼 있어…"** — 더 줄일 게 없는 파일이라 원본을 그대로 줘요. (글자만 있는 PDF, 이미 압축한 PDF 등)

## 구성

```
index.html, app.js      화면
worker.js               압축 담당 (백그라운드)
engine/gs.js, gs.wasm   Ghostscript 10.06 WebAssembly 빌드 (@okathira/ghostpdl-wasm)
convert/worker.js       PDF가 아닌 파일 → PDF (한글·사진). 필요할 때만 불러와요
convert/hwp-pdf.js      HWP/HWPX → PDF (lectrue-font-swap 저장소와 같은 파일)
convert/vendor/         MuPDF.js(AGPL), rhwp(MIT), HarfBuzz subset(MIT)
convert/fonts/          Noto Sans KR(Regular·Bold, 한글·KS X 1001 한자·기호만 남긴 판), 나눔명조, 기호용 Noto Sans Symbols 2·Math — 모두 OFL
manifest.webmanifest, icon-*.png   홈 화면 추가용
windows/                윈도우용 스크립트 (.bat + PowerShell)
```

## 라이선스

압축 엔진인 Ghostscript는 AGPL-3.0이에요(`engine/LICENSE-ghostscript-AGPL.txt`). 개인적으로 쓰는 데는 아무 문제 없고, 이 저장소를 공개해 두면 소스 공개 조건도 그대로 충족돼요.
