package main

import (
	"database/sql"
	"log"
	"time"

	_ "modernc.org/sqlite"
)

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

func recordHostSample(timestamp time.Time, hostID string, ratePerHour float64) error {
	_, err := db.Exec("INSERT INTO host_samples (timestamp, host_id, rate_per_hour) VALUES (?, ?, ?)", timestamp, hostID, ratePerHour)
	return err
}

func recordCapsuleSample(timestamp time.Time, capsuleID string, hostID string, ramMib int) error {
	_, err := db.Exec("INSERT INTO capsule_samples (timestamp, capsule_id, host_id, ram_mib) VALUES (?, ?, ?, ?)", timestamp, capsuleID, hostID, ramMib)
	return err
}

func getSpendStats(totalHourlyRate float64, currentHosts int) (SpendState, error) {
	now := time.Now()
	startOfMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	startOfPrevMonth := startOfMonth.AddDate(0, -1, 0)
	prevMonthSamePeriodEnd := now.AddDate(0, -1, 0)

	var mtd float64
	err := db.QueryRow(`
		SELECT COALESCE(SUM(rate_per_hour / 60.0), 0) 
		FROM host_samples 
		WHERE timestamp >= ?
	`, startOfMonth).Scan(&mtd)
	if err != nil {
		log.Println("Error calculating MTD:", err)
	}

	var prevSame float64
	err = db.QueryRow(`
		SELECT COALESCE(SUM(rate_per_hour / 60.0), 0) 
		FROM host_samples 
		WHERE timestamp >= ? AND timestamp <= ?
	`, startOfPrevMonth, prevMonthSamePeriodEnd).Scan(&prevSame)
	if err != nil {
		log.Println("Error calculating prevSame:", err)
	}

	runRate := totalHourlyRate * 24.0

	daysInMonth := time.Date(now.Year(), now.Month()+1, 0, 0, 0, 0, 0, now.Location()).Day()
	projected := mtd + runRate * float64(daysInMonth - now.Day())

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
	`, startOfMonth)
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
		
		cumulative := 0.0
		for i := 1; i <= dayOfMonth; i++ {
			cumulative += dailyCosts[i]
			curVals[i-1] = cumulative
		}
	} else {
		log.Println("Error querying daily sums:", err)
	}

	rowsPrev, err := db.Query(`
		SELECT CAST(strftime('%d', timestamp) AS INTEGER) AS day, SUM(rate_per_hour / 60.0) 
		FROM host_samples 
		WHERE timestamp >= ? AND timestamp < ?
		GROUP BY day
	`, startOfPrevMonth, startOfMonth)
	
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
		cumulativePrev := 0.0
		// Need to find days in previous month
		daysInPrevMonth := time.Date(now.Year(), now.Month(), 0, 0, 0, 0, 0, now.Location()).Day()
		// Fill prevVals up to dayOfMonth (or daysInPrevMonth if less)
		for i := 1; i <= dayOfMonth; i++ {
			if i <= daysInPrevMonth {
				cumulativePrev += dailyCostsPrev[i]
			}
			prevVals[i-1] = cumulativePrev
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
		PrevLabel:  now.AddDate(0, -1, 0).Month().String(),
		Days:       curDays,
		Cur:        curVals,
		Prev:       prevVals,
		DeltaPct:   deltaPct,
	}, nil
}

func getCapsulesCostLife(hourlyRate float64) map[string]float64 {
	res := make(map[string]float64)
	rows, err := db.Query(`SELECT capsule_id, COUNT(*) FROM capsule_samples GROUP BY capsule_id`)
	if err != nil {
		return res
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var count int
		if err := rows.Scan(&id, &count); err == nil {
			// rough approximation: if multiple capsules share host, they should split cost.
			// For simplicity, we just assign hourlyRate * hours.
			res[id] = float64(count) * (hourlyRate / 60.0)
		}
	}
	return res
}
