# DevTalk

DevTalk는 VS Code와 Cursor의 Explorer 사이드바에서 사용할 수 있는 작은 팀 채팅 도구입니다. 처음 실행할 때 이름을 입력하고, 사용자가 Supabase Realtime 또는 같은 LAN의 UDP 채팅으로 직접 입장하거나 나간 뒤 메시지를 주고받습니다.

## 기능

- 공유 팀 채팅 뷰
- VS Code / Cursor VSIX 설치 지원
- IDE 테마를 따라가는 Webview UI
- 첫 실행 시 이름 설정
- 수동 입장과 나가기 버튼
- Supabase Realtime 또는 로컬 UDP LAN 입장 모드
- 한글 IME Enter 중복 전송 방지
- 읽지 않은 메시지 배지, 최대 999 표시
- 어디부터 새 메시지인지 보여주는 읽음 경계선
- Supabase Realtime 메시징
- Supabase Storage 파일 공유
- 이미지와 animated GIF 미리보기
- 파일 크기 5MB 제한
- 기본 테마와 업무용 work 테마
- 화자별 파스텔 형광펜 색상 모드
- 같은 Supabase 방에 접속하는 터미널 클라이언트

## Supabase 설정

Supabase 프로젝트를 만든 뒤, public Storage bucket을 생성하세요. `devtalk-files`가 기본 이름이지만 다른 bucket 이름을 만들고 DevTalk 설정에 입력해도 됩니다.

기본 bucket 이름:

```text
devtalk-files
```

작은 친구/팀 그룹용으로는 아래 Storage policy를 사용할 수 있습니다. 다른 bucket 이름을 썼다면 `devtalk-files`를 그 이름으로 바꾸세요.

```sql
create policy "DevTalk public read"
on storage.objects for select
to public
using (bucket_id = 'devtalk-files');

create policy "DevTalk anon upload"
on storage.objects for insert
to anon
with check (
  bucket_id = 'devtalk-files'
  and (storage.foldername(name))[1] = 'general'
);
```

확장과 CLI는 업로드 전에 파일 크기를 5MB로 제한합니다. Supabase 키는 public 저장소에 커밋하지 마세요.

## 입장 모드

확장에서 Join을 누르면 Supabase 또는 UDP LAN 중 어디로 접속할지 고를 수 있습니다.

- Supabase는 설정된 Supabase Realtime 방을 사용하고 파일 업로드를 지원합니다.
- UDP LAN은 Supabase 설정 없이 같은 로컬 네트워크에서 동작합니다. 텍스트 채팅과 온라인 표시를 지원하지만 파일 업로드는 지원하지 않습니다.

## 설치

터미널 CLI는 npm으로 전역 설치할 수 있습니다.

```bash
npm install -g @magiof/devtalk
dev-talk
```

GitHub Releases에서 최신 VSIX 파일을 내려받은 뒤 VS Code에서 설치합니다.

1. Extensions 열기
2. `...` 선택
3. `Install from VSIX...` 선택
4. 내려받은 `.vsix` 파일 선택
5. `Developer: Reload Window` 실행

Cursor에서는 Command Palette에서 아래 명령을 실행합니다.

```text
Extensions: Install from VSIX...
```

해당 명령이 보이지 않으면 터미널에서 설치할 수 있습니다.

```bash
cursor --install-extension devtalk-0.1.6.vsix
```

## 설정

DevTalk는 터미널 CLI와 확장이 함께 쓰는 설정을 `~/.devtalk/config.json`에 저장합니다. CLI에서 이미 최초 설정을 했다면 VS Code/Cursor 확장이 그 설정을 자동으로 사용합니다. 파일이 아직 없다면 DevTalk Explorer 사이드바 뷰에서 Join을 눌렀을 때 필요한 값을 입력할 수 있습니다.

아래 값들은 VS Code/Cursor 사용자 설정에 직접 넣을 수도 있습니다. 실제 값은 Git에 커밋하지 마세요.

```json
{
  "devtalk.supabaseUrl": "https://your-project.supabase.co",
  "devtalk.supabaseAnonKey": "your-anon-key",
  "devtalk.storageBucket": "devtalk-files",
  "devtalk.theme": "default"
}
```

업무용으로 조용하고 촘촘한 화면을 쓰고 싶으면 이렇게 설정합니다. 입장한 뒤 DevTalk 입력창에서 `/theme` 또는 `/theme work`를 입력해도 테마를 바꿀 수 있고, `/color-mode`로 화자별 파스텔 형광펜 표시를 켜고 끌 수 있습니다. `/config`를 입력하면 닉네임과 Supabase 설정을 다시 변경할 수 있습니다. 확장에서 변경한 설정은 `~/.devtalk/config.json`에도 저장되어 CLI에서 재사용할 수 있습니다.

```json
{
  "devtalk.theme": "work"
}
```

처음 실행할 때 이름 입력을 건너뛰고 고정 닉네임을 쓰려면 아래 설정도 추가하세요.

```json
{
  "devtalk.nickname": "your-name"
}
```

## 터미널

DevTalk는 같은 Supabase 방에 터미널에서도 접속할 수 있습니다. 처음 실행할 때 필요한 설정이 없으면 값을 물어보고 `~/.devtalk/config.json`에 저장합니다. 이 파일은 저장소 밖에 있으므로 Git에 올라가지 않습니다.

```bash
npm run cli
```

패키지로 설치했거나 bin을 사용할 수 있다면 아래처럼 실행할 수 있습니다.

```bash
dev-talk
```

DevTalk는 내부적으로 하나의 공유 대화방만 사용합니다. CLI 인자나 환경변수는 저장된 설정값보다 우선합니다.

```bash
dev-talk --bucket devtalk-files --name your-name
```

터미널 명령:

```text
/theme [default|work]
/color-mode
/config
/file ./image.gif
/help
/quit
```

파일은 5MB까지만 업로드됩니다. 터미널에서 보낸 GIF와 이미지는 VS Code/Cursor DevTalk 뷰에서 미리보기로 표시됩니다. 종료하려면 `Ctrl+C`를 빠르게 두 번 누르세요.

## 개발

```bash
npm install
npm run check
npm run package
```

로컬에서 확장을 실행하려면 이 폴더를 VS Code로 열고 `F5`를 누른 뒤, Extension Development Host에서 DevTalk를 열면 됩니다.

## 보안 메모

- `devtalk.supabaseUrl`, `devtalk.supabaseAnonKey`는 런타임 설정값이며 소스 파일에 넣지 않습니다.
- `.env*`는 로컬 메모나 스크립트용으로 ignore되어 있습니다.
- 터미널 설정은 저장소 밖 `~/.devtalk/config.json`에 저장됩니다.
- anon key는 클라이언트 앱에서 사용할 수 있는 키지만, Supabase RLS와 Storage policy로 접근을 제한해야 합니다.
- Supabase service role key는 DevTalk에 절대 사용하지 마세요.

## 라이선스

MIT
