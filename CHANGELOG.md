# Changelog

## 1.12.0 Emergency

- Service tabs show each site's favicon. A site you add yourself uses its own icon, or the first letter of its name when it has none.
- The README opens on a short clip: dark theme, signed in, tabs that stay loaded, and the WireGuard flag changing country.
- Compare states the principle that AI Hub does not send a prompt into the sites for you.

## 1.6.0

- macOS no longer asks for the login password twice when the app opens. Site sessions stay in the app, and a saved tunnel uses the keychain once.
- Applying a shared Google account opens the service without asking for that password again.
- Account switching and adding an account are one Account menu. Update AI Hub appears in the toolbar when a newer release is ready, checks the download, and installs it.
- Toolbar buttons stay readable in the light theme.
- The README hero is a picture of the app, not the empty loading bar.
- The app icon is the new ring mark, in the dock, the installer, and the README.

## 1.5.0

- Each account has its own tunnel or direct route. Changing the route of an account that already has a site session warns that it will see a country change.
- A shared Google sign-in applies only to the profiles you choose. Extra accounts start with their own sign-in.
- Compare insert focuses the chat's message box, then types the task text without sending it.
- OpenClaw install and update ask first. The installer is only `https://openclaw.ai/install.sh`.
- Tunnel tabs block WebRTC UDP that would skip the SOCKS proxy, including while the kill switch is on.
- A downloaded app update is offered only after its SHA-256 matches the release checksum.
- The README shows how to allow an unsigned Mac or Windows download, and how to check that file's SHA-256 on the release page.

## 1.4.0

- OpenClaw opens in its tab, signs in by itself, and installs or updates from a button instead of terminal commands.
- AI Hub checks for a newer release and shows a download bar when one is ready.
- Clicks reach the top buttons of a chat page, and the window moves from the tab bar.

## 1.3.0

- WireGuard configs are encrypted on disk, and a dropped tunnel blocks hub tabs instead of exposing your IP.
- A service can hold more than one account, and each service can use the tunnel or a direct connection.
- Compare can show two or three chats side by side and insert the task text without sending it.
