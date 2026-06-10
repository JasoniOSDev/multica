package agent

// ccrcode is claude-code-router (`ccr code`) exposed as a first-class,
// claude-compatible provider so a single daemon can register BOTH a native
// `claude` runtime and a `ccrcode` runtime at once (the two-daemon workaround
// is no longer needed). ccr code speaks the Claude Code CLI surface and the
// stream-json protocol, so ccrcode reuses the claude backend (see agent.go)
// and the claude branch of every provider switch (models, skills layout,
// CLAUDE.md target, thinking levels, default args).
//
// The only places ccrcode differs from claude are identity-level: its provider
// key, its launch header, and its executable (a generated `ccr code` wrapper,
// see daemon.ensureCcrcodeWrapper). The claude-keyed lookup tables that are not
// expressed as switch statements are aliased here so the two providers cannot
// drift: whatever claude's values are, ccrcode inherits them.
func init() {
	if v, ok := MinVersions["claude"]; ok {
		MinVersions["ccrcode"] = v
	}
	if enum, ok := providerThinkingEnums["claude"]; ok {
		providerThinkingEnums["ccrcode"] = enum
	}
}
