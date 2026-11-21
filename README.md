# World Cafe Vault

A personal, single-file web app for browsing World Cafe (WXPN) and related radio playlists, finding direct Spotify and YouTube Music links, and building playlists.

**Open the app:** https://jcreis3-oss.github.io/World-Cafe-Playlists/world-cafe-vault.html

## How it works

- Everything is in one file, `world-cafe-vault.html` (HTML, CSS and plain JavaScript, no build step).
- The library is imported from CSV files and stored only in your own browser (localStorage). Use the app's Backup / Restore to move it between devices.
- Optional connections:
  - **Spotify**: sign-in with PKCE (no client secret) to resolve links and create playlists.
  - **YouTube**: a YouTube Data API key for link lookups, and Google sign-in to create private playlists.

## What is *not* in this repository

No library data, API keys, client IDs, tokens or secrets. Each user enters their own Spotify Client ID, YouTube API key and Google OAuth Client ID in the app's settings, where they stay in that browser.
