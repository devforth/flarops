package main

import "testing"

func TestParseSwap(t *testing.T) {
	total, used := parseSwap("MemTotal:  4000000 kB\nSwapTotal:   2048 kB\nSwapFree:     512 kB\n")
	if total != 2048*1024 || used != 1536*1024 {
		t.Fatalf("got total=%d used=%d", total, used)
	}
	if total, used := parseSwap("MemTotal: 1 kB\n"); total != 0 || used != 0 {
		t.Fatalf("no swap: got total=%d used=%d", total, used)
	}
}

// The page, the oracle's default and CI plan the next PR environment at the same size.
func TestNextEnvironmentMiB(t *testing.T) {
	d := &DashboardData{Hosts: []HostState{{Capsules: []CapsuleState{
		{ID: "shop-pr-3", Ram: 900},
		{ID: "shop-production", Ram: 600},
	}}}}
	if mib, _ := nextEnvironmentMiB(d); mib != 600 {
		t.Fatalf("with production measured: got %d, want production's 600", mib)
	}
	d.Hosts[0].Capsules[1].Ram = 10 // just started, not a measurement yet
	t.Setenv("FLAROPS_PR_ESTIMATE_MIB", "640")
	if mib, _ := nextEnvironmentMiB(d); mib != 640 {
		t.Fatalf("with production unmeasured: got %d, want CI's estimate, 640", mib)
	}
	t.Setenv("FLAROPS_PR_ESTIMATE_MIB", "")
	if mib, _ := nextEnvironmentMiB(d); mib != 900 {
		t.Fatalf("with no estimate either: got %d, want the largest, 900", mib)
	}
}
