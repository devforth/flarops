package main

import (
	"bytes"
	"encoding/json"
	"errors"
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

// The feed is read one instance type at a time, so memory is bounded by the per-entry limit, not the
// total; the total only bounds the download.
const (
	maxPriceFeedBytes     = 1 << 30
	maxPriceEntryBytes    = 16 << 20
	maxPriceEntries       = 20000
	maxPriceRegions       = 256
	maxInstanceTypeLength = 64
	maxRegionLength       = 32
)

var priceFeedURL = "https://instances.vantage.sh/instances.json"

type VantageInstance struct {
	InstanceType string       `json:"instance_type"`
	Pricing      regionPrices `json:"pricing"`
}

// Region -> on-demand Linux price; regions without a parsable one are left out.
type regionPrices map[string]float64

func (rp *regionPrices) UnmarshalJSON(b []byte) error {
	out := regionPrices{}
	*rp = out
	if string(b) == "null" {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return errors.New("pricing is not an object")
	}
	seen := 0
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return err
		}
		region, _ := t.(string)
		if seen++; seen > maxPriceRegions {
			return fmt.Errorf("more than %d regions", maxPriceRegions)
		}
		if len(region) > maxRegionLength {
			return fmt.Errorf("region name of %d bytes", len(region))
		}
		var osTypes struct {
			Linux struct {
				OnDemand string `json:"ondemand"`
			} `json:"linux"`
		}
		if err := dec.Decode(&osTypes); err != nil {
			return err
		}
		if price, err := strconv.ParseFloat(osTypes.Linux.OnDemand, 64); err == nil {
			out[region] = price
		}
	}
	return nil
}

var errPriceEntryTooLarge = fmt.Errorf("an entry over %d bytes", maxPriceEntryBytes)

// Lets the decoder hold at most `limit` bytes past what it has consumed: one huge entry fails instead
// of being buffered whole.
type entryBudgetReader struct {
	r     io.Reader
	read  int64
	limit int64
}

func (b *entryBudgetReader) Read(p []byte) (int, error) {
	if b.read >= b.limit {
		return 0, errPriceEntryTooLarge
	}
	if room := b.limit - b.read; int64(len(p)) > room {
		p = p[:room]
	}
	n, err := b.r.Read(p)
	b.read += int64(n)
	return n, err
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

	newPrices, err := decodePriceFeed(resp.Body)
	if err != nil {
		return err
	}

	awsPricesMutex.Lock()
	awsPrices = newPrices
	awsPricesMutex.Unlock()
	log.Printf("Updated AWS EC2 prices from vantage.sh (%d instance types)", len(newPrices))
	return nil
}

func decodePriceFeed(body io.Reader) (map[string]map[string]float64, error) {
	budget := &entryBudgetReader{r: io.LimitReader(body, maxPriceFeedBytes), limit: maxPriceEntryBytes}
	dec := json.NewDecoder(budget)
	if _, err := dec.Token(); err != nil {
		return nil, fmt.Errorf("reading AWS price feed: %w", err)
	}

	newPrices := make(map[string]map[string]float64)
	entries := 0
	for dec.More() {
		if entries++; entries > maxPriceEntries {
			return nil, fmt.Errorf("AWS price feed lists more than %d instance types", maxPriceEntries)
		}
		budget.limit = dec.InputOffset() + maxPriceEntryBytes
		var inst VantageInstance
		if err := dec.Decode(&inst); err != nil {
			return nil, fmt.Errorf("decoding AWS price feed after %d instance types: %w", len(newPrices), err)
		}
		if len(inst.InstanceType) > maxInstanceTypeLength {
			return nil, fmt.Errorf("AWS price feed has an instance type name of %d bytes", len(inst.InstanceType))
		}
		newPrices[inst.InstanceType] = inst.Pricing
	}
	budget.limit = dec.InputOffset() + maxPriceEntryBytes
	if _, err := dec.Token(); err != nil {
		return nil, fmt.Errorf("reading AWS price feed end: %w", err)
	}
	if len(newPrices) == 0 {
		return nil, fmt.Errorf("AWS price feed contained no instance types")
	}
	return newPrices, nil
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
