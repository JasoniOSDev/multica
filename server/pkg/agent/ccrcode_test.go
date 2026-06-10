package agent

import "testing"

// ccrcode is a claude-compatible provider (it launches Claude Code via
// `ccr code`). These assertions pin the invariant that ccrcode inherits
// claude's behavior wherever the two are not deliberately distinct, so a
// future change to claude that forgets ccrcode fails here instead of silently
// shipping a half-wired runtime.
func TestCcrcodeReusesClaudeBackend(t *testing.T) {
	b, err := New("ccrcode", Config{ExecutablePath: "/usr/local/bin/multica-ccr-claude"})
	if err != nil {
		t.Fatalf("New(ccrcode) returned error: %v", err)
	}
	if _, ok := b.(*claudeBackend); !ok {
		t.Fatalf("New(ccrcode) = %T, want *claudeBackend", b)
	}
}

func TestCcrcodeLaunchHeader(t *testing.T) {
	if got := LaunchHeader("ccrcode"); got == "" {
		t.Fatal("LaunchHeader(ccrcode) is empty; runtimes need a launch preview")
	}
}

func TestCcrcodeInheritsClaudeTables(t *testing.T) {
	if MinVersions["ccrcode"] != MinVersions["claude"] {
		t.Fatalf("MinVersions[ccrcode]=%q, want claude's %q", MinVersions["ccrcode"], MinVersions["claude"])
	}
	claudeEnum, ok := providerThinkingEnums["claude"]
	if !ok {
		t.Fatal("providerThinkingEnums[claude] missing")
	}
	ccrEnum, ok := providerThinkingEnums["ccrcode"]
	if !ok {
		t.Fatal("providerThinkingEnums[ccrcode] missing; thinking-level validation would reject all values")
	}
	if len(ccrEnum) != len(claudeEnum) {
		t.Fatalf("providerThinkingEnums[ccrcode] has %d levels, claude has %d", len(ccrEnum), len(claudeEnum))
	}
	for level := range claudeEnum {
		if !ccrEnum[level] {
			t.Errorf("ccrcode thinking enum missing claude level %q", level)
		}
	}
}
