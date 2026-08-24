import Foundation

/// The **suggested** exclude packs — the junk we know about but deliberately DON'T ship enabled, because
/// only some people have it. One place, read by both surfaces that offer them: the Settings shelf and the
/// deposit-time prompt (`previewDeposit` tags each item with the packs that would have caught it). The
/// daemon is the SSOT for these exactly as it is for `Journal.defaultExcludes` — the app fetches the list
/// and never keeps its own copy, so adding a pattern here reaches every surface at once (PILLAR3).
///
/// **Why these aren't defaults.** `Journal.defaultExcludes` is the junk *nobody* means to upload — a
/// `.DS_Store` is never someone's work. Everything below is junk only in context: a developer's `build/`
/// is regenerable in seconds, and a woodworker's `build/` folder is photographs of a workbench. Guessing
/// wrong in a backup product means silently not backing up someone's files, so we ask instead of assume.
///
/// Membership is DERIVED, never stored: a pack is "on" when its patterns are in the excludes list. There
/// is no pack row in the journal, so there is nothing to drift out of sync with the list the user actually
/// edits — remove one chip and the pack honestly reports itself partial.
public struct ExcludeSuggestion: Sendable, Encodable {
    /// Stable id — the wire handle the app sends back ("skip this pack"). Never shown to a user.
    public let id: String
    /// What this is, in the words someone would use for it themselves.
    public let title: String
    /// Why it's usually safe to skip. One sentence — it's the whole basis for the user's decision.
    public let detail: String
    public let patterns: [String]

    public static let all: [ExcludeSuggestion] = [
        ExcludeSuggestion(
            id: "dev",
            title: "Developer build folders",
            detail: "Code that gets rebuilt from source. It changes constantly, so it'd upload again every time.",
            patterns: ["dist", "build", "out", "target", "vendor", "Pods", "DerivedData", ".build", ".next",
                       ".nuxt", ".gradle", ".terraform", ".venv", "venv", "__pycache__", "*.pyc", "*.class", "*.o"]),
        ExcludeSuggestion(
            id: "vms",
            title: "Virtual machine disks",
            detail: "One VM is tens of gigabytes, and the whole file rewrites every time you boot it.",
            patterns: ["*.vmdk", "*.vdi", "*.qcow2", "*.vhd", "*.vhdx", "*.vbox", "*.hds"]),
        ExcludeSuggestion(
            id: "installers",
            title: "Installers and disk images",
            detail: "Apps and images you downloaded once and can download again.",
            patterns: ["*.dmg", "*.iso", "*.pkg", "*.msi", "*.deb", "*.rpm"]),
        ExcludeSuggestion(
            id: "backups",
            title: "Other backup software",
            detail: "Time Machine and disk-image backups — a backup of a backup, at full price.",
            patterns: ["Backups.backupdb", "*.sparsebundle", "*.sparseimage", "*.tib", "*.bkf"]),
        ExcludeSuggestion(
            id: "photoLibraries",
            title: "Photo libraries",
            detail: "coldstorage backs up photos through the Photos picker. Including the library too uploads every picture twice.",
            patterns: ["*.photoslibrary", "*.aplibrary", "*.migratedphotolibrary", "*.lrlibrary", "*.lrcat"]),
    ]

    /// Every suggested pattern, flattened — the candidate set a deposit walk tests against.
    public static var allPatterns: [String] { all.flatMap(\.patterns) }

    /// Which pack a suggested pattern belongs to (nil for a pattern that isn't one of ours — e.g. one the
    /// user typed by hand). Lets the walk report a bare matched pattern and the daemon fold it up to a pack.
    public static func packId(forPattern pattern: String) -> String? {
        all.first { $0.patterns.contains(pattern) }?.id
    }
}
