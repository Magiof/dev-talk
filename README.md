# DevTalk

[한국어](README.ko.md)

DevTalk is a small team chat view for VS Code and Cursor. It lives in the Explorer sidebar, asks each person for a chat name on first use, and lets you manually join or leave the shared room before sending messages through Supabase Realtime.

## Features

- Shared team chat view
- VS Code and Cursor support through VSIX installation
- Theme-aware Webview UI
- First-run chat name setup
- Manual Join and Leave controls
- Korean IME-safe Enter handling
- Unread message badge, capped at 999
- Unread marker showing where new messages began
- Supabase Realtime messaging
- Supabase Storage file sharing
- Image and animated GIF previews
- 5 MB file size limit
- Default and work visual themes
- Optional per-speaker pastel highlight mode
- Terminal client for the same Supabase room

## Supabase Setup

Create a Supabase project, then create a public Storage bucket. `devtalk-files` is the default name, but you can choose another bucket name and enter it in DevTalk settings.

Recommended bucket policy for a small private friend group. Replace `devtalk-files` if you chose a different bucket name:

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

The extension enforces a 5 MB file limit before upload. Keep Supabase keys out of the public repository.

## Install

For the terminal CLI, install DevTalk from npm:

```bash
npm install -g @magiof/devtalk
dev-talk
```

Download the latest VSIX from GitHub Releases, then install it in VS Code:

1. Open Extensions
2. Select `...`
3. Select `Install from VSIX...`
4. Pick the downloaded `.vsix` file
5. Run `Developer: Reload Window`

For Cursor, use Command Palette and run:

```text
Extensions: Install from VSIX...
```

If that command is not visible, install from a terminal:

```bash
cursor --install-extension devtalk-0.1.6.vsix
```

## Settings

DevTalk stores shared terminal and extension settings at `~/.devtalk/config.json`. If you already ran the CLI setup, the VS Code/Cursor extension uses that config automatically. If the file does not exist, click Join in the DevTalk Explorer sidebar view and enter the values when prompted.

You can also set these in VS Code/Cursor user settings. Do not commit real values.

```json
{
  "devtalk.supabaseUrl": "https://your-project.supabase.co",
  "devtalk.supabaseAnonKey": "your-anon-key",
  "devtalk.storageBucket": "devtalk-files",
  "devtalk.theme": "default"
}
```

Use `"devtalk.theme": "work"` for a quieter, denser view that looks more like work logs than chat. You can also type `/theme` or `/theme work` in DevTalk to switch themes after joining. Type `/color-mode` to toggle per-speaker pastel highlights, and `/config` to edit nickname and Supabase settings from the chat view. The extension writes updated setup values back to `~/.devtalk/config.json` so the CLI can reuse them.

To use a fixed nickname without the first-run prompt, also set:

```json
{
  "devtalk.nickname": "your-name"
}
```

## Terminal

DevTalk can also run in a terminal against the same Supabase room. On first run, missing settings are prompted and saved to `~/.devtalk/config.json`. Keep real values out of Git.

```bash
npm run cli
```

After packaging or installing the package, you can also run:

```bash
dev-talk
```

DevTalk uses one shared room internally. CLI arguments and environment variables override saved settings:

```bash
dev-talk --bucket devtalk-files --name your-name
```

Terminal commands:

```text
/theme [default|work]
/color-mode
/config
/file ./image.gif
/help
/quit
```

Files are limited to 5 MB. GIFs and images sent from the terminal appear as previews in the VS Code/Cursor view. Press `Ctrl+C` twice quickly to exit.

## Development

```bash
npm install
npm run check
npm run package
```

To run the extension locally, open this folder in VS Code, press `F5`, and open DevTalk in the Extension Development Host.

## Security Notes

- `devtalk.supabaseUrl` and `devtalk.supabaseAnonKey` are runtime settings, not source files.
- `.env*` is ignored for local notes or scripts.
- Terminal settings are saved outside the repository at `~/.devtalk/config.json`.
- The anon key is intended for client-side apps, but access must still be controlled with Supabase Row Level Security and Storage policies.
- Do not use the Supabase service role key in DevTalk.

## License

MIT
