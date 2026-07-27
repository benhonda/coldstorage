import Testing
import Foundation

/// **A memory measurement that the runner has already invalidated must refuse to run, not report a number.**
///
/// A handful of tests assert on THIS process's own resident memory — the only way to catch an unbounded
/// stream buffer, since a file held entirely in RAM produces byte-identical output to one streamed properly
/// and every functional assertion passes while it happens.
///
/// That measurement is only meaningful when nothing else in the process is allocating. Swift Testing runs
/// suites concurrently by default, and `ZeroKnowledgeKeysTests` exercises Argon2id at production tuning — a
/// deliberately memory-HARD KDF. Run in parallel, its hundreds of MiB land inside the window the memory tests
/// are measuring, and they fail with a number that describes the neighbour rather than the code under test.
/// That is why `--no-parallel` is load-bearing in `task daemon:test`, not a speed knob.
///
/// The failure mode this guard closes is the CONFUSING one: someone runs `swift test` bare, watches these
/// tests fail two runs in five with a plausible-looking "peaked at 225 MiB", and concludes the engine leaks —
/// or, worse, writes the flake off as noise and stops trusting the suite. Neither reading is true, and the
/// number on screen supports both. So refuse the measurement outright and name the fix instead.
///
/// The signal is the test binary's OWN argv: SwiftPM forwards the flag verbatim to the runner, so the process
/// can see how it was invoked. Absence is treated as parallel, which errs toward refusing rather than toward
/// publishing a garbage number.
///
/// **The one maintenance burden, stated honestly:** this flag is a literal in two places that no compiler
/// links — here, and the `swift test` line in the root `Taskfile.yml`. Swift Testing exposes no public API for
/// "am I running in parallel", and a test target cannot read the Taskfile, so there is no SSOT to point both
/// at (PILLAR3 conceded, not achieved). Each side carries a comment naming the other; if Swift Testing ever
/// renames the flag, both must move together. The failure is at least loud rather than silent: a renamed flag
/// means every memory test refuses, not that they quietly resume measuring noise.
struct MeasuresProcessMemoryTrait: TestTrait, SuiteTrait {
    /// The flag whose presence in argv means the runner is serial. Referenced by the refusal message too, so
    /// it is spelled exactly once on the Swift side.
    static let serialFlag = "--no-parallel"

    /// Applies to every test inside an annotated `@Suite`, so a memory test added later is covered by default
    /// rather than by remembering to annotate it.
    var isRecursive: Bool { true }

    func prepare(for test: Test) async throws {
        guard !CommandLine.arguments.contains(Self.serialFlag) else { return }
        throw ConcurrentExecutionInvalidatesMeasurement(testName: test.name)
    }
}

/// Thrown instead of measuring. The message is the whole point — it has to leave someone who has never seen
/// this before knowing both why the number would have been wrong and which command produces a right one.
struct ConcurrentExecutionInvalidatesMeasurement: Error, CustomStringConvertible {
    let testName: String

    var description: String {
        """
        \(testName) measures THIS process's resident memory, and the test runner is in PARALLEL mode — \
        whatever another suite allocates would be counted as this test's footprint. (ZeroKnowledgeKeysTests \
        runs Argon2id at production tuning, a memory-hard KDF worth hundreds of MiB; concurrently it has \
        reported a 260 MiB "leak" that was entirely its own.) Refusing to measure rather than report a \
        number that means nothing. Run `task daemon:test` — it passes \
        \(MeasuresProcessMemoryTrait.serialFlag), which is required for these tests and not a speed knob.
        """
    }
}

extension Trait where Self == MeasuresProcessMemoryTrait {
    /// Marks a test (or a whole suite) as asserting on this process's resident memory, which is only valid
    /// when the runner is serial. See `MeasuresProcessMemoryTrait`.
    static var measuresProcessMemory: Self { Self() }
}
