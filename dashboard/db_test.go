package main

import (
	"path/filepath"
	"testing"
	"time"
)

// The daily bars group samples by strftime('%d'), which reads only what sqlTime writes.
func TestSpendIsGroupedByDay(t *testing.T) {
	if err := initDB(filepath.Join(t.TempDir(), "d.db")); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	for i := 0; i < 60; i++ {
		ts := now.Add(-time.Duration(i) * time.Minute)
		if ts.Day() != now.Day() {
			break
		}
		recordHostSample(ts, "server", 0.6) // $0.01 a minute
		recordCapsuleSample(ts, "shop-production", "server", 100)
		recordCapsuleSample(ts, "shop-pr-5", "server", 100)
	}
	var minutes float64
	db.QueryRow(`SELECT COUNT(*) FROM host_samples`).Scan(&minutes)

	s, err := getSpendStats(0.6, 1)
	if err != nil {
		t.Fatal(err)
	}
	today := s.Cur[len(s.Cur)-1]
	if want := minutes * 0.01; today < want-1e-9 || today > want+1e-9 {
		t.Fatalf("today's bar = %v, want %v (one sample a minute at $0.60/h)", today, want)
	}
	// Two environments share the node, so each carries half of it.
	cost := getCapsulesCostLife(map[string]time.Time{"shop-pr-5": now.Add(-2 * time.Hour)})["shop-pr-5"]
	if want := minutes * 0.005; cost < want-1e-9 || cost > want+1e-9 {
		t.Fatalf("shop-pr-5 cost = %v, want %v", cost, want)
	}
}
