package main

import (
	"database/sql"
	"log"
	"time"

	_ "modernc.org/sqlite"
)

// About a year of samples.
const sampleRetention = 400 * 24 * time.Hour

func startSampleRetention() {
	pruneOldSamples()
	ticker := time.NewTicker(24 * time.Hour)
	go func() {
		for range ticker.C {
			pruneOldSamples()
		}
	}()
}

func pruneOldSamples() {
	cutoff := time.Now().Add(-sampleRetention)
	if res, err := db.Exec("DELETE FROM host_samples WHERE timestamp < ?", sqlTime(cutoff)); err != nil {
		log.Println("Error pruning host_samples:", err)
	} else if n, _ := res.RowsAffected(); n > 0 {
		log.Printf("Pruned %d old host_samples rows", n)
	}
	if res, err := db.Exec("DELETE FROM capsule_samples WHERE timestamp < ?", sqlTime(cutoff)); err != nil {
		log.Println("Error pruning capsule_samples:", err)
	} else if n, _ := res.RowsAffected(); n > 0 {
		log.Printf("Pruned %d old capsule_samples rows", n)
	}
}

var db *sql.DB

func initDB(dataSourceName string) error {
	var err error
	db, err = sql.Open("sqlite", dataSourceName)
	if err != nil {
		return err
	}

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS host_samples (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			timestamp DATETIME,
			host_id TEXT,
			rate_per_hour REAL
		);
		CREATE TABLE IF NOT EXISTS capsule_samples (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			timestamp DATETIME,
			capsule_id TEXT,
			host_id TEXT,
			ram_mib INTEGER
		);
		CREATE INDEX IF NOT EXISTS idx_host_samples_timestamp ON host_samples(timestamp);
		CREATE INDEX IF NOT EXISTS idx_capsule_samples_timestamp ON capsule_samples(timestamp);
		CREATE INDEX IF NOT EXISTS idx_capsule_samples_capsule_id ON capsule_samples(capsule_id);
	`)
	return err
}

// Timestamps are stored as UTC text SQLite's date functions read: a bound time.Time is written as Go's
// String(), with a zone name and a monotonic-clock suffix, on which strftime returns NULL.
func sqlTime(t time.Time) string {
	return t.UTC().Format("2006-01-02 15:04:05.000")
}

func recordHostSample(timestamp time.Time, hostID string, ratePerHour float64) error {
	_, err := db.Exec("INSERT INTO host_samples (timestamp, host_id, rate_per_hour) VALUES (?, ?, ?)", sqlTime(timestamp), hostID, ratePerHour)
	return err
}

func recordCapsuleSample(timestamp time.Time, capsuleID string, hostID string, ramMib int) error {
	_, err := db.Exec("INSERT INTO capsule_samples (timestamp, capsule_id, host_id, ram_mib) VALUES (?, ?, ?, ?)", sqlTime(timestamp), capsuleID, hostID, ramMib)
	return err
}

func getSpendStats(totalHourlyRate float64, currentHosts int) (SpendState, error) {
	// Days and months in UTC, the zone the stored timestamps are in.
	now := time.Now().UTC()
	startOfMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	startOfPrevMonth := startOfMonth.AddDate(0, -1, 0)
	prevMonthSamePeriodEnd := now.AddDate(0, -1, 0)

	var mtd float64
	err := db.QueryRow(`
		SELECT COALESCE(SUM(rate_per_hour / 60.0), 0) 
		FROM host_samples 
		WHERE timestamp >= ?
	`, sqlTime(startOfMonth)).Scan(&mtd)
	if err != nil {
		log.Println("Error calculating MTD:", err)
	}

	var prevSame float64
	err = db.QueryRow(`
		SELECT COALESCE(SUM(rate_per_hour / 60.0), 0) 
		FROM host_samples 
		WHERE timestamp >= ? AND timestamp <= ?
	`, sqlTime(startOfPrevMonth), sqlTime(prevMonthSamePeriodEnd)).Scan(&prevSame)
	if err != nil {
		log.Println("Error calculating prevSame:", err)
	}

	runRate := totalHourlyRate * 24.0

	// The rest of the month from now, today's remaining hours included.
	endOfMonth := time.Date(now.Year(), now.Month()+1, 1, 0, 0, 0, 0, now.Location())
	projected := mtd + totalHourlyRate*endOfMonth.Sub(now).Hours()

	dayOfMonth := now.Day()
	curDays := make([]int, dayOfMonth)
	curVals := make([]float64, dayOfMonth)
	prevVals := make([]float64, dayOfMonth)

	for i := 1; i <= dayOfMonth; i++ {
		curDays[i-1] = i
	}

	rows, err := db.Query(`
		SELECT CAST(strftime('%d', timestamp) AS INTEGER) AS day, SUM(rate_per_hour / 60.0) 
		FROM host_samples 
		WHERE timestamp >= ? 
		GROUP BY day
	`, sqlTime(startOfMonth))
	if err == nil {
		defer rows.Close()
		dailyCosts := make(map[int]float64)
		for rows.Next() {
			var d int
			var cost float64
			if err := rows.Scan(&d, &cost); err == nil {
				dailyCosts[d] = cost
			}
		}

		// Each day's own spend: the bars are days, and their mean is the average per day.
		for i := 1; i <= dayOfMonth; i++ {
			curVals[i-1] = dailyCosts[i]
		}
	} else {
		log.Println("Error querying daily sums:", err)
	}

	rowsPrev, err := db.Query(`
		SELECT CAST(strftime('%d', timestamp) AS INTEGER) AS day, SUM(rate_per_hour / 60.0) 
		FROM host_samples 
		WHERE timestamp >= ? AND timestamp < ?
		GROUP BY day
	`, sqlTime(startOfPrevMonth), sqlTime(startOfMonth))

	if err == nil {
		defer rowsPrev.Close()
		dailyCostsPrev := make(map[int]float64)
		for rowsPrev.Next() {
			var d int
			var cost float64
			if err := rowsPrev.Scan(&d, &cost); err == nil {
				dailyCostsPrev[d] = cost
			}
		}
		daysInPrevMonth := time.Date(now.Year(), now.Month(), 0, 0, 0, 0, 0, now.Location()).Day()
		for i := 1; i <= dayOfMonth; i++ {
			if i <= daysInPrevMonth {
				prevVals[i-1] = dailyCostsPrev[i]
			}
		}
	} else {
		log.Println("Error querying previous month daily sums:", err)
	}

	deltaPct := 0.0
	if prevSame > 0 {
		deltaPct = ((mtd - prevSame) / prevSame) * 100
	}

	return SpendState{
		Mtd:        mtd,
		PrevSame:   prevSame,
		RunRate:    runRate,
		Projected:  projected,
		MonthLabel: now.Month().String(),
		// From the 1st: AddDate normalises an overflowing day (31 Oct - 1 month = 1 Oct).
		PrevLabel: time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location()).AddDate(0, -1, 0).Month().String(),
		Days:      curDays,
		Cur:       curVals,
		Prev:      prevVals,
		DeltaPct:  deltaPct,
	}, nil
}

// Each environment's share of its node's rate, per one-minute sample, since `since[id]`: the node's
// rate split across the environments on it at that minute.
func getCapsulesCostLife(since map[string]time.Time) map[string]float64 {
	res := make(map[string]float64)
	for id, from := range since {
		var cost float64
		err := db.QueryRow(`
			SELECT COALESCE(SUM(h.rate_per_hour / 60.0 / n.cnt), 0)
			FROM capsule_samples c
			JOIN host_samples h ON h.host_id = c.host_id AND h.timestamp = c.timestamp
			JOIN (SELECT timestamp, host_id, COUNT(*) AS cnt FROM capsule_samples GROUP BY timestamp, host_id) n
			  ON n.timestamp = c.timestamp AND n.host_id = c.host_id
			WHERE c.capsule_id = ? AND c.timestamp >= ?
		`, id, sqlTime(from)).Scan(&cost)
		if err == nil {
			res[id] = cost
		}
	}
	return res
}
