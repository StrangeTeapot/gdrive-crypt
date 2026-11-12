CODE EDITED BY AI

FORK OF [crypt-drive-sync by mooncodee](https://github.com/mooncodee/crypt-drive-sync)

# Google Drive+

End-to-end encrypted Obsidian vault synchronisation for Google Drive across Desktop (Windows, macOS, Linux) and Mobile (iOS, Android). Due to cross-platform nature of this fork, the sync flow is aimed at case insensitive systems, therefore does not provide an ability to save files in a format: Test.md and test.md in the same folder. Source code of this project can be modified to provide such functionality, so feel free to make your fork with such update.

Google Drive+ plugin performs pre-upload encryption on your device using the **Rclone crypt** standard (`XSalsa20-Poly1305` for file content and `AES-EME` for file/folder names with key derivation via `scrypt`). Google Drive stores only scrambled data—no note names, folder structures, or text are ever readable by third parties.

Because the encryption format strictly adheres to Rclone standards, your vault can be accessed, verified, or restored on any system using standard `rclone` commands without plugin lock-in. 

*Visual interface is also available via `rclone gui` command.*

### If you want to directly access your encrypted vault please refer to [rclone docs](https://rclone.org/docs/) or any other guide

> [!NOTE]
> I am not a developer of any level and do not pretend to be one. This plugin was built by AI (Gemini 3.6) on top of the [original](https://github.com/mooncodee/crypt-drive-sync) repo, i just modified it to the level that i needed for personal use. Always make a backup and proceed at your own risk!

---

## Features & Enhancements

* **Rclone-Compatible Encryption:** Full client-side zero-knowledge encryption prior to upload.
* **Vault Snapshots & Automated Backup Rotation:**
* Trigger **manual** unencrypted or crypt-stored full vault backups directly from the Obsidian Command Palette (`CTRL+P` / `CMD+P`).
* Auto-clean history keeping between 1 to 10 rolling snapshots (purges oldest backups automatically on Drive and locally).
* Flexible storage: save backups to remote folders (e.g., `_backups`) and/or local dot folders (e.g., `.backups`).


* **Nested Root Directory & Multi-Vault Support:**
* Define nested root paths on Google Drive (e.g., `backups/my-crypted-obsidian` or `folder1/folder2`).
* Automatic parent directory creation (`createRoot` support)—no manual folder pre-creation with rclone on Drive required.
* Multi-vault mapping cleanly isolates individual vaults in separate crypt paths.


* **Security & Privacy First:**
* Uses your own personal Google Cloud OAuth Client ID under the restricted `drive.file` scope. The plugin can only access files and folders it creates.
* Direct device-to-Google API communication with zero telemetry, zero analytics, and no intermediate servers.
* During settings export QR code is generated on your device via built-in code generator, no third-parties involved in the process, your tokens/secrets/keys are not leaving your device during the process.

* **Platform Native:** Operates seamlessly across desktop and mobile platforms inside Obsidian.
* **Multilanguage Support:** Legacy feature from original repo, you can add your translation into i18n.ts file. Main language is English, additional translations are provided/supported via auto-translation and user's efforts. 
* **Sync your plugins and themes!** Use "Sync dot-folder" toggle in advanced options. **Can break multi device sync! Read guide first**
* **Customisable notes/folders sync** filter your sync list via glob pattern or RegE strings (optional, advanced settings)
* **Settings export via QR codes or text string** Includes your login session token (valid for 1 hour since last sync by default). If you completed a setup on one vault you can export settings and almost seamlessly continue to work in a new vault. __Please check all fields after settings import before proceeding to sync!__
---

## How It Works

```text
Local Obsidian Vault ──> [ Client-Side Encryption ] ──> Google Drive (drive.file scope)
                               │                                │
                        (scrypt + XSalsa20)              (Scrambled Blob)
                               │                                │
                               └──────── Supported By ──────────┘
                                        Rclone Crypt CLI / GUI
```

### Remote Directory Tree & Data Layout

#### Single-Vault Structure (`rootPath: my-crypted-obsidian`)
```text


Google Drive (My Drive)
└── my-crypted-obsidian/                      <-- Plaintext Root Path (Visible on Drive UI)
    ├── _backups/                             <-- Vault Snapshot Storage Directory
    │   ├── Vault1/                           <-- Dedicated Backup Directory for Vault 1
    │       └── 2026-11-07_12-00-00_vault1.zip
    ├── _deleted/                             <-- Cloud Retention Trash
    │   ├── 2026-11-02_a8b9f1...              <-- Encrypted deleted files (safeguard against loss)
    │   └── 2026-11-04_c3d4e5...
    └── vaults/                               <-- Plaintext Vaults Container
        └── MyVault/                          <-- Dedicated Vault Directory
            ├── 7f9a2b1c4e8d...               <-- Scrambled folder name (e.g., "Projects")
            │   └── 3d5e7f1a9b2c...           <-- Scrambled note name (e.g., "Ideas.md")
            └── e4f5a6b7c8d9...               <-- Scrambled note name (e.g., "Index.md")
```

#### Multi-Vault Structure (`vault1`: `my-crypted-obsidian/vault1` | `vault2`: `my-crypted-obsidian/vault2`)

```text
Google Drive (My Drive)
└── my-crypted-obsidian/                      <-- Plaintext Root Path
    ├── _backups/                             <-- Vault Snapshot Storage Directory
    │   ├── Vault1/                           <-- Dedicated Backup Directory for Vault 1
    │   │   └── 2026-11-07_12-00-00_vault1.zip
    │   └── Vault2/                           <-- Dedicated Backup Directory for Vault 2
    │       └── 2026-11-07_12-05-00_vault2.zip
    ├── _deleted/                             <-- Cloud Retention Trash
    │   ├── 2026-11-02_a8b9f1...
    │   └── 2026-11-04_c3d4e5...
    └── vaults/                               <-- Plaintext Vaults Container
        ├── Vault1/                           <-- Dedicated Directory for Vault 1
        │   ├── 7f9a2b1c4e8d...               <-- Scrambled files for Vault 1
        │   └── e4f5a6b7c8d9...
        └── Vault2/                           <-- Dedicated Directory for Vault 2
            ├── 9x8y7z6w5v4u...               <-- Scrambled files for Vault 2
            └── 3t2s1r0q9p8o...
```

## Installation

### Community Plugins

1. Open **Obsidian Settings** => **Community plugins**.
2. Click **Browse** and search for **Google Drive+**.
3. Click **Install**, then **Enable**.

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release release assets.
2. Create a folder named `gdrive-crypt-red` inside your vault's plugin directory: `<vault>/.obsidian/plugins/gdrive-crypt-red/`.
3. Copy the downloaded files into that directory and restart Obsidian.

---

> [!IMPORTANT]
> Some feature are available via command palette only (ctrl+p/cmd+p) Please open command palette, type 'google drive+' to check available functions such as backup explorer/backup restore!


## Setup Guide

Setting up requires a one-time configuration of your own free Google Cloud OAuth Client ID (takes approximately 5 minutes).

### Step 1: Create a Google Cloud OAuth Client

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create a new project.
2. Enable the **Google Drive API** in the API Library.
3. Configure the **OAuth Consent Screen**:
* Select **External** user type.
* Enter your app name and contact email under Branding.
* Under **Audience**, click **Publish App** (publishing prevents your OAuth token from expiring every 7 days; only your Client ID will have access).


4. Go to **Credentials** $\rightarrow$ **Create Credentials** $\rightarrow$ **OAuth client ID**.
5. Select **TVs and Limited Input devices** as the Application Type, then copy your generated **Client ID** and **Client Secret**.

### Step 2: Configure the Plugin

1. Open **Obsidian Settings** $\rightarrow$ **Google Drive+**.
2. Input your **Client ID** and **Client Secret**.
3. Click **Sign In**—the plugin copies your auth code and opens `[google.com/device](https://google.com/device)`. Paste the code and click **Allow**.
4. Set your folder storage paths:
* **Root Path (`rootPath`):** Target Google Drive directory (e.g., `my-crypted-obsidian` or nested paths like `apps/obsidian/vault`).
* **Vault Folder (`folder`):** Target subfolder name inside the crypt root (default: your vault name).


5. Set your **Encryption Password** and **Salt**.

> **Important:** Your password and salt are stored in Obsidian's secret storage on your local device. They are never transmitted. **Lost passwords cannot be recovered.**

---

## Vault Snapshots & Backup Rotation

The plugin includes a **manual** vault snapshot engine designed for creating point-in-time archives of your vault.

### Triggering a Snapshot

1. Press `CTRL+P` (or `CMD+P` on macOS) to open the Command Palette.
2. Search for **"create encrypted backup now"** and press `Enter`.
3. The plugin generates a zip archive named with the current timestamp and places it in your designated backup directory (default: `_backups`).

### Configurable Rotation & Local Storage

* **Snapshot Retention (1 to 10):** Configure the maximum snapshot count in settings. When the limit is reached, the oldest snapshot on Google Drive (or locally) is automatically deleted.
* **Local Backups:** To keep backups on your local device without syncing them to Google Drive. Also the plugin automatically ignores all dot-folders during normal cloud sync.
* **Encryption Notice:** The archive itself is a standard zip file. When synced to Google Drive through an encrypted root path, it is encrypted on-the-fly like all other vault contents. __Local copy stored on your device is not encrypted at all!__

---

## Rclone Integration & Multi-Vault Setup

Because Google Drive+ uses standard Rclone crypt formatting, you can mount, browse, or sync your vault using Rclone CLI or Rclone GUI.

### Standard Single Vault `rclone.conf`

```ini
[gdrive]
type = drive
scope = drive.file
client_id = <YOUR_GOOGLE_CLIENT_ID>
client_secret = <YOUR_GOOGLE_CLIENT_SECRET>

[crypted]
type = crypt
remote = gdrive:my-crypted-obsidian
filename_encoding = base32
password = <YOUR_OBSCURED_PASSWORD>
password2 = <YOUR_OBSCURED_SALT> 

```

### Multi-Vault / Nested Path Setup

If you manage multiple vaults or place a vault inside a nested directory (e.g., `rootPath = my-crypted-obsidian/vault2`), configure dedicated crypt remotes for each vault in `rclone.conf`:

```ini
[gdrive]
type = drive
scope = drive.file
client_id = <YOUR_GOOGLE_CLIENT_ID>
client_secret = <YOUR_GOOGLE_CLIENT_SECRET>

# Remote for Vault 1 (Root: my-crypted-obsidian)
[vault1-crypt]
type = crypt
remote = gdrive:my-crypted-obsidian
password = <YOUR_OBSCURED_PASSWORD>
password2 = <YOUR_OBSCURED_SALT>

# Remote for Vault 2 (Root: my-crypted-obsidian/vault2)
[vault2-crypt]
type = crypt
remote = gdrive:my-crypted-obsidian/vault2
password = <YOUR_OBSCURED_PASSWORD>
password2 = <YOUR_OBSCURED_SALT>

```

### Important `drive.file` Scope Rules

1. **Shared Client ID Required:** Under Google's restricted `drive.file` scope, Rclone can only view files created by the plugin if both Rclone and the plugin use the **exact same OAuth Client ID**.
2. **Uploading via Rclone:** Always use `rclone copy` rather than `rclone move` when pushing files to Google Drive. An `rclone copy` generates new server-side objects under your Client ID, ensuring the plugin retains permission to manage them.
3. **Directory Visibility:** In raw Google Drive view (`gdrive:`), root path folders (e.g., `my-crypted-obsidian` and `vault2`) appear in plaintext so navigation paths can resolve. All contents inside those folders are fully encrypted. Opening the crypt remotes (`vault1-crypt:` or `vault2-crypt:`) automatically decrypts the directory contents on the fly via rclone gui or compatible.

---

## Security & Disclosures

* **Network Traffic:** The plugin communicates exclusively with official Google API endpoints:
* [https://oauth2.googleapis.com](https://oauth2.googleapis.com) — POST /device/code and POST /token for Google OAuth 2.0 device sign-in and refreshing access tokens.
* [https://www.googleapis.com/drive/v3](https://www.googleapis.com/drive/v3) — /files, /files/{id}, /changes, and /changes/startPageToken for listing files, creating folders, reading metadata, downloading, moving/trashing, and incremental Changes API sync.
* [https://www.googleapis.com/upload/drive/v3](https://www.googleapis.com/upload/drive/v3) — /files and /files/{id} for multipart and resumable encrypted file uploads.
* Browser sign-in page (window.open) — Opens the verification_url / verification_uri returned by Google's /device/code response in your browser when you click the login button
* No third-party servers — QR code export generation runs 100% offline locally, and no telemetry, analytics, or external relay hosts are contacted.


* **Scope Isolation:** Requests only `[https://www.googleapis.com/auth/drive.file](https://www.googleapis.com/auth/drive.file)`. The plugin has zero visibility or access to the rest of your Google Drive.
* **Vault Isolation:** Access is strictly bounded to the active Obsidian vault directory. Dot-folders (such as `.obsidian` or `.backups`) are excluded from general cloud sync.
* **Clipboard Interaction:** The plugin only writes to the system clipboard when copying the device sign-in code during initial setup. It never reads clipboard data.

---

## Building from Source

```bash
# Install dependencies
npm install

# Run byte-for-byte rclone compatibility tests
npm test

# Lint test
npm run lint

# Build production bundle
npm run build

```

### Pre-Baking Client Credentials (Optional)

For private custom builds, place your Google Cloud OAuth JSON file (`google-client.json`) in the project root next to `package.json` before running `npm run build`. The build script will embed the client credentials into `main.js`, allowing users of your build to skip manual OAuth app creation.

---
## Cheat sheet
### Glob pattern exlcude sync files
|**Pattern**|**Scope**|**Example**|**Result**|
|---|---|---|---|
|`**/*.ext`|Everywhere|`**/*.mp4`|Ignores all `.mp4` video files anywhere in the vault|
|`Folder/**`|Vault Root|`Private/**`|Ignores the `Private/` folder and everything inside it|
|`**/Folder/**`|Subdirectories|`**/Archive/**`|Ignores any folder named `Archive` at any depth|
|`**/file.ext`|Specific File|`**/config.json`|Ignores any file named `config.json` anywhere in the vault|
|`*.tmp`|Root Only|`*.tmp`|Ignores `.tmp` files located only at the vault root|

#### Common examples
```plaintext
# Media & Heavy Files
**/*.mp4
**/*.mkv
**/*.pdf

# Private & Work-in-Progress Folders
Private/**
**/Drafts/**
**/Personal/**

# Temporary & Cache Files
**/*.tmp
**/*.bak
**/*.DS_Store
```
### RegEx strings/pattern
|**Pattern**|**Scope**|**Example**|**Result**|
|---|---|---|---|
|`\.ext$`|File Extension|`\.mp4$`|Ignores all `.mp4` files anywhere in the vault|
|`^Folder/`|Root Directory|`^Private/`|Ignores the `Private/` folder strictly at the vault root|
|`/Folder/`|Directory Anywhere|`/Drafts/`|Ignores any directory named `Drafts` at any path depth|
|`/(A\|B)/`|Multiple Alternatives|`/(Temp\|Cache)/`|Ignores any directory named `Temp` or `Cache`|
|`^\.` or `/\.`|Hidden Files / Dot-Folders|`^\.`|Ignores dot-files and dot-folders (e.g., `.obsidian`)|
|`(?i)\.ext$`|Case-Insensitive|`(?i)\.(jpg\|png)$`|Ignores `.jpg`, `.JPG`, `.png`, `.PNG` files|

#### Common examples
```text
# Media & Heavy Binary Archives
\.(mp4|mkv|avi|mov|zip|tar\.gz)$

# Root Directories Only
^Private/
^LocalOnly/

# Directories at Any Depth
/(Drafts|Templates|Cache|Node_modules)/

# Specific File Names Anywhere
(^|/)desktop\.ini$
(^|/)\.DS_Store$

# Case-Insensitive Extensions
(?i)\.(png|jpg|jpeg|gif|pdf)$
```

---

## License & Acknowledgements

This project is licensed under the [MIT License](https://www.google.com/search?q=LICENSE).

**Upstream Credits:**
Forked and extended from [crypt-drive-sync](https://github.com/mooncodee/crypt-drive-sync) by [mooncodee](https://github.com/mooncodee).
