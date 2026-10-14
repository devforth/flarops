package main

import (
	"errors"
	"strconv"
	"strings"
	"testing"
)

func TestDecodePriceFeed(t *testing.T) {
	prices, err := decodePriceFeed(strings.NewReader(`[
		{"instance_type": "t3a.medium", "pricing": {"us-west-2": {"linux": {"ondemand": "0.0376"}, "mswin": {"ondemand": "0.06"}}, "eu-west-1": {"linux": {}}}},
		{"instance_type": "m5.large", "pricing": {}}
	]`))
	if err != nil {
		t.Fatal(err)
	}
	if prices["t3a.medium"]["us-west-2"] != 0.0376 || len(prices["t3a.medium"]) != 1 || len(prices) != 2 {
		t.Fatalf("got %v", prices)
	}
}

// A broken or hostile feed is refused before it can take the dashboard's memory.
func TestDecodePriceFeedRejectsOversizedInput(t *testing.T) {
	huge := `[{"instance_type": "` + strings.Repeat("x", maxPriceEntryBytes+1) + `", "pricing": {}}]`
	if _, err := decodePriceFeed(strings.NewReader(huge)); !errors.Is(err, errPriceEntryTooLarge) {
		t.Errorf("an entry over the limit: err %v, want errPriceEntryTooLarge", err)
	}

	long := `[{"instance_type": "` + strings.Repeat("x", maxInstanceTypeLength+1) + `", "pricing": {}}]`
	if _, err := decodePriceFeed(strings.NewReader(long)); err == nil {
		t.Error("an over-long instance type was accepted")
	}

	longRegion := `[{"instance_type": "t3.micro", "pricing": {"` + strings.Repeat("r", maxRegionLength+1) + `": {"linux": {"ondemand": "1"}}}}]`
	if _, err := decodePriceFeed(strings.NewReader(longRegion)); err == nil {
		t.Error("an over-long region was accepted")
	}

	var regions strings.Builder
	for i := 0; i <= maxPriceRegions; i++ {
		if i > 0 {
			regions.WriteString(",")
		}
		regions.WriteString(`"r` + strconv.Itoa(i) + `": {}`)
	}
	if _, err := decodePriceFeed(strings.NewReader(`[{"instance_type": "t3.micro", "pricing": {` + regions.String() + `}}]`)); err == nil {
		t.Error("an entry with too many regions was accepted")
	}

	var many strings.Builder
	many.WriteString("[")
	for i := 0; i <= maxPriceEntries; i++ {
		if i > 0 {
			many.WriteString(",")
		}
		many.WriteString(`{"instance_type": "t` + strconv.Itoa(i) + `"}`)
	}
	many.WriteString("]")
	if _, err := decodePriceFeed(strings.NewReader(many.String())); err == nil {
		t.Error("a feed with too many entries was accepted")
	}
}
