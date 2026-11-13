# Teams Simulated People

Fill a Microsoft Teams demo meeting with realistic, **clearly labelled simulated attendees** when real colleagues aren't available.

Enter a Meeting ID and Passcode, choose how many people (1–12), and that many simulated participants join the call as web guests, each showing a looping, front-facing headshot video.

![Web UI](docs/images/web-ui.png)

## What it does

- **Web UI** with Meeting ID, Passcode and a 1–12 people-count dropdown.
- **Automatic web join**: opens Teams in the browser (no "open desktop app" prompt) and joins as an anonymous guest.
- **No audio**: each attendee picks "No audio" on the pre-join screen for a smooth, silent join.
- **12 diverse personas**: 6 women and 6 men, multiracial and business-aligned, each with a natural looping video clip.
- **Watermark**: every video carries *"Teams Demo - these are not real people"*, so nobody is misled.
- **Remove all** button to make everyone leave after the demo.

![Simulated attendees](docs/images/simulated-attendees-gallery.png)

## How it works

1. Each persona is a separate Edge window driven by [Playwright](https://playwright.dev/).
2. The window joins `https://teams.microsoft.com/v2/?meetingjoin=true#/meet/<id>?p=<passcode>&anon=true`.
3. Chromium's fake-camera flags (`--use-file-for-fake-video-capture`) feed a pre-built, looping MJPEG clip in as the webcam.
4. Joins are staggered by about 2.5 s to look natural.

## Requirements

- Windows 10/11 with Microsoft Edge
- Node.js LTS (the installer adds it through winget if missing)
- A Teams meeting that **allows anonymous (guest) join**. The host may need to admit guests from the lobby.

## Install and run

```powershell
git clone https://github.com/loudy69/Teams-Simulated-People
cd Teams-Simulated-People
.\Install.cmd      # installs Node (if needed) and dependencies
.\Start.cmd        # starts the service and opens http://localhost:3000
```

### Video clips

Clips are not stored in this repo, because they are third-party stock footage. To build them:

```powershell
winget install Gyan.FFmpeg
npm run import-clips   # place or download source clips into clips\raw
npm run convert        # builds clips\p01-p12.mjpeg with the watermark
```

Source footage came from [Mixkit](https://mixkit.co/license/#videoFree) (free licence). Check the licence before reuse.
To change the watermark text, edit `scripts/make-watermark.js`, delete `clips/watermark.png`, and re-run `npm run convert`.

## Project layout

| Path | Purpose |
|---|---|
| `server.js` | Express API and Playwright join logic |
| `public/index.html` | Web UI |
| `personas.json` | The 12 personas |
| `scripts/` | Clip conversion and watermark tooling |
| `install.ps1`, `Install.cmd`, `Start.cmd` | Installer and launcher |

## Responsible use

For demos and testing only. Join only meetings you own or are authorised to use, and keep the watermark on. The attendees are not real people and must not be used to deceive.
Microsoft Teams and Microsoft are trademarks of Microsoft. This is an unofficial demo tool; the join flow relies on the Teams web UI and may need updating when it changes.
