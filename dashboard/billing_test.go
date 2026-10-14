package main

import (
	"path/filepath"
	"testing"
	"time"
)

func near(got, want float64) bool { return got > want-1e-9 && got < want+1e-9 }

// A sample bills the time since the previous one, not a flat minute, and repricing keeps that.
func TestSamplesBillTheirElapsedTime(t *testing.T) {
	if err := initDB(filepath.Join(t.TempDir(), "d.db")); err != nil {
		t.Fatal(err)
	}
	ts := time.Now().UTC()
	if ts.Day() == 1 && ts.Hour() == 0 && ts.Minute() < 5 {
		t.Skip("too close to the start of the month")
	}
	h := HostState{ID: "server", Type: "t3a.medium", Region: "us-west-2", EC2Rate: fallbackEC2HourlyRate, Rate: 3.6}
	recordHostSample(ts.Add(-2*time.Minute), time.Minute, h)     // $0.06
	recordHostSample(ts.Add(-30*time.Second), 90*time.Second, h) // $0.09
	recordCapsuleSample(ts.Add(-2*time.Minute), "shop-production", "server", 100)
	recordCapsuleSample(ts.Add(-30*time.Second), "shop-production", "server", 100)
	recordCapsuleSample(ts.Add(-30*time.Second), "shop-pr-5", "server", 100)

	s, _ := getSpendStats(3.6, 1)
	if !near(s.Mtd, 0.15) {
		t.Fatalf("MTD = %v, want 0.15", s.Mtd)
	}
	if today := s.Cur[len(s.Cur)-1]; ts.Add(-2*time.Minute).Day() == ts.Day() && !near(today, 0.15) {
		t.Fatalf("today = %v, want 0.15", today)
	}
	cost := getCapsulesCostLife(map[string]time.Time{"shop-production": ts.Add(-time.Hour), "shop-pr-5": ts.Add(-time.Hour)})
	if !near(cost["shop-production"], 0.06+0.045) || !near(cost["shop-pr-5"], 0.045) {
		t.Fatalf("environment costs = %v, want production 0.105 and pr-5 0.045", cost)
	}

	awsPricesMutex.Lock()
	saved := awsPrices
	awsPrices = map[string]map[string]float64{"t3a.medium": {"us-west-2": fallbackEC2HourlyRate + 3.6}}
	awsPricesMutex.Unlock()
	defer func() { awsPricesMutex.Lock(); awsPrices = saved; awsPricesMutex.Unlock() }()
	if _, err := repriceSamples(); err != nil {
		t.Fatal(err)
	}
	if s, _ := getSpendStats(7.2, 1); !near(s.Mtd, 0.30) {
		t.Fatalf("MTD after repricing = %v, want 0.30 (rate doubled, elapsed kept)", s.Mtd)
	}
}

// A database from before elapsed_sec gets the column, its rows counting as the minute they meant.
func TestOldSamplesCountAsAMinute(t *testing.T) {
	path := filepath.Join(t.TempDir(), "d.db")
	if err := initDB(path); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`ALTER TABLE host_samples DROP COLUMN elapsed_sec`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO host_samples (timestamp, host_id, rate_per_hour) VALUES (?, 'server', 0.6)`, sqlTime(time.Now())); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if err := initDB(path); err != nil {
		t.Fatal(err)
	}
	var elapsed float64
	if err := db.QueryRow(`SELECT elapsed_sec FROM host_samples`).Scan(&elapsed); err != nil || elapsed != 60 {
		t.Fatalf("elapsed_sec = %v (err %v), want 60", elapsed, err)
	}
}

// A write waits out a long read rather than failing with SQLITE_BUSY.
func TestDatabaseWaitsInsteadOfFailingBusy(t *testing.T) {
	if err := initDB(filepath.Join(t.TempDir(), "d.db")); err != nil {
		t.Fatal(err)
	}
	var timeout int
	var mode string
	db.QueryRow(`PRAGMA busy_timeout`).Scan(&timeout)
	db.QueryRow(`PRAGMA journal_mode`).Scan(&mode)
	if timeout != 5000 || mode != "wal" {
		t.Fatalf("busy_timeout=%d journal_mode=%q, want 5000 and wal", timeout, mode)
	}
}

func TestPrevMonthWindow(t *testing.T) {
	at := func(s string) time.Time {
		v, err := time.Parse("2006-01-02 15:04", s)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	cases := []struct{ now, start, end string }{
		{"2026-03-31 10:00", "2026-02-01 00:00", "2026-03-01 00:00"}, // all of February, not into March
		{"2026-03-15 12:30", "2026-02-01 00:00", "2026-02-15 12:30"},
		{"2026-01-31 23:00", "2025-12-01 00:00", "2025-12-31 23:00"},
		{"2026-05-31 08:00", "2026-04-01 00:00", "2026-05-01 00:00"},
	}
	for _, c := range cases {
		start, end, som := prevMonthWindow(at(c.now))
		if !start.Equal(at(c.start)) || !end.Equal(at(c.end)) {
			t.Errorf("%s: window %s..%s, want %s..%s", c.now, start, end, c.start, c.end)
		}
		if end.After(som) {
			t.Errorf("%s: window ends after the start of the month", c.now)
		}
	}
}

func TestSampleElapsed(t *testing.T) {
	now := time.Now()
	if d, due := sampleElapsed(now, time.Time{}); !due || d != time.Minute {
		t.Fatalf("first sample: %v %v, want a minute", d, due)
	}
	if _, due := sampleElapsed(now, now.Add(-30*time.Second)); due {
		t.Fatal("a sample 30s after the last should not be due")
	}
	// A slow or failed cycle: the next sample covers the whole gap.
	if d, due := sampleElapsed(now, now.Add(-75*time.Second)); !due || d != 75*time.Second {
		t.Fatalf("after 75s: %v %v", d, due)
	}
	if d, _ := sampleElapsed(now, now.Add(-3*time.Hour)); d != maxSampleGap {
		t.Fatalf("after 3h: %v, want the cap %v", d, maxSampleGap)
	}
}
