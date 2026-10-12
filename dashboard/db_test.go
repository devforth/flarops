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
		recordHostSample(ts, HostState{ID: "server", Rate: 0.6, PriceKnown: true}) // $0.01 a minute
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

// Minutes counted at the fallback EC2 price get the real one once the price feed knows it.
func TestFallbackPriceIsCorrected(t *testing.T) {
	if err := initDB(filepath.Join(t.TempDir(), "d.db")); err != nil {
		t.Fatal(err)
	}
	h := HostState{ID: "server", Type: "t3a.medium", Region: "us-west-2", EC2Rate: fallbackEC2HourlyRate, Rate: fallbackEC2HourlyRate + 0.01}
	recordHostSample(time.Now(), h)

	awsPricesMutex.Lock()
	saved := awsPrices
	awsPrices = map[string]map[string]float64{"t3a.medium": {"us-west-2": 0.0376}}
	awsPricesMutex.Unlock()
	defer func() { awsPricesMutex.Lock(); awsPrices = saved; awsPricesMutex.Unlock() }()

	if n, err := repriceSamples(); err != nil || n != 1 {
		t.Fatalf("repriced %d samples (err %v), want 1", n, err)
	}
	var rate float64
	db.QueryRow(`SELECT rate_per_hour FROM host_samples`).Scan(&rate)
	if want := 0.0376 + 0.01; rate < want-1e-9 || rate > want+1e-9 {
		t.Fatalf("rate = %v, want %v", rate, want)
	}
	if n, _ := repriceSamples(); n != 0 {
		t.Fatalf("a second pass repriced %d samples, want none", n)
	}
}
