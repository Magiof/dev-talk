# DevTalk

DevTalk is a small team chat view for VS Code and Cursor. It lives in the activity bar, asks each person for a chat name on first use, and sends messages to other DevTalk users on the same local network.

## Features

- Single shared local chat view
- VS Code and Cursor support through VSIX installation
- Theme-aware Webview UI
- First-run chat name setup
- Korean IME-safe Enter handling
- Unread message badge, capped at 999
- Unread marker showing where new messages began
- UDP multicast plus broadcast fallback for same-Wi-Fi delivery

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
cursor --install-extension devtalk-0.0.12.vsix
```

## Development

```bash
npm install
npm run check
npm run package
```

To run the extension locally, open this folder in VS Code, press `F5`, and open DevTalk in the Extension Development Host.

## Network Notes

DevTalk currently works over the local network. Everyone must be on the same Wi-Fi/LAN, and some routers or corporate networks can block device-to-device UDP traffic.

If messages do not appear for everyone, check:

- Everyone installed the same DevTalk version
- Everyone is on the same non-guest Wi-Fi
- VPN is disabled or not isolating local traffic
- macOS/Windows firewall is not blocking Cursor or VS Code
- Router settings such as AP Isolation, Client Isolation, Wireless Isolation, or Guest Network Isolation are off

## Settings

To use a fixed nickname without the first-run prompt, set:

```json
{
  "devtalk.nickname": "your-name"
}
```

## License

MIT
