# DevTalk

DevTalk is a small team chat view for VS Code and Cursor. It lives in the activity bar, asks each person for a chat name on first use, and sends messages through Supabase Realtime.

## Features

- Shared team chat view
- VS Code and Cursor support through VSIX installation
- Theme-aware Webview UI
- First-run chat name setup
- Korean IME-safe Enter handling
- Unread message badge, capped at 999
- Unread marker showing where new messages began
- Supabase Realtime messaging
- Supabase Storage file sharing
- Image and animated GIF previews
- 5 MB file size limit
- Default and work visual themes

## Supabase Setup

Create a Supabase project, then create a public Storage bucket named `devtalk-files`.

Recommended bucket policy for a small private friend group:

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
cursor --install-extension devtalk-0.1.0.vsix
```

## Settings

Set these in VS Code/Cursor user settings. Do not commit real values.

```json
{
  "devtalk.supabaseUrl": "https://your-project.supabase.co",
  "devtalk.supabaseAnonKey": "your-anon-key",
  "devtalk.roomId": "general",
  "devtalk.storageBucket": "devtalk-files",
  "devtalk.theme": "default"
}
```

Use `"devtalk.theme": "work"` for a quieter, denser view that looks more like work logs than chat.

To use a fixed nickname without the first-run prompt, also set:

```json
{
  "devtalk.nickname": "your-name"
}
```

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
- The anon key is intended for client-side apps, but access must still be controlled with Supabase Row Level Security and Storage policies.
- Do not use the Supabase service role key in DevTalk.

## License

MIT
