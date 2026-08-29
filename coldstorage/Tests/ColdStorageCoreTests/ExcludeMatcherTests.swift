import Testing
import Foundation
@testable import ColdStorageCore

/// The exclude semantics are load-bearing: they decide what never gets uploaded. These pin the glob
/// engine + the name-vs-path rules + the scan-time `LocalDirSource` walk wiring against real inputs.
@Suite struct ExcludeMatcherTests {

    // MARK: glob primitive
    @Test func globLiteralsStarQuestion() {
        #expect(ExcludeMatcher.glob("*.tmp", matches: "scratch.tmp"))
        #expect(ExcludeMatcher.glob("*.tmp", matches: ".tmp"))            // `*` matches empty
        #expect(!ExcludeMatcher.glob("*.tmp", matches: "tmp"))           // needs the dot
        #expect(ExcludeMatcher.glob("IMG_????.JPG", matches: "IMG_0042.JPG"))
        #expect(!ExcludeMatcher.glob("IMG_????.JPG", matches: "IMG_42.JPG"))   // `?` is exactly one
        #expect(ExcludeMatcher.glob("node_modules", matches: "node_modules"))
        #expect(!ExcludeMatcher.glob("node_modules", matches: "node_modulesX"))
        #expect(ExcludeMatcher.glob("a*b*c", matches: "axxbyyc"))        // multiple stars backtrack
        #expect(!ExcludeMatcher.glob("a*b*c", matches: "axxbyy"))
    }

    // MARK: name patterns match at any depth
    @Test func bareNameMatchesAtEveryLevel() {
        let m = ExcludeMatcher(patterns: ["node_modules", ".DS_Store"])
        #expect(m.matches("node_modules"))                               // the dir itself
        #expect(m.matches("node_modules/react/index.js"))               // a descendant
        #expect(m.matches("app/ui/node_modules/pkg/x.ts"))              // nested anywhere
        #expect(m.matches("photos/.DS_Store"))
        #expect(!m.matches("src/app.ts"))
        #expect(!m.matches("my_node_modules_backup/x"))                 // component must match whole
    }

    @Test func globNamePatternByComponent() {
        let m = ExcludeMatcher(patterns: ["*.tmp"])
        #expect(m.matches("a/b/c.tmp"))
        #expect(m.matches("c.tmp"))
        #expect(!m.matches("c.tmpx"))
        #expect(!m.matches("notes.txt"))
    }

    // MARK: patterns containing a slash anchor to the whole path
    @Test func slashPatternAnchorsToFullPath() {
        let m = ExcludeMatcher(patterns: ["build/cache"])
        #expect(m.matches("build/cache"))
        #expect(!m.matches("x/build/cache"))                            // anchored — not "at any depth"
        let wild = ExcludeMatcher(patterns: ["build/*"])
        #expect(wild.matches("build/out.o"))
    }

    @Test func emptyAndTrailingSlashAndDefaults() {
        #expect(!ExcludeMatcher(patterns: []).matches("anything"))      // no patterns → nothing excluded
        #expect(ExcludeMatcher(patterns: ["caches/"]).matches("app/caches/x"))  // trailing slash tolerated
        // The product defaults behave as intended on representative junk.
        let def = ExcludeMatcher(patterns: Journal.defaultExcludes)
        #expect(def.matches("proj/node_modules/lib/a.js"))
        #expect(def.matches(".git/HEAD"))
        #expect(def.matches("Photos/.DS_Store"))
        #expect(def.matches("tmp/build.tmp"))
        #expect(!def.matches("Photos/2024/beach.jpg"))                  // a real file survives
    }

