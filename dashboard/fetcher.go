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

// Over 300 MB, decoded while streaming; the timeout covers the whole download.
var pricingHTTPClient = &http.Client{Timeout: 10 * time.Minute}

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

// Only a complete feed replaces the table.
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

// Retry delays after a failed fetch.
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
			if n, err := repriceSamples(); err != nil {
				log.Println("could not correct samples counted at the fallback price:", err)
			} else if n > 0 {
				log.Printf("corrected %d samples counted at the fallback EC2 price", n)
			}
			time.Sleep(30 * 24 * time.Hour) // prices move slowly; once a month is enough
		}
	}()
}

// The fallback until the price feed loads, or for a type or region it does not list: a t3.medium's.
const fallbackEC2HourlyRate = 0.0432

// The on-demand Linux price, and whether it came from the feed rather than the fallback.
func getEC2HourlyRate(instanceType, region string) (float64, bool) {
	awsPricesMutex.RLock()
	defer awsPricesMutex.RUnlock()

	if regionMap, ok := awsPrices[instanceType]; ok {
		if price, ok := regionMap[region]; ok {
			return price, true
		}
	}
	return fallbackEC2HourlyRate, false
}

// gp3 storage, USD per GB-month, by region (AWS's published on-demand prices).
var gp3PerGBMonth = map[string]float64{
	"us-east-1": 0.08, "us-east-2": 0.08, "us-west-2": 0.08, "us-west-1": 0.096,
	"ca-central-1": 0.088, "eu-west-1": 0.088, "eu-west-2": 0.0928, "eu-west-3": 0.0928,
	"eu-central-1": 0.0952, "eu-north-1": 0.0836, "ap-south-1": 0.0912, "ap-southeast-1": 0.096,
	"ap-southeast-2": 0.096, "ap-northeast-1": 0.096, "ap-northeast-2": 0.0912, "sa-east-1": 0.152,
}

// The gp3 price for a region, and whether the table has it (otherwise us-east-1's).
func getGP3Rate(region string) (float64, bool) {
	if p, ok := gp3PerGBMonth[region]; ok {
		return p, true
	}
	return 0.08, false
}

// Every node has a public IPv4 address - the server's Elastic IP, a worker's launch address - and
// AWS bills each one by the hour.
const publicIPv4HourlyRate = 0.005
