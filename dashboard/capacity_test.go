package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func resetReservations() {
	reservationsMu.Lock()
	reservations = map[string]*reservation{}
	reservationsMu.Unlock()
}

// One node with room for one environment: concurrent requests get exactly one "yes".
func TestOracleSaysYesOnce(t *testing.T) {
	resetReservations()
	defer resetReservations()
	publishSnapshot(DashboardData{Hosts: []HostState{{
		ID: "srv", Schedulable: true, MetricsKnown: true,
		RamTotal: 4096, RamAllocatable: 4096, RamUsed: 2048, Capsules: []CapsuleState{},
	}}})

	const n = 100
	var wg sync.WaitGroup
	var mu sync.Mutex
	yes := 0
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rec := httptest.NewRecorder()
			handleCapacity(rec, httptest.NewRequest(http.MethodGet, "/capacity?mib=1200&for=pr-"+strconv.Itoa(i), nil))
			if strings.HasPrefix(rec.Body.String(), "yes\n") {
				mu.Lock()
				yes++
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()
	if yes != 1 {
		t.Fatalf("%d requests were told yes, want 1", yes)
	}
}

// A promise shrinks by what its environment is measured using on that node, and goes once covered.
func TestReservationSettlesWhenTheEnvironmentAppears(t *testing.T) {
	resetReservations()
	defer resetReservations()
	reserve("pr-5", "w1", 1000)
	reserve("pr-15", "w1", 300)

	hosts := map[string]*HostState{"w1": {ID: "w1", Capsules: []CapsuleState{{ID: "shop-pr-5", Ram: 0}}}}
	settleReservations(hosts)
	if got := reservedOn("w1", ""); got != 1300 {
		t.Fatalf("unmeasured pods settled something: %d reserved, want 1300", got)
	}

	hosts["w1"].Capsules[0].Ram = 400
	settleReservations(hosts)
	settleReservations(hosts) // repeated cycles do not subtract again
	if got := reservedOn("w1", ""); got != 600+300 {
		t.Fatalf("%d reserved, want 900 (pr-5's remaining 600, pr-15 untouched)", got)
	}

	hosts["w1"].Capsules[0].Ram = 1100
	settleReservations(hosts)
	if got := reservedOn("w1", ""); got != 300 {
		t.Fatalf("%d reserved, want only pr-15's 300", got)
	}

	// On another node it is not the promise being kept.
	reserve("pr-7", "w1", 500)
	settleReservations(map[string]*HostState{"w1": {ID: "w1"}, "w2": {ID: "w2", Capsules: []CapsuleState{{ID: "shop-pr-7", Ram: 900}}}})
	if got := reservedOn("w1", ""); got != 800 {
		t.Fatalf("%d reserved on w1, want 800", got)
	}
}

func TestReservationIsFor(t *testing.T) {
	for _, c := range []struct {
		key, ns string
		want    bool
	}{
		{"pr-5", "shop-pr-5", true},
		{"pr-5", "shop-pr-15", false},
		{"pr-5", "shop-pr-55", false},
		{"pr-5", "shop-production", false},
		{"anon:w1", "shop-pr-5", false},
		{"", "shop", false},
	} {
		if got := reservationIsFor(c.key, c.ns); got != c.want {
			t.Errorf("reservationIsFor(%q, %q) = %v, want %v", c.key, c.ns, got, c.want)
		}
	}
}
