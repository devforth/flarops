package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"
)

type VantageInstance struct {
	InstanceType string `json:"instance_type"`
	Pricing      map[string]struct {
		Linux struct {
			OnDemand string `json:"ondemand"`
		} `json:"linux"`
	} `json:"pricing"`
}

var (
	awsPrices      = make(map[string]map[string]float64) // instance_type -> region -> price
	awsPricesMutex sync.RWMutex
)

func fetchAWSPrices() {
	resp, err := http.Get("https://instances.vantage.sh/instances.json")
	if err != nil {
		log.Println("Error fetching AWS prices:", err)
		return
	}
	defer resp.Body.Close()

	dec := json.NewDecoder(resp.Body)

	// Read the opening bracket '['
	if _, err := dec.Token(); err != nil {
		log.Println("Error reading JSON array start:", err)
		return
	}

	newPrices := make(map[string]map[string]float64)
	for dec.More() {
		var inst VantageInstance
		if err := dec.Decode(&inst); err != nil {
			log.Println("Error decoding instance:", err)
			break
		}

		regionMap := make(map[string]float64)
		for region, osTypes := range inst.Pricing {
			if price, err := strconv.ParseFloat(osTypes.Linux.OnDemand, 64); err == nil {
				regionMap[region] = price
			}
		}
		newPrices[inst.InstanceType] = regionMap
	}

	// Read the closing bracket ']'
	if _, err := dec.Token(); err != nil {
		log.Println("Error reading JSON array end:", err)
	}

	awsPricesMutex.Lock()
	awsPrices = newPrices
	awsPricesMutex.Unlock()
	log.Println("Successfully updated AWS EC2 prices from vantage.sh")
}

func startPriceFetcher() {
	fetchAWSPrices()
	ticker := time.NewTicker(30 * 24 * time.Hour) // Update once a month
	go func() {
		for range ticker.C {
			fetchAWSPrices()
		}
	}()
}

func getEC2HourlyRate(instanceType, region string) float64 {
	awsPricesMutex.RLock()
	defer awsPricesMutex.RUnlock()
	
	if regionMap, ok := awsPrices[instanceType]; ok {
		if price, ok := regionMap[region]; ok {
			return price
		}
	}
	return 0.0432 // default fallback
}