    // MARK: scan-time wiring — LocalDirSource excludes DURING the walk (real filesystem, so junk like
    // node_modules is pruned before it's ever hashed; that pruning is the whole point of excludes).
    @Test func localDirSourceExcludesDuringWalk() async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("cs-exc-walk-\(UUID().uuidString)")
        try fm.createDirectory(at: root.appendingPathComponent("node_modules/dep"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent("sub"), withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        try "keep".write(to: root.appendingPathComponent("keep.jpg"), atomically: true, encoding: .utf8)
        try "real".write(to: root.appendingPathComponent("sub/photo.txt"), atomically: true, encoding: .utf8)
        try "junk".write(to: root.appendingPathComponent("node_modules/dep/index.js"), atomically: true, encoding: .utf8)
        try "tmp".write(to: root.appendingPathComponent("scratch.tmp"), atomically: true, encoding: .utf8)
        try "ds".write(to: root.appendingPathComponent(".DS_Store"), atomically: true, encoding: .utf8)

        let src = LocalDirSource(root: root, exclude: ExcludeMatcher(patterns: Journal.defaultExcludes))
        let kept = try await src.enumerate().map(\.relativePath).sorted()
        #expect(kept == ["keep.jpg", "sub/photo.txt"])   // real files survive; node_modules/*.tmp/.DS_Store gone

        // No excludes → everything is walked (proves the filter is what dropped them, not the walk).
        let unfiltered = try await LocalDirSource(root: root).enumerate().map(\.relativePath)
        #expect(unfiltered.contains("node_modules/dep/index.js"))
    }

    // MARK: case-insensitivity — the filesystem's rule, not ours
    // This is the regression that made the fix necessary: `caches` shipped as a default from day one and
    // could never fire, because every Mac spells the directory `Library/Caches`.
    @Test func matchingIsCaseInsensitive() {
        let m = ExcludeMatcher(patterns: ["caches", "*.tmp"])
        #expect(m.matches("Library/Caches/x.db"))
        #expect(m.matches("library/CACHES/x.db"))
        #expect(m.matches("scratch.TMP"))
        #expect(ExcludeMatcher(patterns: Journal.defaultExcludes).matches("app/Library/Caches/big.bin"))
        #expect(!m.matches("Photos/cached-memories.jpg"))   // still a whole-component match, not substring
    }

    @Test func firstMatchNamesTheReason() {
        let m = ExcludeMatcher(patterns: ["node_modules", "*.tmp"])
        #expect(m.firstMatch("a/node_modules/b.js") == "node_modules")
        #expect(m.firstMatch("a/b.tmp") == "*.tmp")
        #expect(m.firstMatch("a/b.jpg") == nil)
    }

    // MARK: suggestions tag the walk WITHOUT filtering it
    // The guarantee the deposit prompt rests on: previewing with suggestions must return the same files as
    // previewing without them. If a suggestion ever pruned, the app would be skipping files it only meant
    // to ASK about — silently not backing something up, which is the one failure this product can't have.
    @Test func suggestionsTagButNeverFilter() async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("cs-sugg-\(UUID().uuidString)")
        try fm.createDirectory(at: root.appendingPathComponent("proj/dist"), withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        try "art".write(to: root.appendingPathComponent("photo.jpg"), atomically: true, encoding: .utf8)
        try "js".write(to: root.appendingPathComponent("proj/dist/bundle.js"), atomically: true, encoding: .utf8)
        try "vm".write(to: root.appendingPathComponent("box.vmdk"), atomically: true, encoding: .utf8)

        let suggest = ExcludeMatcher(patterns: ExcludeSuggestion.allPatterns)
        let tagged = try LocalDirSource(root: root, suggest: suggest).walk().entries
        let plain = try LocalDirSource(root: root).walk().entries
        #expect(tagged.map(\.relativePath).sorted() == plain.map(\.relativePath).sorted())  // same file set

        let by = Dictionary(uniqueKeysWithValues: tagged.map { ($0.relativePath, $0.suggestedBy) })
        #expect(by["photo.jpg"] == .some(nil))                 // real work is never tagged
        #expect(by["proj/dist/bundle.js"] == "dist")           // tagged by the folder, matched per-component
        #expect(by["box.vmdk"] == "*.vmdk")
    }

    // The deposit preview is where the tag has to survive to — it's the only thing the prompt reads.
    @Test func depositPreviewCarriesTheSuggestion() async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("cs-sugg-prev-\(UUID().uuidString)")
        try fm.createDirectory(at: root.appendingPathComponent("build"), withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        try "keep".write(to: root.appendingPathComponent("notes.txt"), atomically: true, encoding: .utf8)
        try "junk".write(to: root.appendingPathComponent("build/app.o"), atomically: true, encoding: .utf8)

        let src = ExplicitPathsSource(entries: [.init(url: root, destDir: "Drop")],
                                      suggest: ExcludeMatcher(patterns: ExcludeSuggestion.allPatterns))
        let preview = try await src.previewPaths()
        let by = Dictionary(uniqueKeysWithValues: preview.paths.map { ($0.relativePath, $0.suggestedBy) })
        #expect(by["Drop/\(root.lastPathComponent)/notes.txt"] == .some(nil))
        #expect(by["Drop/\(root.lastPathComponent)/build/app.o"] == "build")
    }

    // MARK: the suggestion catalogue's own invariants
    @Test func suggestionCatalogueIsWellFormed() {
        let all = ExcludeSuggestion.allPatterns
        #expect(Set(all).count == all.count)                              // no pattern in two packs…
        #expect(Set(ExcludeSuggestion.all.map(\.id)).count == ExcludeSuggestion.all.count)
        // …and none is ALREADY a default. A suggested pattern that ships enabled can never be offered, and
        // its pack would render permanently half-on with no way for the user to complete it.
        #expect(Set(all).isDisjoint(with: Set(Journal.defaultExcludes)))
        for pack in ExcludeSuggestion.all {
            #expect(!pack.patterns.isEmpty)
            for pattern in pack.patterns { #expect(ExcludeSuggestion.packId(forPattern: pattern) == pack.id) }
        }
    }
}
