# DevTalk

A small team chat view for VS Code and Cursor.

Every running extension instance joins the same local UDP channel:

- Address: `239.255.42.99`
- Port: `45454`

Messages are only intended for the local network. Some Wi-Fi routers or corporate networks block multicast traffic.

## Run

Open this folder in VS Code, press `F5`, and open the `DevTalk` activity bar view in the Extension Development Host.

## Share

Build a VSIX installer:

```bash
npm install
npm run package
```

Send the generated `.vsix` file to friends. They can install it in VS Code with:

1. Open Extensions
2. Select `...`
3. Select `Install from VSIX...`
4. Pick the `.vsix` file

After installation, everyone opens the DevTalk activity bar view. On first use, each person must enter a chat name before messages can be sent or received. When DevTalk is hidden, unread messages are counted on the activity bar and marked in the chat when reopened.

To use a custom nickname, set:

```json
{
  "devtalk.nickname": "your-name"
}
```
