package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// The feed is large - over 300 MB at the time of writing - and is decoded as
// it streams, so memory stays flat, but the download itself takes time. The
// old 30-second limit covered the WHOLE body and routinely cut it off midway.
var pricingHTTPClient = &http.Client{Timeout: 10 * time.Minute}

// Far above the real size, so growth does not break it, but bounded: a
// misbehaving endpoint cannot keep this pod reading forever.
const maxPriceFeedBytes = 2 << 30

var priceFeedURL = "https://instances.vantage.sh/instances.json"

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

// Replaces the price table only with a COMPLETE feed. A decode error halfway
// through used to swap in whatever had been read so far, so every instance
// type after the break silently fell back to the default rate.
func fetchAWSPrices() error {
	resp, err := pricingHTTPClient.Get(priceFeedURL)
	if err != nil {
		return fmt.Errorf("fetching AWS prices: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("fetching AWS prices: HTTP %d", resp.StatusCode)
	}

	dec := json.NewDecoder(io.LimitReader(resp.Body, maxPriceFeedBytes))
	if _, err := dec.Token(); err != nil {
		return fmt.Errorf("reading AWS price feed: %w", err)
	}

	newPrices := make(map[string]map[string]float64)
	for dec.More() {
		var inst VantageInstance
		if err := dec.Decode(&inst); err != nil {
			return fmt.Errorf("decoding AWS price feed after %d instance types: %w", len(newPrices), err)
		}
		regionMap := make(map[string]float64)
		for region, osTypes := range inst.Pricing {
			if price, err := strconv.ParseFloat(osTypes.Linux.OnDemand, 64); err == nil {
				regionMap[region] = price
			}
		}
		newPrices[inst.InstanceType] = regionMap
	}
	if _, err := dec.Token(); err != nil {
		return fmt.Errorf("reading AWS price feed end: %w", err)
	}
	if len(newPrices) == 0 {
		return fmt.Errorf("AWS price feed contained no instance types")
	}

	awsPricesMutex.Lock()
	awsPrices = newPrices
	awsPricesMutex.Unlock()
	log.Printf("Updated AWS EC2 prices from vantage.sh (%d instance types)", len(newPrices))
	return nil
}

// How long to wait before trying again after a failed fetch, by attempt. A
// single failure at startup used to mean the next try a month later, with
// every cost on the dashboard at the default rate for the whole month.
var priceRetryDelays = []time.Duration{5 * time.Minute, 15 * time.Minute, time.Hour, 6 * time.Hour}

func startPriceFetcher() {
	go func() {
		failures := 0
		for {
			if err := fetchAWSPrices(); err != nil {
				delay := priceRetryDelays[len(priceRetryDelays)-1]
				if failures < len(priceRetryDelays) {
					delay = priceRetryDelays[failures]
				}
				failures++
				log.Printf("%v - retrying in %s", err, delay)
				time.Sleep(delay)
				continue
			}
			failures = 0
			time.Sleep(30 * 24 * time.Hour) // prices move slowly; once a month is enough
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
