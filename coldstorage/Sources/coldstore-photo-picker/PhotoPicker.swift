// coldstore-photo-picker — the native Photos picker for the explicit photo-deposit path (UI option B).
//
// Presents the system `PHPickerViewController` and prints the user's selection as a one-line JSON array of
// {id, name} objects (id = PHAsset localIdentifier; name = suggested filename for an instant UI row label),
// then exits. Electron's main process spawns this, shows optimistic rows from the names, and hands the ids
// to the daemon's `depositPhotos` command.
//
// Why a separate helper (not Electron, not the daemon):
//   • Electron/Chromium can't host an AppKit view controller, and PhotoKit has no JS binding.
//   • The picker is OUT-OF-PROCESS and privacy-preserving: presenting it needs NO Photos authorization
//     and no TCC grant — so this helper needs neither entitlements nor codesigning. (Confirmed: WWDC22
//     "What's new in the Photos picker"; macOS 13+ ships PHPickerViewController as an NSViewController.)
//   • `assetIdentifier` is non-nil ONLY because the config is built with `photoLibrary: .shared()` —
//     without it the picker returns opaque copies, not library identifiers (BiTE Interactive, Apple docs).
//   • The DAEMON (which holds the durable full TCC grant — see phase0-photos-spike) resolves these ids to
//     full-res originals via `PhotoKitResolver`. The picked ids are plain PHAsset localIdentifiers, usable
//     by any authorized process.
//
// Cancel / pick-nothing both arrive as `didFinishPicking` with empty results → we print `[]` → the caller
// treats it as a no-op. Exit code is 0 on a normal finish (incl. cancel); non-zero only on a hard failure.

#if canImport(AppKit) && canImport(PhotosUI)
import AppKit
import PhotosUI

@MainActor
final class PickerCoordinator: NSObject, PHPickerViewControllerDelegate, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?
    private var emitted = false   // guard: Cancel/Add AND window-close can both try to finish — emit once.

    func applicationDidFinishLaunching(_ notification: Notification) {
        var config = PHPickerConfiguration(photoLibrary: .shared())  // .shared() ⇒ non-nil assetIdentifier
        config.filter = .images                                      // photos only (V1 — videos are a later lane)
        config.selectionLimit = 0                                    // 0 = unlimited multi-select
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self

        // The picker IS the window's content (not a sheet on a tiny host) — so it renders at full size and
        // its own Cancel/Add buttons drive the delegate normally. A real, centered, focused window.
        let win = NSWindow(contentViewController: picker)
        win.styleMask = [.titled, .closable]
        win.title = "Add Photos"
        win.setContentSize(NSSize(width: 840, height: 560))
        win.delegate = self
        win.center()
        window = win

        NSApp.activate(ignoringOtherApps: true)   // pull the picker to the front over the app that spawned it
        win.makeKeyAndOrderFront(nil)
        win.orderFrontRegardless()
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        // Emit {id, name} per pick: the id drives the daemon deposit; the suggested name lets the UI show a
        // real-ish row label IMMEDIATELY (optimistic "uploading" row) before the daemon resolves the true
        // filename. nil assetIdentifier shouldn't happen with .shared(); a nil name falls back to "Photo".
        emit(results.compactMap { r in
            r.assetIdentifier.map { ["id": $0, "name": r.itemProvider.suggestedName ?? "Photo"] }
        })
    }

    // Closing the window (red button / ⌘W) with nothing picked is a cancel → emit [] so the caller unblocks.
    func windowWillClose(_ notification: Notification) { emit([]) }

    private func emit(_ picks: [[String: String]]) {
        guard !emitted else { return }
        emitted = true
        let json = (try? JSONSerialization.data(withJSONObject: picks))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        print(json)
        fflush(stdout)   // ensure the parent reads it before we exit
        NSApp.terminate(nil)
    }
}

@main
struct PhotoPicker {
    @MainActor static func main() {
        let app = NSApplication.shared
        // .accessory: a focused window with NO dock icon / menu-bar app — so it reads as the app's picker,
        // not a separate application. Accessory apps can still own a key window and take keyboard focus.
        app.setActivationPolicy(.accessory)
        let coordinator = PickerCoordinator()
        app.delegate = coordinator
        app.run()
    }
}

#else   // non-macOS: the picker can't exist; fail loudly so a caller never silently gets no photos.
import Foundation

@main
struct PhotoPicker {
    static func main() {
        FileHandle.standardError.write(Data("coldstore-photo-picker: requires macOS (AppKit + PhotosUI)\n".utf8))
        exit(1)
    }
}
#endif
