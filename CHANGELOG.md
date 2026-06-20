# Changelog

## 2026-06-19

- chore: devcontainer (Swift toolchain + firewall init), root `.gitignore`, and `Taskfile.yml` task runner.
- chore: agent/skill config — `.claude` + `.agents` skill installs, `skills-lock.json`, `CLAUDE.md` engineering guidelines.
- feat: ColdStorage Swift package — `coldstored` daemon, `coldstore-cli`/`coldstore-restore` CLIs, `ColdStorageCore` (upload/restore engines, S3 store, crypto, journal) + `ColdStorageMac` PhotoKit source.
- feat: phase-0 spikes — `phase0-photos-spike` (Photos library access) and `phase0-upload-spike` (S3 upload).
- docs: `ROADMAP.md`, `UPLOAD-DAEMON-DESIGN.md`, and `daemon-module-split.md` planning docs.
- feat: `coldstored` control plane — unix-socket JSONL IPC (`ControlServer`/`ControlClient`) + pushed `EventBus`, driven by new `coldstorectl`; sources are now a journal-backed registry (SSOT).
- feat: `coldstored` launchd LaunchAgent template + `daemon:install`/`daemon:uninstall`/`daemon:run`/`daemon:ctl` tasks; Mac `FolderWatcher` (FSEvents) wired but un-run off-Mac.
